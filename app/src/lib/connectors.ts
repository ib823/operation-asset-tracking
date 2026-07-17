/**
 * Connector resolution, re-exported from `@oat/jobs`.
 *
 * The scheduler and the manual API endpoints must resolve connectors IDENTICALLY — if the
 * hand-triggered poll and the scheduled one could pick different adapters, a demo would
 * prove nothing about production. One implementation, two callers.
 */
export {
  connectorCoverageGaps,
  enabledActivitySources,
  osqueryConnector,
  snmpConnector,
  sotiConnector,
} from '@oat/jobs'
