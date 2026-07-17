import type { PrismaClient } from '@oat/db'
import type { Principal } from './rbac'

/**
 * The audit trail (RFP 1.41).
 *
 * Every mutation records who did what, to which entity, and what changed. This is the reason
 * the interim bearer token had to go: a shared secret has no actor, so "who retired this
 * analyser?" was unanswerable by construction.
 */

export interface AuditEntry {
  action: string
  entity: string
  entityId: string
  before?: unknown
  after?: unknown
}

/** An actor that is not a person: the scheduler, a connector poll, the SAP sync. */
export type SystemActor = `system:${string}`

export function actorOf(principal: Principal | SystemActor): string {
  return typeof principal === 'string' ? principal : principal.email
}

/**
 * Write an audit record.
 *
 * Pass `tx` when the mutation runs in a transaction, so the audit entry commits or rolls
 * back with it. An audit row for a change that never landed is worse than no row: it is a
 * false statement about the past, and it will be believed.
 */
export async function audit(
  prisma: Pick<PrismaClient, 'auditLog'>,
  actor: Principal | SystemActor,
  entry: AuditEntry,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actor: actorOf(actor),
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      // Prisma distinguishes JSON null from SQL NULL on a Json? column, so `undefined`
      // (omit) is the right way to say "no prior state", not `null`.
      ...(entry.before === undefined ? {} : { before: entry.before as never }),
      ...(entry.after === undefined ? {} : { after: entry.after as never }),
    },
  })
}
