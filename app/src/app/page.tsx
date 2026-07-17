import { requirePermission } from '@/lib/page-auth'
import { siteStatusBreakdown, siteUtilisation } from '@oat/core'
import { prisma } from '@oat/db'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// The dashboard reflects live signal ingestion, so it must never be served from a build-time
// or route cache — a stale idle count is worse than a slow one.
export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  await requirePermission('asset:read', '/')

  const [sites, utilisation, openAlerts] = await Promise.all([
    siteStatusBreakdown(prisma),
    siteUtilisation(prisma),
    prisma.idleAlert.count({ where: { status: 'OPEN' } }),
  ])
  const utilisationBySite = new Map(utilisation.map((u) => [u.siteId, u]))

  const totals = sites.reduce(
    (acc, site) => ({
      inUse: acc.inUse + site.inUse,
      idle: acc.idle + site.idle,
      underRepair: acc.underRepair + site.underRepair,
      total: acc.total + site.total,
    }),
    { inUse: 0, idle: 0, underRepair: 0, total: 0 },
  )

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Operational status across {sites.length} {sites.length === 1 ? 'site' : 'sites'}.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <SummaryTile label="In use" value={totals.inUse} testId="total-in-use" />
        <SummaryTile label="Idle" value={totals.idle} testId="total-idle" />
        <SummaryTile label="Under repair" value={totals.underRepair} testId="total-under-repair" />
        <SummaryTile label="Idle alerts" value={openAlerts} testId="total-alerts" />
      </div>

      <Card data-testid="idle-by-site-tile">
        <CardHeader>
          <CardTitle>Idle vs in use, by site</CardTitle>
          <CardDescription>
            Retired assets are excluded — they are no longer part of the operational estate.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {sites.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sites configured yet.</p>
          ) : (
            sites.map((site) => (
              <div key={site.siteId} data-testid="site-row" data-site-code={site.siteCode} className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link href={`/assets?site=${site.siteId}`} className="text-sm font-medium hover:underline">
                    {site.siteCode} · {site.siteName}
                  </Link>
                  <span className="text-sm text-muted-foreground">
                    <span data-testid="site-in-use-count">{site.inUse}</span> in use ·{' '}
                    <span data-testid="site-idle-count">{site.idle}</span> idle ·{' '}
                    <Utilisation site={utilisationBySite.get(site.siteId)} />
                  </span>
                </div>

                {/* A stacked bar, not a colour-only cue: the counts above carry the same
                    information for anyone who cannot distinguish the segments. */}
                <div
                  className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
                  role="img"
                  aria-label={`${site.siteCode}: ${site.inUse} in use, ${site.idle} idle, ${site.underRepair} under repair`}
                >
                  <Bar count={site.inUse} total={site.total} className="bg-emerald-500" />
                  <Bar count={site.idle} total={site.total} className="bg-amber-500" />
                  <Bar count={site.underRepair} total={site.total} className="bg-sky-500" />
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Utilisation over the last 7 days, or an honest "not measured".
 *
 * Null means no snapshot: nothing was observed, because no connector feeding this site's
 * assets is deployed. Rendering that as 0% would be the exact lie ADR-0015 exists to
 * prevent — and it is the number that would justify disposing of a busy machine.
 */
function Utilisation({ site }: { site?: { utilisationPct: number | null; measured: number } }) {
  if (!site || site.utilisationPct === null) {
    return (
      <span data-testid="site-utilisation" title="No connector data — utilisation is unknown, not zero">
        utilisation <span className="italic">not measured</span>
      </span>
    )
  }

  return (
    <span data-testid="site-utilisation">
      <span className="tabular-nums">{site.utilisationPct}%</span> utilisation
      <span className="text-xs"> ({site.measured} measured)</span>
    </span>
  )
}

function Bar({ count, total, className }: { count: number; total: number; className: string }) {
  if (count === 0 || total === 0) return null
  return <div className={className} style={{ width: `${(count / total) * 100}%` }} />
}

function SummaryTile({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <p data-testid={testId} className="text-3xl font-semibold tabular-nums">
          {value}
        </p>
      </CardContent>
    </Card>
  )
}
