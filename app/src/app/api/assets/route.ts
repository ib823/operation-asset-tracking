import { listAssets } from '@oat/core'
import { prisma } from '@oat/db'
import { NextResponse, type NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const STATUSES = ['IN_USE', 'IDLE', 'UNDER_REPAIR', 'RETIRED'] as const
const CLASSES = ['LAB_INSTRUMENT', 'IT', 'PRINTER', 'SCANNER', 'REUSABLE_COMPONENT', 'OTHER'] as const

/** GET /api/assets — the operational register, filterable. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams

  const status = STATUSES.find((s) => s === params.get('status'))
  const assetClass = CLASSES.find((c) => c === params.get('class'))
  const siteId = params.get('siteId')
  const query = params.get('q')

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
      lastSeenAt: asset.lastSeenAt,
      idleSince: asset.idleSince,
    })),
  })
}
