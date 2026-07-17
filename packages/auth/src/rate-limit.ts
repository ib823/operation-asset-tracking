/**
 * Sign-in rate limiting (RFP §5.x).
 *
 * Without it, sign-in is an unbounded guessing oracle. Argon2/scrypt makes each attempt cost
 * ~400ms, which is a speed bump, not a limit: an attacker with a modest word list and a
 * weekend still gets tens of thousands of tries against a known email — and this estate's
 * users are named `firstname@lablink.example`, so the email half is not a secret.
 *
 * Deliberately IN-MEMORY, per process, and deliberately not Redis. See ADR-0023:
 *
 *   - ADR-0005 rejected Redis as a datastore we would have to run, secure and back up. That
 *     reasoning has not changed for a counter with a 15-minute memory.
 *   - Postgres could hold it, but a write per failed sign-in is a free amplification: an
 *     attacker generates our database load for us.
 *
 * The cost is honest and worth stating: with N app replicas an attacker gets N× the attempts,
 * and a restart forgets everything. This is a speed bump sized for opportunistic guessing,
 * not a defence against a determined distributed attack. That defence is the load balancer's
 * job (A5) and belongs in front of the app. What this stops is the single-source password
 * spray, which is what actually happens.
 */

export interface RateLimitOptions {
  /** Attempts allowed inside the window. */
  max: number
  windowMinutes: number
}

/** OWASP-ish: enough that a fat-fingered password never trips it, few enough to be useless. */
export const SIGN_IN_LIMIT: RateLimitOptions = { max: 10, windowMinutes: 15 }

interface Bucket {
  count: number
  /** When the window opened. */
  since: number
}

const buckets = new Map<string, Bucket>()

/**
 * How many entries to hold before pruning.
 *
 * An attacker who rotates the key on every attempt would otherwise grow this map without
 * bound — turning a defence into a memory-exhaustion vector, which would be an embarrassing
 * way to be taken down by the thing meant to protect you.
 */
const MAX_BUCKETS = 10_000

function prune(now: number, windowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.since > windowMs) buckets.delete(key)
  }

  // Still too many after dropping the expired: the map is under attack rather than merely
  // busy. Drop it entirely — losing counters fails OPEN for a moment, which is the right way
  // round: a rate limiter must never become the outage.
  if (buckets.size > MAX_BUCKETS) buckets.clear()
}

export interface RateLimitResult {
  allowed: boolean
  /** Attempts left in this window. */
  remaining: number
  /** Seconds until the window resets, for a Retry-After header. */
  retryAfterSeconds: number
}

/**
 * Count an attempt against `key` and say whether it may proceed.
 *
 * Call this for EVERY attempt, not only failures: counting failures alone lets an attacker
 * interleave a known-good credential to keep their bucket clear.
 */
export function rateLimit(
  key: string,
  options: RateLimitOptions = SIGN_IN_LIMIT,
  now: number = Date.now(),
): RateLimitResult {
  const windowMs = options.windowMinutes * 60_000
  prune(now, windowMs)

  const existing = buckets.get(key)

  if (!existing || now - existing.since > windowMs) {
    buckets.set(key, { count: 1, since: now })
    return { allowed: true, remaining: options.max - 1, retryAfterSeconds: 0 }
  }

  existing.count++

  const elapsed = now - existing.since
  const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - elapsed) / 1000))

  if (existing.count > options.max) {
    return { allowed: false, remaining: 0, retryAfterSeconds }
  }

  return { allowed: true, remaining: options.max - existing.count, retryAfterSeconds }
}

/** Clear a key's counter — called on a SUCCESSFUL sign-in, so a legitimate user who
 *  fat-fingered their password twice is not then locked out by their own success. */
export function clearRateLimit(key: string): void {
  buckets.delete(key)
}

/** For tests. */
export function resetRateLimits(): void {
  buckets.clear()
}
