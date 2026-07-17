import { scopeToSite } from '@oat/auth'
import { utilisationHeatmap } from '@oat/core'
import { prisma } from '@oat/db'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requirePermission } from '@/lib/page-auth'

/**
 * FUNCTIONAL, NOT FINAL — presentation is provisional (ADR-0021).
 *
 * The DATA and the LOGIC here are final and reviewed: scoping, the daily aggregation, and the
 * honest handling of "not measured" (ADR-0015). The MARKUP is deliberately plain — a shared
 * design system will restyle this, and any visual decision made now is one somebody undoes.
 *
 * Plain on purpose, not abandoned halfway. Do not rebuild the logic underneath it.
 */
export const dynamic = 'force-dynamic'

const DAYS = 14

export default async function HeatmapPage() {
  const principal = await requirePermission('utilisation:read', '/heatmap')

  // Scoped like every other read path (ADR-0017): a branch user sees their own row and
  // learns nothing about the shape of the estate.
  const rows = await utilisationHeatmap(prisma, { days: DAYS, scope: scopeToSite(principal) })
  const days = rows[0]?.cells.map((cell) => cell.day) ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Utilisation heatmap</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Mean utilisation per site, per day, over the last {DAYS} days. A blank cell means{' '}
          <strong>not measured</strong> — no connector was watching that day. It does not mean 0%.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            By site <span className="ml-1 text-sm font-normal text-muted-foreground">({rows.length})</span>
          </CardTitle>
          <CardDescription>Instruments report nothing until the LIS connector is deployed — by design.</CardDescription>
        </CardHeader>

        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sites in scope.</p>
          ) : (
            <div className="overflow-x-auto">
              <table data-testid="heatmap" className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="p-1 text-left font-medium">
                      Site
                    </th>
                    {days.map((day) => (
                      <th key={day} scope="col" className="p-1 text-center text-xs font-normal text-muted-foreground">
                        {/* Just the day-of-month: 14 full dates is unreadable, and the row
                            header carries the context. */}
                        {day.slice(8)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.siteId} data-testid="heatmap-row" data-site-code={row.siteCode}>
                      <th scope="row" className="whitespace-nowrap p-1 text-left font-medium">
                        {row.siteCode}
                        <span className="ml-2 font-normal text-muted-foreground">{row.siteName}</span>
                      </th>

                      {row.cells.map((cell) => (
                        <td
                          key={cell.day}
                          data-testid="heatmap-cell"
                          data-day={cell.day}
                          data-measured={cell.measured}
                          data-utilisation={cell.utilisationPct ?? 'not-measured'}
                          // Text, not just colour: the number IS the value, and a colour-only
                          // heatmap is unreadable to a colour-blind reader and in print.
                          title={
                            cell.utilisationPct === null
                              ? `${row.siteCode} ${cell.day}: not measured — no connector data`
                              : `${row.siteCode} ${cell.day}: ${cell.utilisationPct}% across ${cell.measured} asset(s)`
                          }
                          className={`border p-1 text-center tabular-nums ${cellClass(cell.utilisationPct)}`}
                        >
                          {cell.utilisationPct === null ? (
                            <span className="text-muted-foreground">·</span>
                          ) : (
                            Math.round(cell.utilisationPct)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * A deliberately crude scale. The design system will replace this entirely (ADR-0021).
 *
 * The one thing that must survive a restyle: `null` is NOT the bottom of the scale. An
 * unmeasured day must never look like an idle day — that is the difference between "we do
 * not know" and "dispose of this analyser".
 */
function cellClass(pct: number | null): string {
  if (pct === null) return 'bg-transparent'
  if (pct >= 75) return 'bg-emerald-200 dark:bg-emerald-900'
  if (pct >= 40) return 'bg-emerald-100 dark:bg-emerald-950'
  if (pct >= 10) return 'bg-amber-100 dark:bg-amber-950'
  return 'bg-red-100 dark:bg-red-950'
}
