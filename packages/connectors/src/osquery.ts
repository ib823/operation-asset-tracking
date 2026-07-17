import type { RawSignal, SignalInput } from '@oat/core'
import { z } from 'zod'
import type { Connector } from './types'

/**
 * osquery / Fleet connector: desktops and laptops.
 *
 * Talks to Fleet's REST API rather than to osqueryd directly. Fleet already runs the agents,
 * schedules queries and holds the results; re-implementing that would mean deploying our own
 * agent fleet to 32 sites to learn what theirs already knows.
 *
 * Activity for an endpoint is **OS-level user idle time** — how long since a keystroke or a
 * mouse move. Not uptime, and not the agent checking in: a workstation left on overnight is
 * up, reachable, and doing nothing. Reading uptime as use is the ADR-0008 failure with a
 * different sensor.
 *
 * We have no Fleet instance (a Lablink dependency, like SOTI). The adapter is written to
 * Fleet's documented API and exercised against a stubbed fetch; the real thing is a config
 * swap.
 */

/**
 * The osquery SQL Fleet runs on each host.
 *
 * `user_time`/`system_time` in `osquery_schedule` would tell us about osquery, not the user.
 * The right table is `user_interaction_events` on macOS, but the portable answer across
 * Windows and Linux is the `uptime` table plus a per-platform idle query. Fleet's saved
 * query indirection means we ask for a NAMED query's results rather than embedding SQL here:
 * Lablink's Fleet admin owns the SQL, we own the interpretation.
 */
export const DEFAULT_QUERY_NAME = 'oat_endpoint_idle'

/** A row as Fleet returns it from the saved query. */
const FleetRow = z.object({
  host_hostname: z.string().optional(),
  /** Fleet's host identifier. */
  host_id: z.union([z.number(), z.string()]).optional(),
  columns: z
    .object({
      /** Asset tag, from a Fleet host label or a custom column the query selects. */
      asset_tag: z.string().optional(),
      /** Seconds since the last user input. The number that matters. */
      idle_seconds: z.union([z.number(), z.string()]).optional(),
      hostname: z.string().optional(),
    })
    .passthrough(),
})

const FleetResponse = z.object({
  results: z.array(FleetRow).optional(),
})

/** A host reading, before normalisation. */
export const OsqueryReading = z.object({
  assetRef: z.string(),
  hostname: z.string().optional(),
  idleMinutes: z.number().min(0),
  observedAt: z.coerce.date(),
})
export type OsqueryReading = z.infer<typeof OsqueryReading>

export interface OsqueryConfig {
  /** Fleet base URL, e.g. https://fleet.lablink.example */
  baseUrl: string
  /** Fleet API token (a service account's, not a person's). */
  apiToken: string
  /** The saved query whose results carry asset_tag and idle_seconds. */
  queryName?: string
  timeoutMs?: number
}

export class OsqueryConnector implements Connector {
  readonly id = 'osquery' as const

  /**
   * 15 minutes. Fleet's own default live-query cadence is coarse, and endpoint idle is not a
   * fast-moving fact — a workstation does not become meaningfully idle in 60 seconds.
   *
   * Drives the coverage gap (ADR-0018): three missed cycles is an outage, not idleness.
   */
  readonly pollIntervalMinutes = 15

  private readonly config: OsqueryConfig
  private readonly fetchImpl: typeof fetch

  constructor(config: OsqueryConfig, fetchImpl: typeof fetch = fetch) {
    this.config = { queryName: DEFAULT_QUERY_NAME, timeoutMs: 15_000, ...config }
    // Injected so tests exercise the real parsing and error handling rather than a second,
    // parallel implementation.
    this.fetchImpl = fetchImpl
  }

  async poll(): Promise<RawSignal[]> {
    const rows = await this.fetchResults()
    const raws: RawSignal[] = []
    const observedAt = new Date()

    for (const row of rows) {
      // A host with no asset tag is not ours to track. Skip rather than guess: attaching a
      // laptop's telemetry to the wrong asset is worse than having none.
      const assetRef = row.columns.asset_tag?.trim()
      if (!assetRef) continue

      const idleSeconds = Number(row.columns.idle_seconds)
      // No idle reading means the query told us nothing about use. Defaulting to 0 would
      // claim the machine is in use right now — a fabrication.
      if (!Number.isFinite(idleSeconds) || idleSeconds < 0) continue

      raws.push({
        externalRef: assetRef,
        observedAt,
        payload: {
          assetRef,
          hostname: row.columns.hostname ?? row.host_hostname,
          idleMinutes: Math.floor(idleSeconds / 60),
          observedAt,
        },
      })
    }

    return raws
  }

  normalise(raw: RawSignal, assetId: string): SignalInput {
    const reading = OsqueryReading.parse(raw.payload)

    return {
      assetId,
      source: 'osquery',
      type: 'idle',
      value: { idleMinutes: reading.idleMinutes },
      observedAt: reading.observedAt,
      // Fleet re-reports the same scheduled result across overlapping polls; key on the host
      // and the instant so a redelivery collapses onto one row.
      dedupeKey: `osquery:${reading.assetRef}:${reading.observedAt.toISOString()}`,
    }
  }

  private async fetchResults(): Promise<z.infer<typeof FleetRow>[]> {
    const url = new URL(`/api/v1/fleet/queries/run`, this.config.baseUrl)

    const controller = new AbortController()
    // A Fleet that hangs must not hang the scheduler behind it.
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)

    try {
      const response = await this.fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query_name: this.config.queryName }),
        signal: controller.signal,
      })

      if (!response.ok) {
        // Returning [] on a 500 would look identical to "every endpoint is fine", and the
        // estate would quietly stop being monitored.
        throw new OsqueryError(`Fleet returned ${response.status} ${response.statusText}`, response.status)
      }

      const body = FleetResponse.parse(await response.json())
      return body.results ?? []
    } finally {
      clearTimeout(timer)
    }
  }
}

export class OsqueryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'OsqueryError'
  }
}

/**
 * Read Fleet config from the environment, or null when it is not configured.
 *
 * Null falls back to the mock: a deployment without Fleet is supported, not an error.
 */
export function osqueryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OsqueryConfig | null {
  const baseUrl = env.OAT_FLEET_BASE_URL
  const apiToken = env.OAT_FLEET_API_TOKEN

  if (!baseUrl || !apiToken) return null

  return {
    baseUrl,
    apiToken,
    ...(env.OAT_FLEET_QUERY_NAME ? { queryName: env.OAT_FLEET_QUERY_NAME } : {}),
  }
}

/**
 * A mock Fleet, for demos and for a deployment with no Fleet instance.
 *
 * Same contract, so which one is deployed is a config decision and nothing else changes.
 */
export class MockOsqueryConnector implements Connector {
  readonly id = 'osquery' as const
  readonly pollIntervalMinutes = 15

  private readonly readings: OsqueryReading[]

  constructor(readings: OsqueryReading[] = []) {
    this.readings = readings
  }

  async poll(): Promise<RawSignal[]> {
    return this.readings.map((reading) => ({
      externalRef: reading.assetRef,
      observedAt: reading.observedAt,
      payload: reading,
    }))
  }

  normalise(raw: RawSignal, assetId: string): SignalInput {
    const reading = OsqueryReading.parse(raw.payload)

    return {
      assetId,
      source: 'osquery',
      type: 'idle',
      value: { idleMinutes: reading.idleMinutes },
      observedAt: reading.observedAt,
      dedupeKey: `osquery:${reading.assetRef}:${reading.observedAt.toISOString()}`,
    }
  }
}
