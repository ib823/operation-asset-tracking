import { scopeToSite } from '@oat/auth'
import { utilisationHistory } from '@oat/core'
import { prisma } from '@oat/db'
import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/assets/[tag]/utilisation — daily snapshots for one asset (ADR-0015).
 *
 * An EMPTY list means "not measured", never 0%. That distinction is the whole point: a zero
 * indistinguishable from ignorance is what would justify disposing of a busy machine.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ tag: string }> }): Promise<NextResponse> {
  const guard = await requirePermission('utilisation:read')
  if (!guard.ok) return guard.response

  const { tag } = await params
  const asset = await prisma.asset.findUnique({
    where: { tag },
    select: { id: true, tag: true, class: true, subType: true, siteId: true },
  })
  if (!asset) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const scope = scopeToSite(guard.principal)
  if (scope.kind === 'none' || (scope.kind === 'site' && scope.siteId !== asset.siteId)) {
    // 404 rather than 403: confirming the tag exists would leak that another site holds it.
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const snapshots = await utilisationHistory(prisma, asset.id)

  return NextResponse.json({
    asset: { id: asset.id, tag: asset.tag, class: asset.class, subType: asset.subType },
    snapshots,
  })
}
