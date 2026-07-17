import { audit, scopeToSite } from '@oat/auth'
import { prisma } from '@oat/db'
import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/alerts/[id] — acknowledge an idle alert.
 *
 * Acknowledging says "a human has seen this", so the sweep stops re-raising it. It does NOT
 * resolve it: the asset is still idle, and it resolves itself when the asset comes back to
 * life. A human cannot declare a machine busy by clicking a button.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const guard = await requirePermission('utilisation:read')
  if (!guard.ok) return guard.response

  const { id } = await params
  const alert = await prisma.idleAlert.findUnique({
    where: { id },
    include: { asset: { select: { siteId: true } } },
  })
  if (!alert) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const scope = scopeToSite(guard.principal)
  if (scope.kind === 'none' || (scope.kind === 'site' && scope.siteId !== alert.asset.siteId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (alert.status !== 'OPEN') {
    return NextResponse.json({ error: 'Already handled', status: alert.status }, { status: 409 })
  }

  const updated = await prisma.idleAlert.update({
    where: { id },
    data: { status: 'ACKNOWLEDGED', acknowledgedBy: guard.principal.email, acknowledgedAt: new Date() },
  })

  await audit(prisma, guard.principal, {
    action: 'IDLE_ALERT_ACKNOWLEDGE',
    entity: 'IdleAlert',
    entityId: id,
    before: { status: 'OPEN' },
    after: { status: 'ACKNOWLEDGED' },
  })

  return NextResponse.json(updated)
}
