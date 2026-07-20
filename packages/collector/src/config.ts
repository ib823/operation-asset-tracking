import { osqueryConfigFromEnv, snmpConfigFromEnv, type OsqueryConfig, type SnmpConfig } from '@oat/connectors'

/**
 * Collector configuration — environment only (ADR-0021 / CLAUDE.md).
 *
 * A collector runs on customer hardware on the LAN. Every secret and every target comes from
 * the environment; nothing is read from disk, committed, or logged. This module is the ONE
 * place env is parsed, so "what does this collector do" is answerable by reading it.
 */

/** The outbound channel's destination and identity. Required to push anything. */
export interface ChannelConfig {
  /** Cloud OAT base URL, e.g. https://oat.lablink.example. Outbound HTTPS only. */
  oatUrl: string
  /** This collector's stable id, so signals are attributable to a site's collector. */
  collectorId: string
  /** Per-collector bearer. Fail-closed: absent means the collector cannot push. Never logged. */
  token: string
}

export interface CollectorModulesConfig {
  snmp: SnmpConfig | null
  osquery: OsqueryConfig | null
  /** Subnet sweep target (Phase 3). A CIDR to probe for identity hints — never creates assets. */
  sweepCidr: string | null
}

export interface CollectorConfig {
  channel: ChannelConfig | null
  modules: CollectorModulesConfig
  /** How often the collect→push loop runs, in ms. */
  pollIntervalMs: number
  /** SNMP community, for the SNMP module. */
  snmpCommunity: string | null
}

/** Default cadence: 15 minutes, matching the SNMP/osquery adapters' declared interval. */
export const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000

function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]
  return raw === '1' || raw?.toLowerCase() === 'true'
}

/**
 * Parse the channel config, or null when it is incomplete.
 *
 * All three fields are required together: a URL with no token, or a token with no URL, is a
 * misconfiguration, not a partial mode. Returning null (rather than a half-built object) makes
 * the caller decide loudly what to do about a collector that cannot reach OAT.
 */
export function channelFromEnv(env: NodeJS.ProcessEnv = process.env): ChannelConfig | null {
  const oatUrl = env.OAT_URL?.trim()
  const collectorId = env.OAT_COLLECTOR_ID?.trim()
  const token = env.OAT_COLLECTOR_TOKEN

  if (!oatUrl || !collectorId || !token) return null

  return { oatUrl, collectorId, token }
}

/**
 * Assemble the whole collector config from the environment.
 *
 * Module configs reuse the connectors' own env parsers (`snmpConfigFromEnv`,
 * `osqueryConfigFromEnv`) so a collector and the cloud worker read SNMP targets and Fleet
 * settings identically — one parser, not two that drift.
 */
export function loadCollectorConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  const intervalRaw = Number(env.OAT_COLLECTOR_POLL_INTERVAL_MS)
  const pollIntervalMs = Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : DEFAULT_POLL_INTERVAL_MS

  return {
    channel: channelFromEnv(env),
    pollIntervalMs,
    snmpCommunity: env.OAT_SNMP_COMMUNITY?.trim() || null,
    modules: {
      // SNMP and osquery modules are enabled by their connector flag AND a usable target
      // config. A flag with no targets configures nothing — the honest "not deployed" state.
      snmp: envFlag(env, 'OAT_CONNECTOR_SNMP') ? snmpConfigFromEnv(env) : null,
      osquery: envFlag(env, 'OAT_CONNECTOR_OSQUERY') ? osqueryConfigFromEnv(env) : null,
      sweepCidr: envFlag(env, 'OAT_COLLECTOR_SWEEP') ? env.OAT_COLLECTOR_SWEEP_CIDR?.trim() || null : null,
    },
  }
}

/** Which modules are actually configured (flag on AND a usable target). */
export function enabledModules(config: CollectorConfig): string[] {
  const on: string[] = []
  if (config.modules.snmp) on.push('snmp')
  if (config.modules.osquery) on.push('osquery')
  if (config.modules.sweepCidr) on.push('sweep')
  return on
}

/**
 * Reasons this collector cannot yet do useful work. Empty means ready.
 *
 * Reported at startup rather than discovered by silence: a collector that cannot reach OAT, or
 * has no module configured, should say so, not sit quietly looking healthy (the failure mode
 * ADR-0020 calls out for the scheduler).
 */
export function configProblems(config: CollectorConfig): string[] {
  const problems: string[] = []
  if (!config.channel) {
    problems.push('No outbound channel: set OAT_URL, OAT_COLLECTOR_ID and OAT_COLLECTOR_TOKEN.')
  }
  if (enabledModules(config).length === 0) {
    problems.push(
      'No collection module configured: enable OAT_CONNECTOR_SNMP / OAT_CONNECTOR_OSQUERY / OAT_COLLECTOR_SWEEP with targets.',
    )
  }
  return problems
}
