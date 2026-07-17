'use server'

import { audit, can, type Principal } from '@oat/auth'
import { prisma } from '@oat/db'
import { revalidatePath } from 'next/cache'
import { requirePrincipal } from '@/lib/auth'

/**
 * Resolve a reconciliation item (ADR-0009).
 *
 * A server action is a public endpoint, whatever the UI shows — so it authenticates and
 * authorises for itself. Hiding the form from a user without `reconciliation:resolve` is a
 * courtesy, not a control.
 */

export interface ActionResult {
  ok: boolean
  message: string
}

async function authorise(): Promise<Principal | ActionResult> {
  const principal = await requirePrincipal('/reconciliation')
  if (!can(principal, 'reconciliation:resolve')) {
    return { ok: false, message: 'You do not have permission to resolve reconciliation items.' }
  }
  return principal
}

function isResult(value: Principal | ActionResult): value is ActionResult {
  return 'ok' in value
}

/** Link the SAP record to an existing asset, establishing the shared key. */
export async function linkItem(itemId: string, tag: string): Promise<ActionResult> {
  const auth = await authorise()
  if (isResult(auth)) return auth

  const item = await prisma.reconciliationItem.findUnique({ where: { id: itemId } })
  if (!item) return { ok: false, message: 'Item not found.' }
  if (item.status !== 'OPEN') return { ok: false, message: `Already ${item.status.toLowerCase()}.` }

  const asset = await prisma.asset.findUnique({ where: { tag: tag.trim() } })
  if (!asset) return { ok: false, message: `No asset with tag ${tag}.` }

  // The same rule the sync enforces: never silently re-point an asset that is already linked
  // elsewhere. Otherwise the manual path becomes the way to do what automation is forbidden
  // from doing.
  if (asset.sapAssetNo && asset.sapAssetNo !== item.sapAssetNo) {
    return { ok: false, message: `${tag} is already linked to SAP asset ${asset.sapAssetNo}.` }
  }

  await prisma.$transaction([
    prisma.asset.update({ where: { id: asset.id }, data: { sapAssetNo: item.sapAssetNo } }),
    prisma.reconciliationItem.update({
      where: { id: itemId },
      data: { status: 'RESOLVED', resolvedAssetId: asset.id, resolvedBy: auth.email, resolvedAt: new Date() },
    }),
  ])

  await audit(prisma, auth, {
    action: 'RECONCILIATION_LINK',
    entity: 'Asset',
    entityId: asset.id,
    before: { sapAssetNo: asset.sapAssetNo },
    after: { sapAssetNo: item.sapAssetNo, viaReconciliationItem: itemId },
  })

  revalidatePath('/reconciliation')
  return { ok: true, message: `Linked ${tag} to SAP asset ${item.sapAssetNo}.` }
}

/** Dismiss the item — not ours to track. */
export async function dismissItem(itemId: string, note: string): Promise<ActionResult> {
  const auth = await authorise()
  if (isResult(auth)) return auth

  // A dismissal with no reason is indistinguishable from someone clearing a list they were
  // tired of looking at.
  if (!note.trim()) return { ok: false, message: 'A reason is required to dismiss an item.' }

  const item = await prisma.reconciliationItem.findUnique({ where: { id: itemId } })
  if (!item) return { ok: false, message: 'Item not found.' }
  if (item.status !== 'OPEN') return { ok: false, message: `Already ${item.status.toLowerCase()}.` }

  await prisma.reconciliationItem.update({
    where: { id: itemId },
    data: { status: 'DISMISSED', note: note.trim(), resolvedBy: auth.email, resolvedAt: new Date() },
  })

  await audit(prisma, auth, {
    action: 'RECONCILIATION_DISMISS',
    entity: 'ReconciliationItem',
    entityId: itemId,
    before: { status: 'OPEN' },
    after: { status: 'DISMISSED', note: note.trim() },
  })

  revalidatePath('/reconciliation')
  return { ok: true, message: 'Dismissed.' }
}
