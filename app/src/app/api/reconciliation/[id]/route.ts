import { audit } from '@oat/auth'
import { prisma } from '@oat/db'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

const ResolveBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('link'),
    /** The existing OAT asset this SAP record refers to. */
    assetId: z.string().min(1),
  }),
  z.object({
    action: z.literal('dismiss'),
    /** Why. A dismissal with no reason is indistinguishable from someone clearing a list. */
    note: z.string().min(1),
  }),
])

/**
 * POST /api/reconciliation/[id] — resolve a queue item (ADR-0009).
 *
 * Two outcomes, both human decisions:
 *
 *   link     — this SAP record is that OAT asset. Establishes the shared key.
 *   dismiss  — not ours to track (bulk consumables, an asset at a site we do not run).
 *
 * There is deliberately no "create asset" action. The OAT never invents register rows from
 * SAP: SAP knowing about an asset is not evidence anyone tagged it. If it should be tracked,
 * someone tags it physically and scans it in — which is the same act that makes the register
 * true.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const guard = await requirePermission('reconciliation:resolve')
  if (!guard.ok) return guard.response

  const { id } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const parsed = ResolveBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const item = await prisma.reconciliationItem.findUnique({ where: { id } })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (item.status !== 'OPEN') {
    // Someone else got there first. Say so rather than silently re-resolving — two people
    // working the same queue is exactly when this happens.
    return NextResponse.json({ error: 'Already resolved', status: item.status }, { status: 409 })
  }

  if (parsed.data.action === 'dismiss') {
    const updated = await prisma.reconciliationItem.update({
      where: { id },
      data: {
        status: 'DISMISSED',
        note: parsed.data.note,
        resolvedBy: guard.principal.email,
        resolvedAt: new Date(),
      },
    })

    await audit(prisma, guard.principal, {
      action: 'RECONCILIATION_DISMISS',
      entity: 'ReconciliationItem',
      entityId: id,
      before: { status: 'OPEN' },
      after: { status: 'DISMISSED', note: parsed.data.note },
    })

    return NextResponse.json(updated)
  }

  const asset = await prisma.asset.findUnique({
    where: { id: parsed.data.assetId },
    select: { id: true, tag: true, sapAssetNo: true },
  })
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 })

  // Refuse to re-point an asset that is already linked elsewhere. This is the same rule the
  // sync enforces (ADR-0009), and it must hold here too — otherwise the manual path becomes
  // the way to do the thing automation is forbidden from doing.
  if (asset.sapAssetNo && asset.sapAssetNo !== item.sapAssetNo) {
    return NextResponse.json(
      { error: 'Asset is already linked to a different SAP asset', sapAssetNo: asset.sapAssetNo },
      { status: 409 },
    )
  }

  const [linked] = await prisma.$transaction([
    prisma.asset.update({ where: { id: asset.id }, data: { sapAssetNo: item.sapAssetNo } }),
    prisma.reconciliationItem.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        resolvedAssetId: asset.id,
        resolvedBy: guard.principal.email,
        resolvedAt: new Date(),
      },
    }),
  ])

  await audit(prisma, guard.principal, {
    action: 'RECONCILIATION_LINK',
    entity: 'Asset',
    entityId: asset.id,
    before: { sapAssetNo: asset.sapAssetNo },
    after: { sapAssetNo: item.sapAssetNo, viaReconciliationItem: id },
  })

  return NextResponse.json({ asset: linked })
}
