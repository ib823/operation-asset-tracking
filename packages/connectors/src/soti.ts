import type { RawSignal, SignalInput } from '@oat/core'
import { z } from 'zod'
import { SotiDeviceReport } from './soti-mock'
import type { Connector } from './types'

/**
 * The real SOTI MobiControl connector.
 *
 * Built to the same `Connector` contract as the mock, so which one is deployed is a config
 * decision and nothing else changes. We have no SOTI tenant yet — that is a Lablink/vendor
 * dependency — so this is written against SOTI's documented API shape and is exercised by
 * tests with a stubbed `fetch`. When credentials arrive, the swap is configuration.
 *
 * Normalisation is deliberately NOT duplicated here: it is inherited from the mock's
 * implementation, because the mock and the real adapter must agree about what a device
 * report MEANS. Two copies of that logic would drift, and the tests would keep passing while
 * production drifted away from them.
 */

/** SOTI MobiControl's device shape (field names per its documented API — assumption A2). */
const SotiApiDevice = z.object({
  DeviceId: z.string(),
  /** The custom field Lablink maps to the OAT asset tag. */
  AssetTag: z.string().optional(),
  DeviceName: z.string().optional(),
  /** Minutes since the device was last used. */
  IdleTimeMinutes: z.number().min(0).optional(),
  BatteryLevel: z.number().min(0).max(100).optional(),
  LastCheckInTime: z.string().optional(),
  Path: z.string().optional(),
})

const SotiApiResponse = z.array(SotiApiDevice)

export interface SotiConfig {
  baseUrl: string
  /** OAuth2 client credentials for the MobiControl API. */
  clientId: string
  clientSecret: string
  /** Basic-auth realm token SOTI issues per tenant. */
  tenantToken?: string
  /** Device path/group to restrict the poll to. */
  path?: string
  timeoutMs?: number
}

interface TokenState {
  token: string
  expiresAt: number
}

export class SotiConnector implements Connector {
  readonly id = 'soti' as const

  /**
   * SOTI MobiControl checks devices in every ~5 minutes by default.
   *
   * Drives the coverage gap (ADR-0018): three missed check-ins is an outage, and an outage is
   * unobserved time rather than idleness. Confirm against the real tenant (C3) — this is our
   * estimate of the default, not a measured fact.
   */
  readonly pollIntervalMinutes = 5

  private readonly config: SotiConfig
  private readonly fetchImpl: typeof fetch
  private token: TokenState | null = null

  constructor(config: SotiConfig, fetchImpl: typeof fetch = fetch) {
    this.config = { timeoutMs: 15_000, ...config }
    // Injected so tests exercise the real parsing and error handling against a stub rather
    // than a second, parallel implementation.
    this.fetchImpl = fetchImpl
  }

  async poll(): Promise<RawSignal[]> {
    const devices = await this.fetchDevices()
    const raws: RawSignal[] = []

    for (const device of devices) {
      // A device with no asset tag is not ours to track. Skip rather than guess: the
      // pipeline reports unmatched refs, and inventing a mapping would attach telemetry to
      // the wrong machine — worse than no telemetry at all.
      const ref = device.AssetTag
      if (!ref) continue

      // No idle reading means SOTI told us nothing about use. Recording it as 0 would be a
      // fabricated claim that the device is busy right now.
      if (typeof device.IdleTimeMinutes !== 'number') continue

      const reportedAt = device.LastCheckInTime ? new Date(device.LastCheckInTime) : new Date()
      if (Number.isNaN(reportedAt.getTime())) continue

      raws.push({
        externalRef: ref,
        observedAt: reportedAt,
        payload: {
          deviceId: device.DeviceId,
          assetRef: ref,
          idleMinutes: device.IdleTimeMinutes,
          ...(typeof device.BatteryLevel === 'number' ? { batteryPct: device.BatteryLevel } : {}),
          ...(device.Path ? { location: device.Path } : {}),
          reportedAt,
        },
      })
    }

    return raws
  }

  /**
   * Shared with the mock on purpose: both must agree about what a report means, and the
   * class rules of ADR-0008 still apply downstream — a SOTI report evidences activity for an
   * IT or SCANNER asset, but never for a LAB_INSTRUMENT.
   */
  normalise(raw: RawSignal, assetId: string): SignalInput {
    const report = SotiDeviceReport.parse(raw.payload)

    return {
      assetId,
      source: 'soti',
      type: 'idle',
      value: { idleMinutes: report.idleMinutes },
      observedAt: report.reportedAt,
      // SOTI re-reports the same reading across overlapping polls; key on the device and the
      // instant described so a redelivery collapses onto the same row.
      dedupeKey: `soti:${report.deviceId}:${report.reportedAt.toISOString()}`,
    }
  }

  private async fetchDevices(): Promise<z.infer<typeof SotiApiResponse>> {
    const token = await this.accessToken()
    const url = new URL('/MobiControl/api/devices', this.config.baseUrl)
    if (this.config.path) url.searchParams.set('path', this.config.path)

    const response = await this.request(url, { headers: { Authorization: `Bearer ${token}` } })

    if (response.status === 401) {
      // The token expired early, or SOTI rotated it. Drop it and retry once — a poll that
      // fails on a stale token would leave the estate looking idle until someone noticed.
      this.token = null
      const retryToken = await this.accessToken()
      const retry = await this.request(url, { headers: { Authorization: `Bearer ${retryToken}` } })
      return SotiApiResponse.parse(await this.json(retry))
    }

    return SotiApiResponse.parse(await this.json(response))
  }

  private async accessToken(): Promise<string> {
    // 60s of slack: a token that expires mid-request is a failed poll.
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.token

    const url = new URL('/MobiControl/api/token', this.config.baseUrl)
    const body = new URLSearchParams({
      grant_type: 'password',
      username: this.config.clientId,
      password: this.config.clientSecret,
    })

    const response = await this.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(this.config.tenantToken ? { Authorization: `Basic ${this.config.tenantToken}` } : {}),
      },
      body: body.toString(),
    })

    const payload = z
      .object({ access_token: z.string(), expires_in: z.number().optional() })
      .parse(await this.json(response))

    this.token = {
      token: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    }
    return this.token.token
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    // An MDM that hangs must not hang the scheduler: without a timeout one unresponsive
    // tenant stalls every poll behind it.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      return await this.fetchImpl(url.toString(), { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  private async json(response: Response): Promise<unknown> {
    if (!response.ok) {
      throw new SotiError(`SOTI request failed: ${response.status} ${response.statusText}`, response.status)
    }
    try {
      return await response.json()
    } catch {
      throw new SotiError('SOTI returned a non-JSON response', response.status)
    }
  }
}

export class SotiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'SotiError'
  }
}

/**
 * Read SOTI config from the environment, or null when it is not configured.
 *
 * Null is the signal to fall back to the mock: we have no tenant yet, and a deployment
 * without SOTI is a supported configuration, not an error.
 */
export function sotiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SotiConfig | null {
  const baseUrl = env.OAT_SOTI_BASE_URL
  const clientId = env.OAT_SOTI_CLIENT_ID
  const clientSecret = env.OAT_SOTI_CLIENT_SECRET

  if (!baseUrl || !clientId || !clientSecret) return null

  return {
    baseUrl,
    clientId,
    clientSecret,
    ...(env.OAT_SOTI_TENANT_TOKEN ? { tenantToken: env.OAT_SOTI_TENANT_TOKEN } : {}),
    ...(env.OAT_SOTI_PATH ? { path: env.OAT_SOTI_PATH } : {}),
  }
}
