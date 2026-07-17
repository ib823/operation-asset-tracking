import { scopeToSite } from '@oat/auth'
import { prisma } from '@oat/db'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { StatusBadge } from '@/components/status-badge'
import { formatAssetClass, formatDateTime, formatDuration } from '@/lib/format'
import { requirePermission } from '@/lib/page-auth'
import { AcknowledgeButton } from './acknowledge-button'

export const dynamic = 'force-dynamic'

/**
 * FUNCTIONAL, NOT FINAL — presentation is provisional (ADR-0021). Data, scoping and logic
 * are final; the design system will restyle the markup.
 */
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

  // Sustained scan-vs-telemetry disagreement (ADR-0010). Written since Phase 2 and never
  // shown — a detector nobody can see is a detector that does nothing.
  const conflicts =
    scope.kind === 'none'
      ? []
      : await prisma.conflictAlert.findMany({
          where: {
            status: 'OPEN',
            ...(scope.kind === 'site' ? { asset: { siteId: scope.siteId } } : {}),
          },
          orderBy: { sustainedMinutes: 'desc' },
          take: 100,
          include: { asset: { select: { id: true, tag: true, name: true, site: { select: { code: true } } } } },
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

      <Card>
        <CardHeader>
          <CardTitle>
            Conflicts <span className="ml-1 text-sm font-normal text-muted-foreground">({conflicts.length} open)</span>
          </CardTitle>
          <CardDescription>
            A human scan and the telemetry have disagreed for long enough to be worth checking. The scan wins for its
            TTL — this is a diagnosis, not a veto. Either the scan was wrong, the device is misconfigured, or its asset
            reference points at the wrong machine.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Scan says</TableHead>
                <TableHead>Telemetry says</TableHead>
                <TableHead>Disagreeing for</TableHead>
                <TableHead>Scanned</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {conflicts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    No conflicts — scans and telemetry agree.
                  </TableCell>
                </TableRow>
              ) : (
                conflicts.map((conflict) => (
                  <TableRow key={conflict.id} data-testid="conflict-row" data-tag={conflict.asset.tag}>
                    <TableCell className="font-medium">
                      <Link href={`/assets/${conflict.asset.id}`} className="hover:underline">
                        {conflict.asset.tag}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{conflict.asset.name}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{conflict.asset.site.code}</TableCell>
                    <TableCell>
                      <StatusBadge status={conflict.scanStatus} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={conflict.telemetryStatus} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-medium tabular-nums">
                      {formatDuration(conflict.sustainedMinutes)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(conflict.scanAssertedAt)}
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
