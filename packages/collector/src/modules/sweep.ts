import { SnmpConnector } from '@oat/connectors'
import { enumerateHosts, MAX_SWEEP_HOSTS } from '../net/cidr'

/**
 * Subnet sweep — identity hints only, never an asset (ADR-0021).
 *
 * The sweep answers one question: "what is alive on this subnet, and how does it identify
 * itself?" It is the weakest module by design: it emits **no signals**, claims **no activity**
 * (presence is not use, ADR-0008), and — because it produces plain data with no database in
 * reach — has **no path to create an asset**. Its output is a discovery worklist: a hint whose
 * identity matches a known asset can seed an SNMP target; a hint that matches nothing is
 * surfaced to a human, never written to the register.
 *
 * This is exactly the ServiceNow "horizontal discovery" role: find candidates, hand them to
 * identification, let the IRE decide. It never decides itself.
 */

/** A device answered at `address` and told us this about itself. Not a signal; a lead. */
export interface SweepHint {
  address: string
  sysName?: string
  sysDescr?: string
}

/**
 * Probe one host for an identity, or null if nothing answered.
 *
 * Injected so the sweep can be tested deterministically and so the transport (SNMP here) is a
 * choice, not a hard-coded assumption.
 */
export type HostProbe = (host: string) => Promise<Omit<SweepHint, 'address'> | null>

export interface SweepOptions {
  /** Max hosts to enumerate from the CIDR. Guards against a fat mask (default {@link MAX_SWEEP_HOSTS}). */
  maxHosts?: number
  /** How many hosts to probe at once. Bounded so a sweep does not flood the LAN. */
  concurrency?: number
}

/**
 * A default probe that asks a host for its SNMP identity (sysName/sysDescr).
 *
 * Reuses `SnmpConnector` rather than opening a second SNMP path — the sweep discovers exactly
 * the devices the SNMP module can then poll. A short timeout and no retries: a sweep visits
 * many hosts and most will not answer, so it must fail fast on silence.
 */
export function snmpIdentityProbe(community?: string, timeoutMs = 800): HostProbe {
  return async (host) => {
    const connector = new SnmpConnector({
      targets: [{ assetRef: host, host, ...(community ? { community } : {}) }],
      timeoutMs,
      retries: 0,
    })
    const raws = await connector.poll()
    if (raws.length === 0) return null
    const reading = raws[0]!.payload as { sysName?: string; sysDescr?: string }
    return {
      ...(reading.sysName ? { sysName: reading.sysName } : {}),
      ...(reading.sysDescr ? { sysDescr: reading.sysDescr } : {}),
    }
  }
}

export class SweepModule {
  readonly id = 'sweep'
  private readonly maxHosts: number
  private readonly concurrency: number

  constructor(
    private readonly cidr: string,
    private readonly probe: HostProbe,
    options: SweepOptions = {},
  ) {
    this.maxHosts = options.maxHosts ?? MAX_SWEEP_HOSTS
    this.concurrency = Math.max(1, options.concurrency ?? 32)
  }

  /**
   * Sweep the configured CIDR and return identity hints for hosts that answered.
   *
   * Returns hints, not signals — there is deliberately no `collect()` here. A caller cannot
   * turn this output into a register write except by pushing an `externalRef` through the
   * cloud's `ingestUnresolved`, which reports the unknown and never creates it.
   */
  async discover(): Promise<SweepHint[]> {
    const hosts = enumerateHosts(this.cidr, this.maxHosts)
    const hints: SweepHint[] = []

    // Probe in bounded batches: a subnet sweep that opened a socket per host at once would be
    // indistinguishable from a scan an IDS should flag, and would hammer the LAN it lives on.
    for (let i = 0; i < hosts.length; i += this.concurrency) {
      const batch = hosts.slice(i, i + this.concurrency)
      const results = await Promise.all(
        batch.map(async (host) => {
          try {
            const identity = await this.probe(host)
            return identity ? ({ address: host, ...identity } satisfies SweepHint) : null
          } catch {
            // A host that errors is simply a host that did not answer. Silence is the norm.
            return null
          }
        }),
      )
      for (const hint of results) if (hint) hints.push(hint)
    }

    return hints
  }
}
