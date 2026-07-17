import { scopeToSite } from '@oat/auth'
import { listAssets } from '@oat/core'
import { prisma } from '@oat/db'
import { NextResponse, type NextRequest } from 'next/server'
import { requirePermission } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

const STATUSES = ['IN_USE', 'IDLE', 'UNDER_REPAIR', 'RETIRED'] as const
const CLASSES = ['LAB_INSTRUMENT', 'IT', 'PRINTER', 'SCANNER', 'REUSABLE_COMPONENT', 'OTHER'] as const

/** GET /api/assets — the operational register, filtered and scoped to what the caller may see. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requirePermission('asset:read')
  if (!guard.ok) return guard.response

  const params = request.nextUrl.searchParams
  const status = STATUSES.find((s) => s === params.get('status'))
  const assetClass = CLASSES.find((c) => c === params.get('class'))
  const requestedSite = params.get('siteId')
  const query = params.get('q')

  // Site scoping narrows the query rather than filtering results afterwards — a forgotten
  // post-filter leaks data; a query that never selects another site's rows cannot.
  const scope = scopeToSite(guard.principal)
  if (scope.kind === 'none') {
    return NextResponse.json({ count: 0, assets: [] })
  }

  // A scoped user's own site always wins over whatever they asked for, so passing
  // ?siteId=<someone else's> cannot widen their view.
  const siteId = scope.kind === 'site' ? scope.siteId : (requestedSite ?? undefined)

  const assets = await listAssets(prisma, {
    ...(siteId ? { siteId } : {}),
    ...(status ? { status } : {}),
    ...(assetClass ? { assetClass } : {}),
    ...(query ? { query } : {}),
  })

  return NextResponse.json({
    count: assets.length,
    assets: assets.map((asset) => ({
      id: asset.id,
      tag: asset.tag,
      sapAssetNo: asset.sapAssetNo,
      name: asset.name,
      class: asset.class,
      status: asset.status,
      site: { id: asset.site.id, code: asset.site.code, name: asset.site.name },
      location: asset.location,
      custodianId: asset.custodianId,
      lastSeenAt: asset.lastSeenAt,
      lastActiveAt: asset.lastActiveAt,
      idleSince: asset.idleSince,
      scanAssertedStatus: asset.scanAssertedStatus,
      scanAssertedAt: asset.scanAssertedAt,
    })),
  })
}
