import type { Prisma } from '@oat/db'
import { type AssetClass, type PrismaClient } from '@oat/db'
import { project, type AssetProjection } from './idle-engine'
import { resolveIdlePolicy, type IdlePolicy } from './idle-policy'
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
  options: { now?: Date; policy?: IdlePolicy } = {},
): Promise<IngestResult> {
  if (signals.length === 0) return { accepted: 0, duplicates: 0, assetsUpdated: [] }

  const now = options.now ?? new Date()
  const policy = options.policy ?? resolveIdlePolicy()

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
  for (const assetId of assetIds) {
    await reprojectAsset(prisma, assetId, { now, policy })
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
  options: { now?: Date; policy?: IdlePolicy } = {},
): Promise<AssetProjection | null> {
  const now = options.now ?? new Date()
  const policy = options.policy ?? resolveIdlePolicy()

  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { id: true, class: true, status: true, idleSince: true, lastSeenAt: true, lastActiveAt: true },
  })
  if (!asset) return null

  const signals = await prisma.signalEvent.findMany({
    where: { assetId, observedAt: { gte: new Date(now.getTime() - REPROJECTION_WINDOW_MS) } },
    orderBy: { observedAt: 'asc' },
    select: { assetId: true, source: true, type: true, value: true, observedAt: true },
  })

  const next = project({
    assetClass: asset.class,
    current: {
      status: asset.status,
      idleSince: asset.idleSince,
      lastSeenAt: asset.lastSeenAt,
      lastActiveAt: asset.lastActiveAt,
    },
    signals: signals as unknown as SignalInput[],
    now,
    policy,
  })

  await prisma.asset.update({
    where: { id: assetId },
    data: {
      status: next.status,
      idleSince: next.idleSince,
      lastSeenAt: next.lastSeenAt,
      lastActiveAt: next.lastActiveAt,
    },
  })

  return next
}

/**
 * Re-project every asset that could have aged into idleness.
 *
 * This is the sweep that makes idleness a function of the clock rather than of a signal
 * happening to arrive: an asset goes quiet precisely *because* nothing is being reported.
 */
export async function sweepIdleAssets(
  prisma: PrismaClient,
  options: { now?: Date; policy?: IdlePolicy } = {},
): Promise<{ swept: number }> {
  const now = options.now ?? new Date()
  const policy = options.policy ?? resolveIdlePolicy()

  const candidates = await prisma.asset.findMany({
    // Administrative statuses are held by a human decision; the sweep has no business
    // touching them, and skipping them keeps the scan proportional to live assets.
    where: { status: { in: ['IN_USE', 'IDLE'] }, lastActiveAt: { not: null } },
    select: { id: true },
  })

  for (const { id } of candidates) {
    await reprojectAsset(prisma, id, { now, policy })
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
