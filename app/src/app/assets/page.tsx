import { listAssets } from '@oat/core'
import { prisma } from '@oat/db'
import Link from 'next/link'
import { StatusBadge } from '@/components/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatAssetClass, formatDateTime, formatDuration, minutesSince } from '@/lib/format'

export const dynamic = 'force-dynamic'

interface SearchParams {
  site?: string
  status?: string
  q?: string
}

const STATUSES = ['IN_USE', 'IDLE', 'UNDER_REPAIR', 'RETIRED'] as const

function parseStatus(value: string | undefined) {
  return STATUSES.find((status) => status === value)
}

export default async function AssetsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  const status = parseStatus(params.status)

  const assets = await listAssets(prisma, {
    ...(params.site ? { siteId: params.site } : {}),
    ...(status ? { status } : {}),
    ...(params.q ? { query: params.q } : {}),
  })

  const now = new Date()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Assets</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {assets.length} {assets.length === 1 ? 'asset' : 'assets'} in the operational register.
        </p>
      </div>

      {/* GET so a filtered view is a shareable URL — a lab manager can send "the idle list
          at PJ02" to someone rather than describing how to reproduce it. */}
      <form className="flex flex-wrap gap-2" role="search">
        <input
          type="search"
          name="q"
          defaultValue={params.q ?? ''}
          placeholder="Search tag, name or SAP asset no."
          aria-label="Search assets"
          className="h-9 min-w-64 flex-1 rounded-md border border-input bg-background px-3 text-sm"
        />
        <select
          name="status"
          defaultValue={params.status ?? ''}
          aria-label="Filter by status"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="IN_USE">In use</option>
          <option value="IDLE">Idle</option>
          <option value="UNDER_REPAIR">Under repair</option>
          <option value="RETIRED">Retired</option>
        </select>
        {params.site ? <input type="hidden" name="site" value={params.site} /> : null}
        <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
          Filter
        </button>
      </form>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tag</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Site</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Idle for</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead>SAP asset no.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {assets.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No assets match these filters.
                </TableCell>
              </TableRow>
            ) : (
              assets.map((asset) => {
                const idleFor = asset.status === 'IDLE' ? minutesSince(asset.idleSince, now) : null
                return (
                  <TableRow key={asset.id} data-testid="asset-row" data-tag={asset.tag}>
                    <TableCell className="font-medium">
                      <Link href={`/assets/${asset.id}`} className="hover:underline">
                        {asset.tag}
                      </Link>
                    </TableCell>
                    <TableCell>{asset.name}</TableCell>
                    <TableCell className="whitespace-nowrap">{asset.site.code}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatAssetClass(asset.class)}</TableCell>
                    <TableCell>
                      <StatusBadge status={asset.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                      {idleFor === null ? '—' : formatDuration(idleFor)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(asset.lastSeenAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                      {/* Absence is meaningful: it means the SAP sync has not matched this
                          asset yet, not that the asset is unimportant. */}
                      {asset.sapAssetNo ?? <span className="italic">not linked</span>}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
