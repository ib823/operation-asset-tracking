import {
  coverageGaps,
  MockSotiConnector,
  resolveConnectorFlags,
  SotiConnector,
  sotiConfigFromEnv,
  type Connector,
  type SotiDeviceReport,
} from '@oat/connectors'
import type { CoverageGaps, SignalSource } from '@oat/core'

/**
 * Resolve the SOTI connector for this deployment.
 *
 * The real adapter when a tenant is configured; the mock otherwise. Both implement the same
 * contract, so this is the only place that knows which is in play — and getting a real SOTI
 * tenant is a Lablink/vendor dependency, not a build task.
 */
export function sotiConnector(mockReports: SotiDeviceReport[] = []): { connector: Connector; mode: 'real' | 'mock' } {
  const config = sotiConfigFromEnv()
  if (config) return { connector: new SotiConnector(config), mode: 'real' }

  return { connector: new MockSotiConnector(mockReports), mode: 'mock' }
}

/**
 * Which sources may currently evidence activity, estate-wide.
 *
 * Drives rollup eligibility (ADR-0015): a class is only rolled up if a connector feeding it
 * is actually deployed. Derived from the feature flags, so instruments begin rolling up the
 * day the LIS is enabled — no code change, no forgotten flag.
 *
 * `scan` is excluded deliberately: it is presence and assertion, never activity evidence.
 */
/**
 * How long a silence from each source still counts as coverage (ADR-0018).
 *
 * Derived from each adapter's declared poll interval. The app supplies this to the rollup
 * because `core` must not import `connectors` (ADR-0002) — the domain does not get to know
 * what an MDM is.
 */
export function connectorCoverageGaps(): CoverageGaps {
  return coverageGaps()
}

export function enabledActivitySources(): SignalSource[] {
  const flags = resolveConnectorFlags()
  const sources: SignalSource[] = []

  if (flags.soti) sources.push('soti')
  if (flags.osquery) sources.push('osquery')
  if (flags.snmp) sources.push('snmp')
  if (flags.lis) sources.push('lis')

  return sources
}
