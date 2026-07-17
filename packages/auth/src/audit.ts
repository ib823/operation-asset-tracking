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

/**
 * Authentication events (RFP §8: an auth log a SIEM can consume).
 *
 * These are NOT mutations, and were missing entirely until Phase 4 — the audit log covered
 * "who changed this asset" but not "who tried to get in". A failed sign-in is the single most
 * useful line in a security log: one is a typo, two hundred is an attack, and neither was
 * visible.
 */
export const AUTH_EVENT = {
  signInSucceeded: 'AUTH_SIGN_IN_SUCCEEDED',
  signInFailed: 'AUTH_SIGN_IN_FAILED',
  signedOut: 'AUTH_SIGNED_OUT',
  /** A token rejected because the user was deactivated or their tokens revoked (ADR-0011). */
  tokenRejected: 'AUTH_TOKEN_REJECTED',
} as const

export type AuthEvent = (typeof AUTH_EVENT)[keyof typeof AUTH_EVENT]

/**
 * Record an authentication event.
 *
 * The email is recorded as supplied, even when no such user exists — that is precisely the
 * value: "someone tried admin@lablink 40 times" is the signal, and dropping it because the
 * account is fictional would discard the attack while logging the noise.
 *
 * NEVER records the password, or whether the email matched. The log must not become a place
 * to look up which accounts are real (see `verifyCredentials`).
 */
export async function auditAuth(
  prisma: Pick<PrismaClient, 'auditLog'>,
  event: AuthEvent,
  email: string,
  detail: { reason?: string; ip?: string; userAgent?: string } = {},
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actor: email || '(none supplied)',
      action: event,
      entity: 'Auth',
      // Not a user id: a failed sign-in may have no user, and inventing one would be a lie.
      entityId: email || 'unknown',
      after: {
        ...(detail.reason ? { reason: detail.reason } : {}),
        ...(detail.ip ? { ip: detail.ip } : {}),
        ...(detail.userAgent ? { userAgent: detail.userAgent } : {}),
      } as never,
    },
  })
}

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
