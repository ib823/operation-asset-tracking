import type { UnresolvedSignal } from '@oat/connectors'
import type { CollectorConfig } from '../config'
import { OsqueryModule } from './osquery'
import { SnmpModule } from './snmp'
import { snmpIdentityProbe, SweepModule } from './sweep'
import type { CollectModule } from './types'

export * from './types'
export * from './snmp'
export * from './osquery'
export * from './sweep'

export interface BuiltModules {
  /** Signal-producing modules, in the order they will be collected. */
  collectors: CollectModule[]
  /** The subnet sweep, if configured. Discovery only — produces hints, never signals. */
  sweep: SweepModule | null
}

/**
 * Build the collection modules a config actually enables.
 *
 * A module appears only when its flag AND its targets are set (see `enabledModules`): a flag
 * with nothing to poll configures nothing. osquery is included only when Fleet is configured —
 * a collector has no reason to run the osquery mock in production, unlike the cloud worker
 * which uses it to keep the demo deterministic.
 */
export function buildModules(config: CollectorConfig): BuiltModules {
  const collectors: CollectModule[] = []

  if (config.modules.snmp) collectors.push(new SnmpModule(config.modules.snmp))
  if (config.modules.osquery) collectors.push(new OsqueryModule(config.modules.osquery))

  const sweep = config.modules.sweepCidr
    ? new SweepModule(config.modules.sweepCidr, snmpIdentityProbe(config.snmpCommunity ?? undefined))
    : null

  return { collectors, sweep }
}

/**
 * Run every collector module and gather the signals.
 *
 * A module that throws is logged and skipped, not fatal: graceful degradation is a hard
 * requirement (CLAUDE.md). One printer subnet being unreachable must not stop the osquery
 * module from reporting, and vice versa.
 */
export async function collectAll(
  collectors: readonly CollectModule[],
  onError: (moduleId: string, error: unknown) => void = () => {},
): Promise<UnresolvedSignal[]> {
  const all: UnresolvedSignal[] = []
  for (const module of collectors) {
    try {
      all.push(...(await module.collect()))
    } catch (error) {
      onError(module.id, error)
    }
  }
  return all
}
