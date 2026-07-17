import { scopeToSite } from '@oat/auth'
import { prisma } from '@oat/db'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatAssetClass, formatDateTime, formatDuration } from '@/lib/format'
import { requirePermission } from '@/lib/page-auth'
import { AcknowledgeButton } from './acknowledge-button'

export const dynamic = 'force-dynamic'

export default async function AlertsPage() {
  const principal = await requirePermission('utilisation:read', '/alerts')

  const scope = scopeToSite(principal)
  const alerts =
    scope.kind === 'none'
      ? []
      : await prisma.idleAlert.findMany({
          where: {
            status: { in: ['OPEN', 'ACKNOWLEDGED'] },
            ...(scope.kind === 'site' ? { asset: { siteId: scope.siteId } } : {}),
          },
          // Longest-idle first: that is the disposal conversation, and the reason this
          // list exists at all.
          orderBy: { idleMinutes: 'desc' },
          take: 200,
          include: {
            asset: { select: { id: true, tag: true, name: true, class: true, site: { select: { code: true } } } },
          },
        })

  const open = alerts.filter((a) => a.status === 'OPEN')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Idle alerts</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Assets idle for longer than their configured alert threshold. This is the list that starts a disposal or
          redeployment conversation — so each row shows how long, and against what threshold.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Alerts <span className="ml-1 text-sm font-normal text-muted-foreground">({open.length} open)</span>
          </CardTitle>
          <CardDescription>
            Acknowledging stops the sweep re-raising an alert. It does not resolve it — the asset is still idle, and it
            resolves itself when the asset is used again.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Idle for</TableHead>
                <TableHead>Threshold</TableHead>
                <TableHead>Idle since</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {alerts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                    Nothing idle past its threshold.
                  </TableCell>
                </TableRow>
              ) : (
                alerts.map((alert) => (
                  <TableRow key={alert.id} data-testid="alert-row" data-tag={alert.asset.tag}>
                    <TableCell className="font-medium">
                      <Link href={`/assets/${alert.asset.id}`} className="hover:underline">
                        {alert.asset.tag}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{alert.asset.name}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{alert.asset.site.code}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatAssetClass(alert.asset.class)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-medium tabular-nums">
                      {formatDuration(alert.idleMinutes)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                      {/* The threshold as it was WHEN THE ALERT FIRED — so the alert stays
                          explicable after someone changes the config. */}
                      {formatDuration(alert.thresholdMinutes)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(alert.idleSince)}
                    </TableCell>
                    <TableCell>
                      {alert.status === 'OPEN' ? (
                        <AcknowledgeButton alertId={alert.id} />
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Acknowledged by {alert.acknowledgedBy ?? 'someone'}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
