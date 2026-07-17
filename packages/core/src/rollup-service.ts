import type { PrismaClient } from '@oat/db'
import type { SiteScope } from './dashboard'
import { isRollupEligible, resolveIdlePolicy, type IdleConfigOverride } from './idle-policy'
import { loadIdleConfig } from './registry'
import type { SignalInput, SignalSource } from './signals'
import { localDayBounds, rollUp, DEFAULT_COVERAGE_GAP_MINUTES, type CoverageGaps, type Interval } from './utilisation'

/**
 * Persist utilisation rollups (ADR-0015).
 *
 * Snapshots are a CACHE of a derivation, never a source of truth: always rebuildable from
 * the append-only signal log (ADR-0006), so changing a threshold means re-running this, not
 * migrating data.
 */

export interface RollupOptions {
  /** The local day to roll up. Defaults to yesterday — today is not over yet. */
  day?: Date
  timeZone?: string
  /** Connectors deployed here. Decides which classes can be rolled up at all. */
  enabledSources?: readonly SignalSource[]
  /**
   * How long a silence from each source still counts as coverage (ADR-0018).
   *
   * Supplied by the caller because only the app knows which adapters are deployed and at
   * what cadence — `core` must not import `connectors` (ADR-0002).
   */
  coverageGaps?: CoverageGaps
}

export interface RollupSummary {
  periodStart: Date
  periodEnd: Date
  /** Assets whose class has a deployed activity source. */
  eligible: number
  written: number
  /**
   * Eligible assets with no coverage in the period. No snapshot is written for them: that
   * means "we do not know", which is not 0% and must never be shown as it.
   */
  unobserved: number
  /** Classes skipped because no connector feeding them is deployed. */
  skippedClasses: string[]
}

export const DEFAULT_TIMEZONE = 'Asia/Kuala_Lumpur'

/**
 * Roll up one local day for every eligible asset.
 *
 * Idempotent: upserts on (asset, period), so re-running after a fix or a config change
 * overwrites rather than duplicating.
 */
export async function rollUpDay(prisma: PrismaClient, options: RollupOptions = {}): Promise<RollupSummary> {
  const timeZone = options.timeZone ?? DEFAULT_TIMEZONE
  // Yesterday by default: rolling up a day still in progress would produce a figure that
  // changes every time you look at it.
  const day = options.day ?? new Date(Date.now() - 24 * 60 * 60_000)
  const period = localDayBounds(day, timeZone)

  const enabledSources = options.enabledSources ?? []
  const overrides = await loadIdleConfig(prisma)

  const assets = await prisma.asset.findMany({
    // Retired assets are out of the operational estate; rolling them up would drag every
    // site's figures down as the estate ages and tell the client nothing.
    where: { status: { not: 'RETIRED' } },
    select: { id: true, class: true, subType: true },
  })

  const summary: RollupSummary = {
    periodStart: period.start,
    periodEnd: period.end,
    eligible: 0,
    written: 0,
    unobserved: 0,
    skippedClasses: [],
  }
  const skipped = new Set<string>()

  for (const asset of assets) {
    const policy = resolveIdlePolicy(asset, overrides)

    // Derived, not hardcoded: instruments start rolling up automatically the day the LIS
    // connector is enabled, and turning a connector off stops the rollups rather than
    // silently converting them to zeroes.
    if (!isRollupEligible(policy, enabledSources)) {
      skipped.add(asset.class)
      continue
    }
    summary.eligible++

    const signals = await loadSignals(prisma, asset.id, period, policy.thresholdMinutes, options.coverageGaps)
    const result = rollUp({
      policy,
      signals,
      period,
      ...(options.coverageGaps ? { coverageGaps: options.coverageGaps } : {}),
    })

    if (!result) {
      // No coverage: we never watched. Write nothing rather than a 0% row.
      summary.unobserved++
      continue
    }

    await prisma.utilisationSnapshot.upsert({
      where: {
        assetId_periodStart_periodEnd: { assetId: asset.id, periodStart: period.start, periodEnd: period.end },
      },
      create: { assetId: asset.id, ...result },
      update: {
        observedMinutes: result.observedMinutes,
        busyMinutes: result.busyMinutes,
        idleMinutes: result.idleMinutes,
        utilisationPct: result.utilisationPct,
      },
    })
    summary.written++
  }

  summary.skippedClasses = [...skipped].sort()
  return summary
}

