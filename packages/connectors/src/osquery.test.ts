import { describe, expect, it, vi } from 'vitest'
import {
  MockOsqueryConnector,
  OsqueryConnector,
  OsqueryError,
  osqueryConfigFromEnv,
  type OsqueryConfig,
} from './osquery'

const config: OsqueryConfig = { baseUrl: 'https://fleet.lablink.example', apiToken: 'tok' }

function fleetResponds(body: unknown, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  ) as unknown as typeof fetch
}

const ROW = {
  host_hostname: 'kl-ws-01',
  host_id: 7,
  columns: { asset_tag: 'LAB-0004', idle_seconds: 2700, hostname: 'kl-ws-01' },
}

describe('OsqueryConnector.poll', () => {
  it('turns a Fleet row into a raw signal keyed by the asset tag', async () => {
    const raws = await new OsqueryConnector(config, fleetResponds({ results: [ROW] })).poll()

    expect(raws).toHaveLength(1)
    expect(raws[0]!.externalRef).toBe('LAB-0004')
  })

  it('converts idle seconds to minutes', async () => {
    const c = new OsqueryConnector(config, fleetResponds({ results: [ROW] }))
    const signal = c.normalise((await c.poll())[0]!, 'a1')

    // 2700s = 45 min: past IT's 30-minute threshold.
    expect(signal).toMatchObject({ source: 'osquery', type: 'idle', value: { idleMinutes: 45 } })
  })

  it('accepts idle_seconds as a string, which osquery often returns', async () => {
    const row = { ...ROW, columns: { ...ROW.columns, idle_seconds: '600' } }
    const c = new OsqueryConnector(config, fleetResponds({ results: [row] }))

    expect(c.normalise((await c.poll())[0]!, 'a1').value).toEqual({ idleMinutes: 10 })
  })

  it('skips a host with no asset tag rather than guessing', async () => {
    // Attaching a laptop's telemetry to the wrong asset is worse than having none.
    const row = { ...ROW, columns: { idle_seconds: 60 } }

    await expect(new OsqueryConnector(config, fleetResponds({ results: [row] })).poll()).resolves.toEqual([])
  })

  it('skips a host with no idle reading rather than claiming it is in use', async () => {
    // Defaulting a missing idle_seconds to 0 would fabricate "busy right now".
    const row = { ...ROW, columns: { asset_tag: 'LAB-0004' } }

    await expect(new OsqueryConnector(config, fleetResponds({ results: [row] })).poll()).resolves.toEqual([])
  })

  it('skips a nonsensical idle reading', async () => {
    for (const idle_seconds of ['not-a-number', -5]) {
      const row = { ...ROW, columns: { asset_tag: 'LAB-0004', idle_seconds } }
      await expect(
        new OsqueryConnector(config, fleetResponds({ results: [row] })).poll(),
        String(idle_seconds),
      ).resolves.toEqual([])
    }
  })

  it('handles an empty result set — no endpoints reported', async () => {
    await expect(new OsqueryConnector(config, fleetResponds({ results: [] })).poll()).resolves.toEqual([])
    await expect(new OsqueryConnector(config, fleetResponds({})).poll()).resolves.toEqual([])
  })

  it('surfaces a Fleet error rather than silently reporting no endpoints', async () => {
    // [] on a 500 looks identical to "every endpoint is fine", and the estate would quietly
    // stop being monitored.
    await expect(new OsqueryConnector(config, fleetResponds({}, 500)).poll()).rejects.toThrow(OsqueryError)
  })

  it('authenticates with the API token', async () => {
    const fetchImpl = fleetResponds({ results: [ROW] })
    await new OsqueryConnector(config, fetchImpl).poll()

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' })
  })

  it('asks for the configured saved query, not embedded SQL', async () => {
    // Lablink's Fleet admin owns the SQL; we own the interpretation.
    const fetchImpl = fleetResponds({ results: [ROW] })
    await new OsqueryConnector({ ...config, queryName: 'custom_idle' }, fetchImpl).poll()

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ query_name: 'custom_idle' })
  })

  it('produces a stable dedupe key so an overlapping poll collapses', async () => {
    const c = new OsqueryConnector(config, fleetResponds({ results: [ROW] }))
    const raw = (await c.poll())[0]!

    expect(c.normalise(raw, 'a1').dedupeKey).toBe(c.normalise(raw, 'a1').dedupeKey)
  })
})

describe('MockOsqueryConnector', () => {
  it('normalises identically to the real adapter', async () => {
    const observedAt = new Date('2026-07-16T10:00:00Z')
    const mock = new MockOsqueryConnector([{ assetRef: 'LAB-0004', idleMinutes: 45, observedAt }])

    const signal = mock.normalise((await mock.poll())[0]!, 'a1')
    // Both must agree what a reading MEANS, or the demo and production diverge.
    expect(signal).toMatchObject({ source: 'osquery', type: 'idle', value: { idleMinutes: 45 } })
  })

  it('declares the same poll interval, so coverage arithmetic matches production', async () => {
    expect(new MockOsqueryConnector().pollIntervalMinutes).toBe(new OsqueryConnector(config).pollIntervalMinutes)
  })
})

describe('osqueryConfigFromEnv', () => {
  it('returns null when Fleet is not configured, so the mock is used', () => {
    expect(osqueryConfigFromEnv({})).toBeNull()
    expect(osqueryConfigFromEnv({ OAT_FLEET_BASE_URL: 'https://x' })).toBeNull()
  })

  it('builds a config when both values are present', () => {
    expect(osqueryConfigFromEnv({ OAT_FLEET_BASE_URL: 'https://fleet.x', OAT_FLEET_API_TOKEN: 't' })).toMatchObject({
      baseUrl: 'https://fleet.x',
      apiToken: 't',
    })
  })
})
