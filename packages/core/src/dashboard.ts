import type { AssetStatus, Prisma, PrismaClient } from '@oat/db'

/**
 * Dashboard aggregates.
 *
 * Every function here takes a `SiteScope` and narrows the QUERY — it does not filter after
 * the fact. Aggregates are not exempt from access control just because they are summaries:
 * a count is a fact about the rows, and if the rows are confidential so is the count derived
 * from them (ADR-0017).
 */

/**
 * How much of the estate the caller may see.
 *
 * Structurally identical to `@oat/auth`'s `SiteScope`, and deliberately re-declared rather
 * than imported: `core` is the domain and must not depend on the auth package (ADR-0002).
 * Callers pass the resolved scope in.
 */
export type SiteScope = { kind: 'all' } | { kind: 'site'; siteId: string } | { kind: 'none' }

/** Idle-vs-in-use counts for one site. */
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

/** Narrow a site query to the scope. `none` yields a filter nothing can match. */
function siteWhere(scope: SiteScope): Prisma.SiteWhereInput | null {
  switch (scope.kind) {
    case 'all':
      return {}
    case 'site':
      return { id: scope.siteId }
    case 'none':
      // Fail closed. Returning null lets the caller skip the query entirely rather than
      // hoping an empty filter means "nothing" — it means "everything".
      return null
  }
}

/**
 * Count assets by status, per site, within the caller's scope.
 *
 * Grouped in the database rather than by loading assets and counting in JS: at 32 sites this
 * hardly matters, but the dashboard is the page every user opens and it should not scale
 * with the asset count.
 */
export async function siteStatusBreakdown(
  prisma: PrismaClient,
  scope: SiteScope = { kind: 'all' },
): Promise<SiteStatusBreakdown[]> {
  const where = siteWhere(scope)
  if (!where) return []

  const [sites, grouped] = await Promise.all([
    prisma.site.findMany({ where, orderBy: { code: 'asc' } }),
    prisma.asset.groupBy({
      by: ['siteId', 'status'],
      // Narrowed here, not after: a forgotten post-filter leaks; a query that never selects
      // another site's rows cannot.
      ...(scope.kind === 'site' ? { where: { siteId: scope.siteId } } : {}),
      _count: { _all: true },
    }),
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

/** Open idle alerts within the caller's scope. */
export async function openAlertCount(prisma: PrismaClient, scope: SiteScope = { kind: 'all' }): Promise<number> {
  if (scope.kind === 'none') return 0

  return prisma.idleAlert.count({
    where: {
      status: 'OPEN',
      ...(scope.kind === 'site' ? { asset: { siteId: scope.siteId } } : {}),
    },
  })
}
