import { can, type Permission, type Principal } from '@oat/auth'
import { NextResponse } from 'next/server'
import { currentPrincipal } from './auth'
import { checkCollectorToken } from './collector-auth'

/**
 * The API guard: session + RBAC (Phase 1).
 *
 * Replaces the Phase 0 shared bearer token. That token was a deliberate seam, but it had no
 * actor — which made "who retired this analyser?" unanswerable and the RFP 1.41 audit trail
 * impossible to honour. Every mutation now carries a real person.
 *
 * Call sites did not change shape: `requirePermission` returns a NextResponse to return, or
 * a principal to use, exactly as `requireApiToken` returned a response or null.
 */

export type Guarded = { ok: true; principal: Principal } | { ok: false; response: NextResponse }

/**
 * Authenticate the caller and check one permission.
 *
 * 401 when unauthenticated, 403 when authenticated but not permitted — the distinction
 * matters to a legitimate user trying to work out why they are stuck.
 */
export async function requirePermission(permission: Permission): Promise<Guarded> {
  const principal = await currentPrincipal()

  if (!principal) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorised' }, { status: 401 }) }
  }

  if (!can(principal, permission)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden', required: permission }, { status: 403 }),
    }
  }

  return { ok: true, principal }
}

/**
 * Authenticate a machine caller: the scheduler, a connector webhook, a cron trigger.
 *
 * These have no session and no person behind them. `OAT_SERVICE_TOKEN` fails closed — unset
 * means service endpoints are disabled, never open — and the caller is audited as a system
 * actor so machine-driven changes stay distinguishable from human ones in the trail.
 *
 * Kept deliberately narrow: it authenticates, and grants nothing beyond the specific route
 * that calls it. It is not a way to obtain a principal.
 */
export function requireServiceToken(request: Request): NextResponse | null {
  const expected = process.env.OAT_SERVICE_TOKEN

  if (!expected) {
    return NextResponse.json(
      { error: 'OAT_SERVICE_TOKEN is not configured; service endpoints are disabled' },
      { status: 503 },
    )
  }

  const header = request.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''

  if (!timingSafeEqual(presented, expected)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  return null
}

/**
 * Compare without leaking length or content through timing.
 *
 * `a === b` short-circuits at the first differing byte, which is measurable.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export type CollectorGuard = { ok: true; collectorId: string } | { ok: false; response: NextResponse }

/**
 * Authenticate an on-LAN collector pushing signals (ADR-0021).
 *
 * A thin `NextResponse` wrapper over the pure {@link checkCollectorToken} decision (kept
 * framework-free so it is unit-testable). Fail-closed, exactly like {@link requireServiceToken}:
 * empty registry → `503`, missing/wrong token → `401`.
 */
export function requireCollectorAuth(request: Request): CollectorGuard {
  const decision = checkCollectorToken(
    process.env,
    request.headers.get('x-collector-id'),
    request.headers.get('authorization'),
  )
  if (decision.ok) return { ok: true, collectorId: decision.collectorId }
  return { ok: false, response: NextResponse.json({ error: decision.error }, { status: decision.status }) }
}
