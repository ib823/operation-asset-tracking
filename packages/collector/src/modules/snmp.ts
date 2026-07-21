import { collectUnresolved, SnmpConnector, type SnmpConfig, type UnresolvedSignal } from '@oat/connectors'
import type { CollectModule } from './types'

/**
 * SNMP collection module.
 *
 * A thin wrapper over the shared `SnmpConnector` (RFC 3805 page-counter semantics, ADR-0008):
 * a rising `prtMarkerLifeCount` is work, a flat one is mere presence. The connector is held for
 * the module's lifetime **on purpose** — it carries the per-device page-count baseline in
 * memory, and the delta between consecutive polls is the only real evidence a printer printed.
 * That is why normalisation runs here on the LAN, next to the consecutive readings, rather than
 * in the stateless cloud endpoint (ADR-0021).
 */
export class SnmpModule implements CollectModule {
  readonly id = 'snmp'
  private readonly connector: SnmpConnector

  constructor(config: SnmpConfig) {
    this.connector = new SnmpConnector(config)
  }

  async collect(): Promise<UnresolvedSignal[]> {
    // `poll()` already swallows per-device errors (one unreachable printer must not fail the
    // sweep); `collectUnresolved` normalises with the exact same code the worker uses.
    const raws = await this.connector.poll()
    return collectUnresolved(this.connector, raws)
  }
}
