import type { RawSignal, SignalInput } from '@oat/core'
import snmp from 'net-snmp'
import { z } from 'zod'
import type { Connector } from './types'

/**
 * SNMP connector: network printers and infrastructure.
 *
 * Exercised against a real `snmpd` (see `snmp.integration.test.ts`), not only a mock — SNMP
 * has enough protocol quirks (counter wraps, noSuchObject, agents that answer some OIDs and
 * not others) that testing against my own assumptions would prove very little.
 *
 * What counts as ACTIVITY here is the interesting part. A printer answering an SNMP walk is
 * reachable, not busy — that is presence, and treating it as use would be the ADR-0008
 * failure exactly. Real activity is the **page counter moving**: a printer that printed a
 * page since the last poll did work; one whose counter is unchanged did not, however
 * cheerfully it answers.
 */

/** Standard OIDs. RFC 1213 (MIB-II) and RFC 3805 (Printer MIB), which any conformant agent answers. */
export const OIDS = {
  /** sysDescr — device description. */
  sysDescr: '1.3.6.1.2.1.1.1.0',
  /** sysUpTime — hundredths of a second since boot. */
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  /** sysName — the device's own name. */
  sysName: '1.3.6.1.2.1.1.5.0',
  /** prtMarkerLifeCount — lifetime page count. The only real evidence a printer did work. */
  pageCount: '1.3.6.1.2.1.43.10.2.1.4.1.1',
} as const

export interface SnmpTarget {
  /** Asset tag, so the pipeline can resolve the device without guessing. */
  assetRef: string
  host: string
  port?: number
  community?: string
}

export interface SnmpConfig {
  targets: SnmpTarget[]
  community?: string
  timeoutMs?: number
  retries?: number
}

/** A device reading, before normalisation. */
export const SnmpReading = z.object({
  assetRef: z.string(),
  sysName: z.string().optional(),
  sysDescr: z.string().optional(),
  /** Hundredths of a second since boot. */
  upTimeTicks: z.number().optional(),
  /** Lifetime page count, when the agent exposes the Printer MIB. */
  pageCount: z.number().optional(),
  observedAt: z.coerce.date(),
})
export type SnmpReading = z.infer<typeof SnmpReading>

/** What `net-snmp` hands back. Its own `Varbind` type is imported rather than restated. */
type Varbind = snmp.Varbind

export class SnmpConnector implements Connector {
  readonly id = 'snmp' as const

  /**
   * A 15-minute sweep. Slow on purpose: SNMP is chatty on the wire and printers are bursty,
   * so there is nothing to learn from polling one every minute.
   *
   * Drives the coverage gap (ADR-0018) — three missed sweeps is an outage.
   */
  readonly pollIntervalMinutes = 15

  private readonly config: SnmpConfig
  /**
   * Last page count per device, so a poll can tell "printed since we last looked" from
   * "reachable". Held in memory: on restart the first poll for each device establishes a
   * baseline and claims no activity, which is the honest answer — we genuinely do not know
   * what happened while we were not running.
   */
  private readonly lastPageCount = new Map<string, number>()

  constructor(config: SnmpConfig) {
    this.config = { community: 'public', timeoutMs: 5_000, retries: 1, ...config }
  }

  async poll(): Promise<RawSignal[]> {
    // Sequential, not parallel: a sweep across 32 sites' printers should not open hundreds
    // of concurrent UDP sessions, and there is no deadline pressure on a 15-minute poll.
    const raws: RawSignal[] = []

    for (const target of this.config.targets) {
      try {
        const reading = await this.read(target)
        raws.push({ externalRef: target.assetRef, observedAt: reading.observedAt, payload: reading })
      } catch {
        // One unreachable printer must not fail the sweep. Its silence becomes reduced
        // coverage (ADR-0015/0018) — which is the correct reading of "we could not see it",
        // and far better than the sweep aborting and losing the devices that did answer.
        continue
      }
    }

    return raws
  }

