import { can } from '@oat/auth'
import { prisma } from '@oat/db'
import { requirePermission } from '@/lib/page-auth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTime } from '@/lib/format'
import { ResolveForm } from './resolve-form'

export const dynamic = 'force-dynamic'

const REASON_LABELS: Record<string, string> = {
  NO_MATCH: 'No tag or serial matched',
  UNKNOWN_COST_CENTRE: 'Cost centre maps to no known site',
  CONFLICTING_LINK: 'Serial matches an asset already linked elsewhere',
}

export default async function ReconciliationPage() {
  const principal = await requirePermission('reconciliation:read', '/reconciliation')
  const canResolve = can(principal, 'reconciliation:resolve')

  const items = await prisma.reconciliationItem.findMany({
    where: { status: 'OPEN' },
    // Oldest first: age is what matters. A long list of fresh items is just last night's
    // sync; one item open for three weeks is a problem nobody is looking at.
    orderBy: { firstSeenAt: 'asc' },
    take: 200,
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reconciliation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          SAP records the sync could not place. The OAT never creates assets from these — SAP knowing about an asset is
          not evidence that anyone tagged it, so a human decides.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Open items <span className="ml-1 text-sm font-normal text-muted-foreground">({items.length})</span>
          </CardTitle>
          <CardDescription>
            Link an item to the asset it refers to, or dismiss it with a reason. Oldest first.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SAP asset no.</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>First seen</TableHead>
                {canResolve ? <TableHead className="w-80">Resolve</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={canResolve ? 5 : 4} className="py-10 text-center text-sm text-muted-foreground">
                    Nothing to reconcile. Every SAP record matched an asset in the register.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => {
                  const record = item.sapRecord as { description?: string; costCentre?: string; serialNumber?: string }
                  return (
                    <TableRow key={item.id} data-testid="reconciliation-row" data-sap-asset-no={item.sapAssetNo}>
                      <TableCell className="font-medium tabular-nums">{item.sapAssetNo}</TableCell>
                      <TableCell>
                        {record.description ?? '—'}
                        <span className="block text-xs text-muted-foreground">
                          {record.costCentre ? `Cost centre ${record.costCentre}` : null}
                          {record.serialNumber ? ` · ${record.serialNumber}` : null}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {REASON_LABELS[item.reason] ?? item.reason}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {formatDateTime(item.firstSeenAt)}
                      </TableCell>
                      {canResolve ? (
                        <TableCell>
                          <ResolveForm itemId={item.id} />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