/**
 * Load the signals needed to roll up a period.
 *
 * Reaches BEFORE the period start by the threshold plus the coverage gap: an activity signal
 * from just before midnight still marks the first minutes of the day busy, and a signal just
 * before the period provides the coverage context for the first one inside it. Without the
 * lookback every day would start with a phantom idle stretch.
 */
async function loadSignals(
  prisma: PrismaClient,
  assetId: string,
  period: Interval,
  thresholdMinutes: number,
  coverageGaps: CoverageGaps = {},
): Promise<SignalInput[]> {
  // Reach back by the widest gap in play, so the slowest source's context is still loaded.
  const widestGap = Math.max(
    DEFAULT_COVERAGE_GAP_MINUTES,
    ...Object.values(coverageGaps).filter((g): g is number => typeof g === 'number'),
  )
  const lookbackMs = (thresholdMinutes + widestGap) * 60_000

  const rows = await prisma.signalEvent.findMany({
    where: {
      assetId,
      observedAt: { gte: new Date(period.start.getTime() - lookbackMs), lt: period.end },
    },
    orderBy: { observedAt: 'asc' },
    select: { assetId: true, source: true, type: true, value: true, observedAt: true },
  })

  return rows as unknown as SignalInput[]
}

/** Snapshots for an asset, most recent first. */
export async function utilisationHistory(prisma: PrismaClient, assetId: string, take = 30) {
  return prisma.utilisationSnapshot.findMany({
    where: { assetId },
    orderBy: { periodStart: 'desc' },
    take,
  })
}

export interface SiteUtilisation {
  siteId: string
  siteCode: string
  siteName: string
  /** Assets with a snapshot in the window. */
  measured: number
  /** Mean utilisation across measured assets, or null when nothing was measured. */
  utilisationPct: number | null
}

/**
 * Mean utilisation per site over a window, within the caller's scope.
 *
 * Returns null rather than 0 for a site with no measured assets — a site with no connectors
 * deployed is unknown, not idle (ADR-0015). Rendering that as 0% would be the same lie the
 * rollup exists to prevent.
 *
 * Scoped like every other read path: utilisation is the figure that drives disposal
 * decisions, so one branch reading another's is a political problem as well as a privacy
 * one (ADR-0017).
 */
export async function siteUtilisation(
  prisma: PrismaClient,
  options: { since?: Date; scope?: SiteScope } = {},
): Promise<SiteUtilisation[]> {
  const since = options.since ?? new Date(Date.now() - 7 * 24 * 60 * 60_000)
  const scope = options.scope ?? { kind: 'all' }

  if (scope.kind === 'none') return []

  const [sites, snapshots] = await Promise.all([
    prisma.site.findMany({
      ...(scope.kind === 'site' ? { where: { id: scope.siteId } } : {}),
      orderBy: { code: 'asc' },
    }),
    prisma.utilisationSnapshot.findMany({
      where: {
        periodStart: { gte: since },
        ...(scope.kind === 'site' ? { asset: { siteId: scope.siteId } } : {}),
      },
      select: { assetId: true, utilisationPct: true, asset: { select: { siteId: true } } },
    }),
  ])

  const bySite = new Map<string, { total: number; assets: Set<string>; count: number }>()
  for (const snapshot of snapshots) {
    const entry = bySite.get(snapshot.asset.siteId) ?? { total: 0, assets: new Set<string>(), count: 0 }
    entry.total += snapshot.utilisationPct
    entry.count++
    entry.assets.add(snapshot.assetId)
    bySite.set(snapshot.asset.siteId, entry)
  }

  return sites.map((site) => {
    const entry = bySite.get(site.id)
    return {
      siteId: site.id,
      siteCode: site.code,
      siteName: site.name,
      measured: entry?.assets.size ?? 0,
      utilisationPct: entry && entry.count > 0 ? Math.round((entry.total / entry.count) * 10) / 10 : null,
    }
  })
}

/** Overrides as the UI edits them, resolved for display. */
export type { IdleConfigOverride }
