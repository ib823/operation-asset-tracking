import type { RawSignal, SignalInput, SignalSource } from '@oat/core'

/**
 * A pluggable signal adapter.
 *
 * Every connector is optional and independently deployable. The register must remain fully
 * usable with all of them disabled — see the graceful-degradation requirement in CLAUDE.md.
 *
 * `poll` and `ingest` are both optional because sources differ in shape: an MDM is polled,
 * a scanner pushes. A connector implements whichever it is.
 */
export interface Connector {
  readonly id: SignalSource
  /**
   * How often this connector reports, in minutes.
   *
   * Drives the per-source coverage gap in the utilisation rollup (ADR-0018): a silence longer
   * than a few poll intervals is an outage, and an outage is UNOBSERVED time, not idleness.
   * One global gap cannot serve both a 5-minute MDM and an hourly SNMP sweep — the first
   * would hide real outages, the second would read a normal quiet period as one.
   *
   * Declared by the adapter because only the adapter knows its own cadence.
   */
  readonly pollIntervalMinutes: number
  /** Pull from the source. For connectors we poll on a schedule. */
  poll?(): Promise<RawSignal[]>
  /** Accept a pushed payload (webhook, scan submission). */
  ingest?(payload: unknown): Promise<RawSignal[]>
  /** Turn a raw observation into a signal, given the resolved OAT asset id. */
  normalise(raw: RawSignal, assetId: string): SignalInput
}

/**
 * Feature flags. Every connector is off unless explicitly enabled — a connector that has
 * not been configured for this deployment must not start polling a system that is not there.
 */
export interface ConnectorFlags {
  scan: boolean
  soti: boolean
  osquery: boolean
  snmp: boolean
  lis: boolean
}

export const DEFAULT_CONNECTOR_FLAGS: ConnectorFlags = {
  // Scan is the fallback floor: manual/barcode capture is how the register stays usable
  // when every automated source is off, so it defaults on.
  scan: true,
  soti: false,
  osquery: false,
  snmp: false,
  lis: false,
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

export function resolveConnectorFlags(env: NodeJS.ProcessEnv = process.env): ConnectorFlags {
  void env
  return {
    scan: envFlag('OAT_CONNECTOR_SCAN', DEFAULT_CONNECTOR_FLAGS.scan),
    soti: envFlag('OAT_CONNECTOR_SOTI', DEFAULT_CONNECTOR_FLAGS.soti),
    osquery: envFlag('OAT_CONNECTOR_OSQUERY', DEFAULT_CONNECTOR_FLAGS.osquery),
    snmp: envFlag('OAT_CONNECTOR_SNMP', DEFAULT_CONNECTOR_FLAGS.snmp),
    lis: envFlag('OAT_CONNECTOR_LIS', DEFAULT_CONNECTOR_FLAGS.lis),
  }
}
