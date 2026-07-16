import type { AssetStatus, PrismaClient } from '@oat/db'

/** Idle-vs-in-use counts for one site — the Phase 0 dashboard tile. */
export interface SiteStatusBreakdown {
  siteId: string
  siteCode: string
  siteName: string
  inUse: number
  idle: number
  underRepair: number
  retired: number
  total: number
  /** In-use as a percentage of assets in service (retired excluded). 0 when none. */
  inUsePct: number
}

/**
 * Count assets by status, per site.
 *
 * Grouped in the database rather than by loading assets and counting in JS: at 32 sites
 * this hardly matters, but the dashboard is the one page every user opens and it should
 * not scale with the asset count.
 */
export async function siteStatusBreakdown(prisma: PrismaClient): Promise<SiteStatusBreakdown[]> {
  const [sites, grouped] = await Promise.all([
    prisma.site.findMany({ orderBy: { code: 'asc' } }),
    prisma.asset.groupBy({ by: ['siteId', 'status'], _count: { _all: true } }),
  ])

  const counts = new Map<string, Map<AssetStatus, number>>()
  for (const row of grouped) {
    const bySite = counts.get(row.siteId) ?? new Map<AssetStatus, number>()
    bySite.set(row.status, row._count._all)
    counts.set(row.siteId, bySite)
  }

  return sites.map((site) => {
    const bySite = counts.get(site.id) ?? new Map<AssetStatus, number>()
    const inUse = bySite.get('IN_USE') ?? 0
    const idle = bySite.get('IDLE') ?? 0
    const underRepair = bySite.get('UNDER_REPAIR') ?? 0
    const retired = bySite.get('RETIRED') ?? 0
    // Retired assets are not part of the operational picture — including them would drag
    // every site's utilisation down as the estate ages, which tells the client nothing.
    const inService = inUse + idle + underRepair

    return {
      siteId: site.id,
      siteCode: site.code,
      siteName: site.name,
      inUse,
      idle,
      underRepair,
      retired,
      total: inUse + idle + underRepair + retired,
      inUsePct: inService === 0 ? 0 : Math.round((inUse / inService) * 100),
    }
  })
}
