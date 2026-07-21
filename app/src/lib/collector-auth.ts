/**
 * On-LAN collector authentication — the pure decision, no framework (ADR-0021).
 *
 * Kept free of `next/server` so it is unit-testable in isolation: the security-critical logic
 * (fail-closed, constant-time compare, no id-enumeration oracle) is a plain function over the
 * environment and the request headers. `api-auth.ts` wraps this into a `NextResponse`.
 */

/**
 * The collector registry: collector id → bearer, from the environment ONLY.
 *
 * Each collector has its own token so a compromised one is revoked alone, and none of them can
 * do what the cloud worker's `OAT_SERVICE_TOKEN` can. Format:
 * `OAT_COLLECTOR_TOKENS="collector-hq:tokenA,collector-pj:tokenB"`. A single-collector deployment
 * may instead set the collector's own `OAT_COLLECTOR_ID` + `OAT_COLLECTOR_TOKEN` pair.
 */
export function resolveCollectorTokens(env: Record<string, string | undefined> = process.env): Map<string, string> {
  const registry = new Map<string, string>()

  const multi = env.OAT_COLLECTOR_TOKENS
  if (multi) {
    for (const pair of multi.split(',')) {
      const trimmed = pair.trim()
      if (!trimmed) continue
      // The token itself may contain ':' — split on the FIRST colon only.
      const idx = trimmed.indexOf(':')
      if (idx <= 0) continue
      const id = trimmed.slice(0, idx).trim()
      const token = trimmed.slice(idx + 1)
      if (id && token) registry.set(id, token)
    }
  }

  const singleId = env.OAT_COLLECTOR_ID?.trim()
  const singleToken = env.OAT_COLLECTOR_TOKEN
  if (singleId && singleToken && !registry.has(singleId)) registry.set(singleId, singleToken)

  return registry
}

/** Compare without leaking length or content through timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export type CollectorDecision = { ok: true; collectorId: string } | { ok: false; status: 401 | 503; error: string }

/**
 * Decide whether a collector request is authorised.
 *
 * Fail-closed: an empty registry → `503` (endpoint disabled, never open); a missing/wrong token
 * → `401`. An unknown id still runs a constant-time compare against a placeholder, so a bad id
 * and a bad token are indistinguishable by timing — the endpoint is not an id-enumeration oracle.
 */
export function checkCollectorToken(
  env: Record<string, string | undefined>,
  collectorIdHeader: string | null,
  authHeader: string | null,
): CollectorDecision {
  const registry = resolveCollectorTokens(env)
  if (registry.size === 0) {
    return {
      ok: false,
      status: 503,
      error: 'OAT_COLLECTOR_TOKENS is not configured; the collector ingest endpoint is disabled',
    }
  }

  const collectorId = collectorIdHeader?.trim() ?? ''
  const header = authHeader ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''

  const expected = registry.get(collectorId)
  const matches = constantTimeEqual(presented, expected ?? '\0invalid-placeholder')

  if (expected === undefined || !matches) {
    return { ok: false, status: 401, error: 'Unauthorised' }
  }

  return { ok: true, collectorId }
}
