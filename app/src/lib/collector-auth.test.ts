import { describe, expect, it } from 'vitest'
import { checkCollectorToken, constantTimeEqual, resolveCollectorTokens } from './collector-auth'

/**
 * The collector ingest endpoint is a machine door into the operational layer. These tests pin
 * that it fails closed, that a wrong token or unknown id is a flat 401, and that the registry
 * parses per-collector tokens correctly.
 */

describe('resolveCollectorTokens', () => {
  it('parses a multi-collector registry', () => {
    const reg = resolveCollectorTokens({ OAT_COLLECTOR_TOKENS: 'collector-hq:tokA,collector-pj:tokB' })
    expect(reg.get('collector-hq')).toBe('tokA')
    expect(reg.get('collector-pj')).toBe('tokB')
    expect(reg.size).toBe(2)
  })

  it('keeps a token that itself contains a colon (splits on the first only)', () => {
    const reg = resolveCollectorTokens({ OAT_COLLECTOR_TOKENS: 'c1:abc:def:ghi' })
    expect(reg.get('c1')).toBe('abc:def:ghi')
  })

  it('accepts the single-collector id+token pair', () => {
    const reg = resolveCollectorTokens({ OAT_COLLECTOR_ID: 'collector-hq', OAT_COLLECTOR_TOKEN: 'solo' })
    expect(reg.get('collector-hq')).toBe('solo')
  })

  it('does not let the single pair override an id already in the multi registry', () => {
    const reg = resolveCollectorTokens({
      OAT_COLLECTOR_TOKENS: 'collector-hq:fromMulti',
      OAT_COLLECTOR_ID: 'collector-hq',
      OAT_COLLECTOR_TOKEN: 'fromSingle',
    })
    expect(reg.get('collector-hq')).toBe('fromMulti')
  })

  it('is empty when nothing is configured', () => {
    expect(resolveCollectorTokens({}).size).toBe(0)
  })
})

describe('checkCollectorToken', () => {
  const ENV = { OAT_COLLECTOR_TOKENS: 'collector-hq:secret-token' }

  it('fails closed with 503 when the registry is empty', () => {
    const d = checkCollectorToken({}, 'collector-hq', 'Bearer secret-token')
    expect(d).toEqual({ ok: false, status: 503, error: expect.stringContaining('not configured') })
  })

  it('authorises a correct id + token', () => {
    expect(checkCollectorToken(ENV, 'collector-hq', 'Bearer secret-token')).toEqual({
      ok: true,
      collectorId: 'collector-hq',
    })
  })

  it('rejects a wrong token with 401', () => {
    expect(checkCollectorToken(ENV, 'collector-hq', 'Bearer WRONG')).toMatchObject({ ok: false, status: 401 })
  })

  it('rejects an unknown collector id with 401 (same shape as a wrong token — no id oracle)', () => {
    expect(checkCollectorToken(ENV, 'collector-ghost', 'Bearer secret-token')).toMatchObject({ ok: false, status: 401 })
  })

  it('rejects a missing Authorization header', () => {
    expect(checkCollectorToken(ENV, 'collector-hq', null)).toMatchObject({ ok: false, status: 401 })
  })

  it('rejects a non-Bearer scheme', () => {
    expect(checkCollectorToken(ENV, 'collector-hq', 'Basic secret-token')).toMatchObject({ ok: false, status: 401 })
  })
})

describe('constantTimeEqual', () => {
  it('is true only for equal strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
    expect(constantTimeEqual('', '')).toBe(true)
  })
})
