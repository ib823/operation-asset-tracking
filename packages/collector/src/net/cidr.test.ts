import { describe, expect, it } from 'vitest'
import { CidrError, enumerateHosts, MAX_SWEEP_HOSTS } from './cidr'

describe('enumerateHosts', () => {
  it('lists usable hosts in a /30, excluding network and broadcast', () => {
    // 10.1.2.0/30 = .0 network, .1 .2 hosts, .3 broadcast.
    expect(enumerateHosts('10.1.2.0/30')).toEqual(['10.1.2.1', '10.1.2.2'])
  })

  it('returns both addresses of a /31 (point-to-point, RFC 3021)', () => {
    expect(enumerateHosts('10.1.2.4/31')).toEqual(['10.1.2.4', '10.1.2.5'])
  })

  it('returns the single host of a /32', () => {
    expect(enumerateHosts('10.1.2.7/32')).toEqual(['10.1.2.7'])
  })

  it('enumerates a /24 as 254 usable hosts', () => {
    const hosts = enumerateHosts('192.168.0.0/24')
    expect(hosts).toHaveLength(254)
    expect(hosts[0]).toBe('192.168.0.1')
    expect(hosts.at(-1)).toBe('192.168.0.254')
  })

  it('normalises a non-aligned base to its network', () => {
    // .5/30 still describes the .4–.7 block.
    expect(enumerateHosts('10.1.2.5/30')).toEqual(['10.1.2.5', '10.1.2.6'])
  })

  it('rejects a range wider than the host limit rather than fanning out', () => {
    // /8 is 16M hosts — almost always a typo, never an intent.
    expect(() => enumerateHosts('10.0.0.0/8')).toThrow(CidrError)
    expect(() => enumerateHosts(`10.0.0.0/8`)).toThrow(/over the .* limit/)
  })

  it('honours a custom, smaller host limit', () => {
    expect(() => enumerateHosts('10.1.0.0/23', 100)).toThrow(CidrError)
    expect(enumerateHosts('10.1.2.0/29', 100)).toHaveLength(6)
  })

  it.each([['not-an-ip'], ['10.1.2.0'], ['10.1.2.0/33'], ['10.1.2.999/24'], ['10.1.2.0/-1']])(
    'throws CidrError on malformed input %s',
    (bad) => {
      expect(() => enumerateHosts(bad)).toThrow(CidrError)
    },
  )

  it('exposes a sane default host ceiling', () => {
    expect(MAX_SWEEP_HOSTS).toBeGreaterThanOrEqual(256)
  })
})