  normalise(raw: RawSignal, assetId: string): SignalInput {
    const reading = SnmpReading.parse(raw.payload)

    const previous = this.lastPageCount.get(reading.assetRef)
    const current = reading.pageCount

    if (typeof current === 'number') this.lastPageCount.set(reading.assetRef, current)

    // Did it print since we last looked?
    //
    // `previous === undefined` is the first sight of this device: we have no baseline, so we
    // claim nothing. A counter that went BACKWARDS means the printer was reset or the
    // counter wrapped — also not evidence of work, and guessing at the delta would invent
    // activity from a reboot.
    const printedSinceLastPoll = typeof current === 'number' && typeof previous === 'number' && current > previous

    if (printedSinceLastPoll) {
      return {
        assetId,
        source: 'snmp',
        type: 'utilisation',
        value: { busy: true },
        observedAt: reading.observedAt,
        dedupeKey: `snmp:${reading.assetRef}:${reading.observedAt.toISOString()}`,
      }
    }

    // Reachable but no work done. Presence only — a printer answering a walk is not a
    // printer printing (ADR-0008).
    return {
      assetId,
      source: 'snmp',
      type: 'heartbeat',
      value: {},
      observedAt: reading.observedAt,
      dedupeKey: `snmp:${reading.assetRef}:${reading.observedAt.toISOString()}`,
    }
  }

  /** Read one device. Rejects when the agent is unreachable or answers nothing usable. */
  private read(target: SnmpTarget): Promise<SnmpReading> {
    return new Promise((resolve, reject) => {
      const session = snmp.createSession(target.host, target.community ?? this.config.community ?? 'public', {
        port: target.port ?? 161,
        timeout: this.config.timeoutMs,
        retries: this.config.retries,
        /**
         * v2c, explicitly — net-snmp defaults to v1, and the difference is not cosmetic.
         *
         * Under v1 an agent that lacks ONE requested OID fails the WHOLE request with
         * noSuchName. We ask every device for the printer page counter, which a switch (or
         * any non-printer) does not have, so under v1 every such device read as unreachable
         * and reported nothing at all.
         *
         * v2c reports the absence per varbind, leaving the rest of the reading intact.
         * Caught by testing against a real snmpd; a mock built from my own assumptions would
         * have agreed with me.
         */
        version: snmp.Version2c,
      })

      const oids = [OIDS.sysDescr, OIDS.sysUpTime, OIDS.sysName, OIDS.pageCount]

      session.get(oids, (error: Error | null, varbinds?: Varbind[]) => {
        try {
          if (error) return reject(new SnmpError(`${target.host}: ${error.message}`))

          const found = new Map<string, unknown>()
          for (const vb of varbinds ?? []) {
            // A conformant agent answers with noSuchObject/noSuchInstance rather than an
            // error when it lacks an OID — a printer MIB is absent on a switch, and that is
            // normal, not a failure.
            if (snmp.isVarbindError(vb)) continue
            found.set(vb.oid, vb.value)
          }

          if (found.size === 0) return reject(new SnmpError(`${target.host}: no readable OIDs`))

          resolve(
            SnmpReading.parse({
              assetRef: target.assetRef,
              sysDescr: str(found.get(OIDS.sysDescr)),
              sysName: str(found.get(OIDS.sysName)),
              upTimeTicks: num(found.get(OIDS.sysUpTime)),
              pageCount: num(found.get(OIDS.pageCount)),
              observedAt: new Date(),
            }),
          )
        } finally {
          session.close()
        }
      })
    })
  }
}

export class SnmpError extends Error {
  constructor(message: string) {
    super(`SNMP read failed: ${message}`)
    this.name = 'SnmpError'
  }
}

/** net-snmp returns OctetStrings as Buffers. */
function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
}

function num(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Read SNMP targets from the environment, or null when not configured.
 *
 * Null falls back to the mock: a deployment with no SNMP devices is supported, not an error.
 * Format: `TAG@host[:port]`, comma-separated — e.g. `LAB-0005@10.1.2.3,LAB-0011@10.1.2.4:1161`.
 */
export function snmpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SnmpConfig | null {
  const raw = env.OAT_SNMP_TARGETS
  if (!raw) return null

  const targets: SnmpTarget[] = []
  for (const entry of raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const [assetRef, hostPort] = entry.split('@')
    if (!assetRef || !hostPort) continue

    const [host, port] = hostPort.split(':')
    if (!host) continue

    targets.push({
      assetRef,
      host,
      ...(port && Number.isFinite(Number(port)) ? { port: Number(port) } : {}),
    })
  }

  if (targets.length === 0) return null

  return {
    targets,
    ...(env.OAT_SNMP_COMMUNITY ? { community: env.OAT_SNMP_COMMUNITY } : {}),
  }
}
