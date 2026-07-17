import type { Prisma } from '@oat/db'
import { type AssetClass, type PrismaClient } from '@oat/db'
import { project, type AssetProjection } from './idle-engine'
import { resolveIdlePolicy, resolveScanTtlMinutes, type EnginePolicy, type IdleConfigOverride } from './idle-policy'
import type { SignalInput } from './signals'

/**
 * The registry service: the only place asset state is written from signals.
 *
 * Connectors call `ingestSignals`. They never touch Asset directly (ADR-0006) — the engine
 * decides what a signal means, so that conflicting connectors resolve in one auditable
 * function rather than racing each other.
 */

/**
 * How far back the engine reads when re-projecting an asset.
 *
 * The projection is incremental — prior state is carried on the Asset row — so this window
 * only needs to cover signals that could still change the answer, not all history. A full
 * rebuild from the log is a separate operation (Phase 2).
 */
const REPROJECTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export interface IngestResult {
  /** Signals written. Lower than the input count when duplicates were suppressed. */
  accepted: number
  /** Signals dropped as redeliveries of an observation already recorded. */
  duplicates: number
  /** Assets whose projection was recomputed. */
  assetsUpdated: string[]
}

/**
 * Persist signals and re-project every asset they touch.
 *
 * At-least-once delivery is normal for connectors (a webhook retries, a poll overlaps), so
 * writes are deduplicated on (source, dedupeKey) rather than assuming exactly-once.
 */
export async function ingestSignals(
  prisma: PrismaClient,
  signals: readonly SignalInput[],
  options: { now?: Date } = {},
): Promise<IngestResult> {
  if (signals.length === 0) return { accepted: 0, duplicates: 0, assetsUpdated: [] }

  const now = options.now ?? new Date()

  const written = await prisma.signalEvent.createMany({
    data: signals.map((s) => ({
      assetId: s.assetId,
      source: s.source,
      type: s.type,
      value: s.value as Prisma.InputJsonValue,
      observedAt: s.observedAt,
      dedupeKey: s.dedupeKey ?? null,
    })),
    // Redelivery is expected, not exceptional: skip the duplicate rather than failing the
    // whole batch and forcing the connector to retry signals we already hold.
    skipDuplicates: true,
  })

  const assetIds = [...new Set(signals.map((s) => s.assetId))]
  // Load the config once for the whole batch rather than per asset: it is a small table and
  // re-reading it per asset would dominate a poll covering hundreds of devices.
  const overrides = await loadIdleConfig(prisma)
  for (const assetId of assetIds) {
    await reprojectAsset(prisma, assetId, { now, overrides })
  }

  return {
    accepted: written.count,
    duplicates: signals.length - written.count,
    assetsUpdated: assetIds,
  }
}

/**
 * Recompute one asset's projection from its recent signal log and write it back.
 *
 * Reads the log rather than trusting the caller's batch: that makes the result identical
 * whether it runs after an ingest, on the periodic sweep, or on a manual replay.
 */
export async function reprojectAsset(
  prisma: PrismaClient,
  assetId: string,
  options: { now?: Date; overrides?: readonly IdleConfigOverride[] } = {},
): Promise<AssetProjection | null> {
  const now = options.now ?? new Date()
  const overrides = options.overrides ?? (await loadIdleConfig(prisma))

  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true,
      class: true,
      subType: true,
      status: true,
      idleSince: true,
      lastSeenAt: true,
      lastActiveAt: true,
      scanAssertedStatus: true,
      scanAssertedAt: true,
      site: { select: { scanTtlMinutes: true } },
    },
  })
  if (!asset) return null

  // Resolve the policy for THIS asset: asset -> sub-type -> class -> default (ADR-0014),
  // plus its site's scan TTL (ADR-0013). The engine takes resolved values; it has no
  // business knowing what a Site or an IdleConfig is.
  const policy: EnginePolicy = {
    idle: resolveIdlePolicy(asset, overrides),
    scanTtlMinutes: resolveScanTtlMinutes(asset.site),
  }

  const signals = await prisma.signalEvent.findMany({
    where: { assetId, observedAt: { gte: new Date(now.getTime() - REPROJECTION_WINDOW_MS) } },
    orderBy: { observedAt: 'asc' },
    select: { assetId: true, source: true, type: true, value: true, observedAt: true },
  })

  const { projection, conflict } = project({
    policy,
    current: {
      status: asset.status,
      idleSince: asset.idleSince,
      lastSeenAt: asset.lastSeenAt,
      lastActiveAt: asset.lastActiveAt,
      scanAssertedStatus: asset.scanAssertedStatus,
      scanAssertedAt: asset.scanAssertedAt,
    },
    signals: signals as unknown as SignalInput[],
    now,
  })

  await prisma.asset.update({
    where: { id: assetId },
    data: {
      status: projection.status,
      idleSince: projection.idleSince,
      lastSeenAt: projection.lastSeenAt,
      lastActiveAt: projection.lastActiveAt,
      scanAssertedStatus: projection.scanAssertedStatus,
      scanAssertedAt: projection.scanAssertedAt,
    },
  })

  await recordConflict(prisma, assetId, conflict)
  await recordIdleAlert(prisma, assetId, projection, policy, now)

  return projection
}

/**
 * Load the idle-config overrides.
 *
 * A small table read once per sweep or ingest batch, not per asset (ADR-0014).
 */
export async function loadIdleConfig(prisma: PrismaClient): Promise<IdleConfigOverride[]> {
  const rows = await prisma.idleConfig.findMany({
    select: { scope: true, key: true, thresholdMinutes: true, alertAfterMinutes: true },
  })
  return rows
}

