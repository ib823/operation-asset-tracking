import { beforeEach, describe, expect, it } from 'vitest'
import { clearRateLimit, rateLimit, resetRateLimits, SIGN_IN_LIMIT } from './rate-limit'

const NOW = Date.now()
const options = { max: 3, windowMinutes: 15 }

beforeEach(resetRateLimits)

describe('rateLimit', () => {
  it('allows attempts up to the limit', () => {
    for (let i = 0; i < options.max; i++) {
      expect(rateLimit('a@x', options, NOW).allowed, `attempt ${i + 1}`).toBe(true)
    }
  })

  it('blocks the attempt AFTER the limit', () => {
    for (let i = 0; i < options.max; i++) rateLimit('a@x', options, NOW)

    const result = rateLimit('a@x', options, NOW)
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('counts keys independently — one user cannot lock out another', () => {
    for (let i = 0; i < options.max + 2; i++) rateLimit('victim@x', options, NOW)

    expect(rateLimit('someone-else@x', options, NOW).allowed).toBe(true)
  })

  it('reopens once the window passes', () => {
    for (let i = 0; i < options.max + 1; i++) rateLimit('a@x', options, NOW)
    expect(rateLimit('a@x', options, NOW).allowed).toBe(false)

    const later = NOW + options.windowMinutes * 60_000 + 1000
    expect(rateLimit('a@x', options, later).allowed).toBe(true)
  })

  it('reports how long until the window resets', () => {
    for (let i = 0; i < options.max + 1; i++) rateLimit('a@x', options, NOW)

    const midway = NOW + 10 * 60_000
    const result = rateLimit('a@x', options, midway)
    // 15-minute window, 10 minutes elapsed → ~5 remaining.
    expect(result.retryAfterSeconds).toBeGreaterThan(4 * 60)
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(5 * 60)
  })

  it('clears on success, so a fat-fingered password does not lock out its own owner', () => {
    rateLimit('a@x', options, NOW)
    rateLimit('a@x', options, NOW)

    clearRateLimit('a@x')

    // Full budget again.
    for (let i = 0; i < options.max; i++) {
      expect(rateLimit('a@x', options, NOW).allowed).toBe(true)
    }
  })

  it('does not grow without bound when an attacker rotates the key', () => {
    // A defence that can be turned into memory exhaustion is an embarrassing way to be taken
    // down by the thing meant to protect you.
    for (let i = 0; i < 20_000; i++) rateLimit(`key-${i}`, options, NOW)

    // Still functioning, not wedged or exhausted.
    expect(rateLimit('a-real-user@x', options, NOW).allowed).toBe(true)
  })

  it('ships a limit that tolerates a typo but not a spray', () => {
    // 10 in 15 minutes: nobody types their own password wrong ten times; a word list needs
    // far more than ten.
    expect(SIGN_IN_LIMIT.max).toBeGreaterThanOrEqual(5)
    expect(SIGN_IN_LIMIT.max).toBeLessThanOrEqual(20)
    expect(SIGN_IN_LIMIT.windowMinutes).toBeGreaterThanOrEqual(5)
  })
})
