import { describe, expect, it, vi } from 'vitest'
import { SotiConnector, SotiError, sotiConfigFromEnv, type SotiConfig } from './soti'

const config: SotiConfig = {
  baseUrl: 'https://soti.lablink.example',
  clientId: 'oat',
  clientSecret: 'secret',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A fetch stub that answers the token call, then the device call. */
function stubFetch(devices: unknown, options: { deviceStatus?: number } = {}) {
  return vi.fn(async (url: string) => {
    if (url.includes('/api/token')) return jsonResponse({ access_token: 'tok-1', expires_in: 3600 })
    return jsonResponse(devices, options.deviceStatus ?? 200)
  }) as unknown as typeof fetch
}

const DEVICE = {
  DeviceId: 'DEV-77',
  AssetTag: 'LAB-0004',
  IdleTimeMinutes: 45,
  BatteryLevel: 88,
  LastCheckInTime: '2026-07-16T10:00:00.000Z',
}

describe('SotiConnector.poll', () => {
  it('turns a device report into a raw signal keyed by the asset tag', async () => {
    const soti = new SotiConnector(config, stubFetch([DEVICE]))
    const raws = await soti.poll()

    expect(raws).toHaveLength(1)
    expect(raws[0]!.externalRef).toBe('LAB-0004')
    expect(raws[0]!.observedAt).toEqual(new Date('2026-07-16T10:00:00.000Z'))
  })

  it('normalises to an idle signal carrying idleMinutes', async () => {
    const soti = new SotiConnector(config, stubFetch([DEVICE]))
    const raws = await soti.poll()

    const signal = soti.normalise(raws[0]!, 'asset-4')
    expect(signal).toMatchObject({
      source: 'soti',
      type: 'idle',
      value: { idleMinutes: 45 },
      observedAt: new Date('2026-07-16T10:00:00.000Z'),
    })
  })

  it('produces the same dedupe key as the mock, so an overlapping poll collapses', async () => {
    const soti = new SotiConnector(config, stubFetch([DEVICE]))
    const raws = await soti.poll()

    expect(soti.normalise(raws[0]!, 'asset-4').dedupeKey).toBe('soti:DEV-77:2026-07-16T10:00:00.000Z')
  })

  it('skips a device with no asset tag rather than guessing', async () => {
    // Attaching telemetry to the wrong machine is worse than no telemetry at all.
    const soti = new SotiConnector(config, stubFetch([{ DeviceId: 'DEV-99', IdleTimeMinutes: 5 }]))

    await expect(soti.poll()).resolves.toEqual([])
  })

  it('skips a device with no idle reading rather than reporting it as busy', async () => {
    // Defaulting a missing IdleTimeMinutes to 0 would be a fabricated claim that the device
    // is in use right now — exactly the invention ADR-0008 exists to prevent.
    const soti = new SotiConnector(config, stubFetch([{ DeviceId: 'DEV-1', AssetTag: 'LAB-0004' }]))

    await expect(soti.poll()).resolves.toEqual([])
  })

  it('skips a device with an unparseable check-in time', async () => {
    const soti = new SotiConnector(config, stubFetch([{ ...DEVICE, LastCheckInTime: 'not-a-date' }]))

    await expect(soti.poll()).resolves.toEqual([])
  })

  it('defaults to now when SOTI omits the check-in time', async () => {
    const before = Date.now()
    const soti = new SotiConnector(config, stubFetch([{ ...DEVICE, LastCheckInTime: undefined }]))

    const raws = await soti.poll()
    expect(raws[0]!.observedAt.getTime()).toBeGreaterThanOrEqual(before)
  })

  it('carries battery and location through when present', async () => {
    const soti = new SotiConnector(config, stubFetch([{ ...DEVICE, Path: 'KL01/Reporting' }]))
    const payload = (await soti.poll())[0]!.payload as Record<string, unknown>

    expect(payload.batteryPct).toBe(88)
    expect(payload.location).toBe('KL01/Reporting')
  })
})

describe('SotiConnector authentication', () => {
  it('fetches a token before the devices', async () => {
    const fetchImpl = stubFetch([DEVICE])
    await new SotiConnector(config, fetchImpl).poll()

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0]![0]).toContain('/api/token')
    expect(calls[1]![0]).toContain('/api/devices')
  })

  it('reuses a live token across polls rather than re-authenticating each time', async () => {
    const fetchImpl = stubFetch([DEVICE])
    const soti = new SotiConnector(config, fetchImpl)

    await soti.poll()
    await soti.poll()

    const tokenCalls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes('/api/token'),
    )
    expect(tokenCalls).toHaveLength(1)
  })

  it('re-authenticates and retries once on a 401', async () => {
    // A poll that fails on a token SOTI rotated early would leave the estate looking idle
    // until someone noticed.
    let deviceCalls = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/api/token')) return jsonResponse({ access_token: `tok-${Date.now()}`, expires_in: 3600 })
      deviceCalls++
      return deviceCalls === 1 ? jsonResponse({}, 401) : jsonResponse([DEVICE])
    }) as unknown as typeof fetch

    const raws = await new SotiConnector(config, fetchImpl).poll()

    expect(raws).toHaveLength(1)
    expect(deviceCalls).toBe(2)
  })

  it('surfaces a server error rather than silently reporting no devices', async () => {
    // Returning [] on a 500 would look identical to "every device is fine", and the estate
    // would quietly stop being monitored.
    const soti = new SotiConnector(config, stubFetch([], { deviceStatus: 500 }))

    await expect(soti.poll()).rejects.toThrow(SotiError)
  })

  it('rejects a response that does not match the expected shape', async () => {
    const soti = new SotiConnector(config, stubFetch({ unexpected: 'shape' }))

    await expect(soti.poll()).rejects.toThrow()
  })
})

describe('sotiConfigFromEnv', () => {
  it('returns null when SOTI is not configured, so the mock is used', () => {
    // We have no tenant yet — a Lablink/vendor dependency. A deployment without SOTI is a
    // supported configuration, not an error.
    expect(sotiConfigFromEnv({})).toBeNull()
    expect(sotiConfigFromEnv({ OAT_SOTI_BASE_URL: 'https://x' })).toBeNull()
  })

  it('builds a config when every required value is present', () => {
    const resolved = sotiConfigFromEnv({
      OAT_SOTI_BASE_URL: 'https://soti.lablink.example',
      OAT_SOTI_CLIENT_ID: 'oat',
      OAT_SOTI_CLIENT_SECRET: 'secret',
      OAT_SOTI_PATH: 'KL01',
    })

    expect(resolved).toMatchObject({ baseUrl: 'https://soti.lablink.example', clientId: 'oat', path: 'KL01' })
  })
})