/**
 * Raise or clear the asset's idle alert (ADR-0015 threshold alerts).
 *
 * One OPEN alert per asset: the sweep re-evaluates constantly, so inserting per detection
 * would produce an alert every run for the same underlying fact and train everyone to ignore
 * them. An ACKNOWLEDGED alert is left alone — a human has seen it and does not need it
 * re-raised — but it still resolves when the asset comes back to life.
 */
async function recordIdleAlert(
  prisma: PrismaClient,
  assetId: string,
  projection: AssetProjection,
  policy: EnginePolicy,
  now: Date,
): Promise<void> {
  const idleMinutes =
    projection.status === 'IDLE' && projection.idleSince
      ? Math.floor((now.getTime() - projection.idleSince.getTime()) / 60_000)
      : 0

  const shouldAlert = idleMinutes >= policy.idle.alertAfterMinutes
  const existing = await prisma.idleAlert.findFirst({
    where: { assetId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
  })

  if (!shouldAlert) {
    if (existing) {
      await prisma.idleAlert.update({
        where: { id: existing.id },
        data: { status: 'RESOLVED', resolvedAt: now },
      })
    }
    return
  }

  if (existing) {
    // Refresh the duration so age stays accurate, but do not re-open an acknowledged alert.
    await prisma.idleAlert.update({ where: { id: existing.id }, data: { idleMinutes } })
    return
  }

  await prisma.idleAlert.create({
    data: {
      assetId,
      idleSince: projection.idleSince!,
      idleMinutes,
      // Recorded so the alert stays explicable after someone changes the config.
      thresholdMinutes: policy.idle.alertAfterMinutes,
    },
  })
}

/**
 * Record a sustained scan-vs-telemetry disagreement, or close one that has resolved.
 *
 * One OPEN alert per asset at a time: the engine re-evaluates on every projection, so
 * inserting per detection would produce an alert every poll for the same underlying problem
 * and train everyone to ignore them.
 */
async function recordConflict(
  prisma: PrismaClient,
  assetId: string,
  conflict: Awaited<ReturnType<typeof project>>['conflict'],
): Promise<void> {
  const open = await prisma.conflictAlert.findFirst({ where: { assetId, status: 'OPEN' } })

  if (!conflict) {
    // The disagreement is gone — the scan expired, telemetry came round, or a human acted.
    if (open) {
      await prisma.conflictAlert.update({
        where: { id: open.id },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      })
    }
    return
  }

  if (open) {
    await prisma.conflictAlert.update({
      where: { id: open.id },
      data: { sustainedMinutes: conflict.sustainedMinutes, telemetryStatus: conflict.telemetryStatus },
    })
    return
  }

  await prisma.conflictAlert.create({
    data: {
      assetId,
      scanStatus: conflict.scanStatus,
      telemetryStatus: conflict.telemetryStatus,
      scanAssertedAt: conflict.scanAssertedAt,
      sustainedMinutes: conflict.sustainedMinutes,
    },
  })
}

/**
 * Re-project every asset that could have aged into idleness.
 *
 * This is the sweep that makes idleness a function of the clock rather than of a signal
 * happening to arrive: an asset goes quiet precisely *because* nothing is being reported.
 */
export async function sweepIdleAssets(prisma: PrismaClient, options: { now?: Date } = {}): Promise<{ swept: number }> {
  const now = options.now ?? new Date()
  const overrides = await loadIdleConfig(prisma)

  const candidates = await prisma.asset.findMany({
    // Administrative statuses are held by a human decision; the sweep has no business
    // touching them, and skipping them keeps the scan proportional to live assets.
    //
    // A live scan assertion is also swept even with no lastActiveAt: its TTL can expire
    // purely on the clock, so "no new signals" no longer implies "no status change"
    // (ADR-0010).
    where: {
      status: { in: ['IN_USE', 'IDLE'] },
      OR: [{ lastActiveAt: { not: null } }, { scanAssertedAt: { not: null } }],
    },
    select: { id: true },
  })

  for (const { id } of candidates) {
    await reprojectAsset(prisma, id, { now, overrides })
  }

  return { swept: candidates.length }
}

/** Resolve the OAT asset id for a connector's external reference (tag or SAP asset number). */
export async function resolveAssetByRef(prisma: PrismaClient, externalRef: string): Promise<string | null> {
  const asset = await prisma.asset.findFirst({
    where: { OR: [{ tag: externalRef }, { sapAssetNo: externalRef }] },
    select: { id: true },
  })
  return asset?.id ?? null
}

export interface AssetFilter {
  siteId?: string
  status?: AssetProjection['status']
  assetClass?: AssetClass
  /** Matches tag, name, or SAP asset number. */
  query?: string
}

export async function listAssets(prisma: PrismaClient, filter: AssetFilter = {}) {
  const where: Prisma.AssetWhereInput = {}
  if (filter.siteId) where.siteId = filter.siteId
  if (filter.status) where.status = filter.status
  if (filter.assetClass) where.class = filter.assetClass
  if (filter.query) {
    where.OR = [
      { tag: { contains: filter.query, mode: 'insensitive' } },
      { name: { contains: filter.query, mode: 'insensitive' } },
      { sapAssetNo: { contains: filter.query, mode: 'insensitive' } },
    ]
  }

  return prisma.asset.findMany({
    where,
    include: { site: true },
    orderBy: [{ site: { code: 'asc' } }, { tag: 'asc' }],
  })
}

export async function getAsset(prisma: PrismaClient, id: string) {
  return prisma.asset.findUnique({
    where: { id },
    include: {
      site: true,
      signals: { orderBy: { observedAt: 'desc' }, take: 25 },
      locations: { orderBy: { movedAt: 'desc' }, take: 10 },
    },
  })
}
