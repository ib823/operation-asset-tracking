import { NextResponse } from 'next/server'

/**
 * Interim guard for mutating API routes.
 *
 * RBAC via Auth.js is Phase 1. Until then these endpoints ingest signals and trigger the
 * SAP sync, so shipping them open — even in a PoC that will be demoed on a network we do
 * not control — is not acceptable. A shared secret is weak, but it is a door.
 *
 * This is deliberately a seam, not a design: Phase 1 replaces the body of `requireApiToken`
 * with a session/role check and every call site stays as it is.
 */
export function requireApiToken(request: Request): NextResponse | null {
  const expected = process.env.OAT_API_TOKEN

  // Fail closed. An unset token means "not configured", which must never read as
  // "no authentication required" — that is exactly how a PoC ends up exposed.
  if (!expected) {
    return NextResponse.json(
      { error: 'OAT_API_TOKEN is not configured; mutating endpoints are disabled' },
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
 * `a === b` on a secret short-circuits at the first differing byte, which is measurable.
 * Overkill for a PoC token; free to do correctly, and the habit is what matters when this
 * seam later guards something real.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
