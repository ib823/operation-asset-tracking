/**
 * IPv4 CIDR enumeration for the subnet sweep (ADR-0021).
 *
 * A sweep discovers *identity hints* — "something answers at 10.1.2.7" — which are matched
 * against the register like any other reference. It never creates an asset. This module only
 * turns a CIDR into the host addresses to probe; it opens no sockets and makes no decisions.
 */

/** Hard ceiling on hosts enumerated from one CIDR, so a fat mask cannot fan out unboundedly. */
export const MAX_SWEEP_HOSTS = 1024

export class CidrError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CidrError'
  }
}

function parseOctets(ip: string): number[] {
  const parts = ip.split('.')
  if (parts.length !== 4) throw new CidrError(`Not an IPv4 address: ${ip}`)
  const octets = parts.map((p) => {
    if (!/^\d{1,3}$/.test(p)) throw new CidrError(`Not an IPv4 address: ${ip}`)
    const n = Number(p)
    if (n > 255) throw new CidrError(`Octet out of range in ${ip}`)
    return n
  })
  return octets
}

function toInt(octets: number[]): number {
  // >>> 0 keeps it an unsigned 32-bit value; a plain shift would go negative at the top bit.
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0
}

function toIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.')
}

/**
 * Enumerate the *host* addresses in a CIDR block, excluding network and broadcast for masks
 * that have them (/31 and /32 are returned as-is, per RFC 3021 / single-host convention).
 *
 * Throws on a malformed CIDR or one wider than `MAX_SWEEP_HOSTS` — a sweep target is operator
 * config, and a `/8` is far more likely a typo than an intent to probe 16 million hosts.
 */
export function enumerateHosts(cidr: string, maxHosts: number = MAX_SWEEP_HOSTS): string[] {
  const [ip, prefixRaw] = cidr.trim().split('/')
  if (!ip || prefixRaw === undefined) throw new CidrError(`Not a CIDR (expected a.b.c.d/nn): ${cidr}`)

  const prefix = Number(prefixRaw)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32)
    throw new CidrError(`Invalid prefix length: /${prefixRaw}`)

  const base = toInt(parseOctets(ip))
  const hostBits = 32 - prefix
  const size = hostBits >= 32 ? 2 ** 32 : 2 ** hostBits

  // Count host addresses first, so an oversized range is rejected before we allocate for it.
  const hostCount = prefix >= 31 ? size : Math.max(0, size - 2)
  if (hostCount > maxHosts) {
    throw new CidrError(`CIDR ${cidr} spans ${hostCount} hosts, over the ${maxHosts} limit. Narrow the range.`)
  }

  const network = base & (hostBits >= 32 ? 0 : (0xffffffff << hostBits) >>> 0)
  const hosts: string[] = []

  if (prefix >= 31) {
    for (let i = 0; i < size; i++) hosts.push(toIp((network + i) >>> 0))
    return hosts
  }

  // Skip the network (first) and broadcast (last) addresses.
  for (let i = 1; i < size - 1; i++) hosts.push(toIp((network + i) >>> 0))
  return hosts
}
