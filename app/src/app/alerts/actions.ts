'use server'

import { audit, can, scopeToSite } from '@oat/auth'
import { prisma } from '@oat/db'
import { revalidatePath } from 'next/cache'
import { requirePrincipal } from '@/lib/auth'

export interface ActionResult {
  ok: boolean
  message: string
}

/**
 * Acknowledge an idle alert.
 *
 * Says "a human has seen this", so the sweep stops re-raising it. Deliberately does NOT
 * resolve it: the asset is still idle, and it resolves itself when the asset is used again.
 * Nobody gets to declare a machine busy by clicking a button.
 */
export async function acknowledgeAlert(alertId: string): Promise<ActionResult> {
  const principal = await requirePrincipal('/alerts')
  if (!can(principal, 'utilisation:read')) {
    return { ok: false, message: 'You do not have permission to acknowledge alerts.' }
  }

  const alert = await prisma.idleAlert.findUnique({
    where: { id: alertId },
    include: { asset: { select: { siteId: true } } },
  })
  if (!alert) return { ok: false, message: 'Alert not found.' }

  const scope = scopeToSite(principal)
  if (scope.kind === 'none' || (scope.kind === 'site' && scope.siteId !== alert.asset.siteId)) {
    return { ok: false, message: 'That asset is not at your site.' }
  }

  if (alert.status !== 'OPEN') return { ok: false, message: `Already ${alert.status.toLowerCase()}.` }

  await prisma.idleAlert.update({
    where: { id: alertId },
    data: { status: 'ACKNOWLEDGED', acknowledgedBy: principal.email, acknowledgedAt: new Date() },
  })

  await audit(prisma, principal, {
    action: 'IDLE_ALERT_ACKNOWLEDGE',
    entity: 'IdleAlert',
    entityId: alertId,
    before: { status: 'OPEN' },
    after: { status: 'ACKNOWLEDGED' },
  })

  revalidatePath('/alerts')
  return { ok: true, message: 'Acknowledged.' }
}
