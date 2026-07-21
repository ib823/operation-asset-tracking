import {
  collectUnresolved,
  MockOsqueryConnector,
  OsqueryConnector,
  type Connector,
  type OsqueryConfig,
  type OsqueryReading,
  type UnresolvedSignal,
} from '@oat/connectors'
import type { CollectModule } from './types'

/**
 * osquery/Fleet collection module.
 *
 * Reuses the shared `OsqueryConnector` against Fleet's REST API when `OAT_FLEET_*` is set, and
 * the `MockOsqueryConnector` otherwise — a Fleet instance is a client dependency (C6), and a
 * collector without one is a supported configuration, not an error. Same contract either way,
 * so which is in play is the only thing that changes.
 *
 * Activity here is OS-level user idle (never uptime, ADR-0008); the connector owns that rule.
 */
export class OsqueryModule implements CollectModule {
  readonly id = 'osquery'
  readonly mode: 'real' | 'mock'
  private readonly connector: Connector

  constructor(config: OsqueryConfig | null, mockReadings: OsqueryReading[] = []) {
    if (config) {
      this.connector = new OsqueryConnector(config)
      this.mode = 'real'
    } else {
      this.connector = new MockOsqueryConnector(mockReadings)
      this.mode = 'mock'
    }
  }

  async collect(): Promise<UnresolvedSignal[]> {
    const raws = this.connector.poll ? await this.connector.poll() : []
    return collectUnresolved(this.connector, raws)
  }
}
