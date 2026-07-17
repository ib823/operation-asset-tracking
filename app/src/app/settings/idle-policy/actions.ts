'use server'

import { audit, can, type Principal } from '@oat/auth'
import { prisma } from '@oat/db'
import { revalidatePath } from 'next/cache'
import { requirePrincipal } from '@/lib/auth'

/**
 * Idle-policy configuration (ADR-0014).
 *
 * A server action is a public endpoint whatever the UI shows, so it authorises for itself.
 * Hiding the form from someone without `idle-policy:manage` is a courtesy, not a control.
 */

export interface ActionResult {
  ok: boolean
  message: string
}

const MAX_MINUTES = 60 * 24 * 365

async function authorise(): Promise<Principal | ActionResult> {
  const principal = await requirePrincipal('/settings/idle-policy')
  if (!can(principal, 'idle-policy:manage')) {
    return { ok: false, message: 'You do not have permission to change the idle policy.' }
  }
  return principal
}

function isResult(value: Principal | ActionResult): value is ActionResult {
  return 'ok' in value
}

export async function setThreshold(
  scope: 'CLASS' | 'SUB_TYPE' | 'ASSET',
  key: string,
  thresholdMinutes: number,
): Promise<ActionResult> {
  const auth = await authorise()
  if (isResult(auth)) return auth

  if (!Number.isInteger(thresholdMinutes) || thresholdMinutes <= 0 || thresholdMinutes > MAX_MINUTES) {
    return { ok: false, message: 'Enter a whole number of minutes between 1 and 525600.' }
  }

  const before = await prisma.idleConfig.findUnique({ where: { scope_key: { scope, key } } })

  await prisma.idleConfig.upsert({
    where: { scope_key: { scope, key } },
    create: { scope, key, thresholdMinutes, updatedBy: auth.email },
    // Only the threshold: an edit here must not blank out an alert setting the user did not
    // touch. The two resolve independently (ADR-0014).
    update: { thresholdMinutes, updatedBy: auth.email },
  })

  await audit(prisma, auth, {
    action: 'IDLE_CONFIG_SET',
    entity: 'IdleConfig',
    entityId: `${scope}:${key}`,
    before: before ? { thresholdMinutes: before.thresholdMinutes } : undefined,
    after: { thresholdMinutes },
  })

  revalidatePath('/settings/idle-policy')
  return { ok: true, message: `Saved — idle after ${thresholdMinutes} min.` }
}

/** Clear an override, falling back down the chain to the next level. */
export async function clearThreshold(scope: 'CLASS' | 'SUB_TYPE' | 'ASSET', key: string): Promise<ActionResult> {
  const auth = await authorise()
  if (isResult(auth)) return auth

  const deleted = await prisma.idleConfig.deleteMany({ where: { scope, key } })
  if (deleted.count === 0) return { ok: false, message: 'Nothing to clear — already the default.' }

  await audit(prisma, auth, {
    action: 'IDLE_CONFIG_CLEAR',
    entity: 'IdleConfig',
    entityId: `${scope}:${key}`,
    before: { existed: true },
    after: { existed: false },
  })

  revalidatePath('/settings/idle-policy')
  return { ok: true, message: 'Cleared — back to the default.' }
}
