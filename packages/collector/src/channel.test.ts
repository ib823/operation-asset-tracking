import type { UnresolvedSignal } from '@oat/connectors'
import { describe, expect, it, vi } from 'vitest'
import { ChannelError, OatChannel } from './channel'
import type { ChannelConfig } from './config'

const CONFIG: ChannelConfig = {
  oatUrl: 'https://oat.lablink.example',
  collectorId: 'collector-hq',
  token: 'secret-token',
}

const SIGNAL: UnresolvedSignal = {
  externalRef: 'LAB-0005',
  source: 'snmp',
  type: 'utilisation',
  value: { busy: true },
  observedAt: '2026-07-20T10:00:00.000Z',
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response
}

describe('OatChannel.push', () => {
  it('POSTs to /api/collector/ingest with the bearer, collector id, and signals — outbound only', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ collectorId: 'collector-hq', accepted: 1, duplicates: 0, unmatched: [], assetsUpdated: ['a1'] }),
    )
    const channel = new OatChannel(CONFIG, fetchImpl as unknown as typeof fetch)

    const result = await channel.push([SIGNAL])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('https://oat.lablink.example/api/collector/ingest')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret-token')
    expect(headers['X-Collector-Id']).toBe('collector-hq')
    expect(JSON.parse(init.body as string)).toEqual({ signals: [SIGNAL] })

    expect(result).toEqual({
      collectorId: 'collector-hq',
      accepted: 1,
      duplicates: 0,
      unmatched: [],
      assetsUpdated: ['a1'],
    })
  })

  it('only ever issues POST requests — it never GETs or opens a listener', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ collectorId: 'c', accepted: 0, duplicates: 0, unmatched: [], assetsUpdated: [] }),
    )
    const channel = new OatChannel(CONFIG, fetchImpl as unknown as typeof fetch)
    await channel.push([SIGNAL])
    for (const call of fetchImpl.mock.calls) {
      expect((call as unknown as [string, RequestInit])[1].method).toBe('POST')
    }
  })

  it('throws ChannelError with the status on a non-2xx, without echoing the body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: async () => ({ secret: 'leak' }),
        }) as unknown as Response,
    )
    const channel = new OatChannel(CONFIG, fetchImpl as unknown as typeof fetch)

    await expect(channel.push([SIGNAL])).rejects.toMatchObject({ name: 'ChannelError', status: 401 })
    // The error message is status-only; a verbose server error can never carry a secret into logs.
    await expect(channel.push([SIGNAL])).rejects.toThrow(/401/)
    await expect(channel.push([SIGNAL])).rejects.not.toThrow(/leak/)
  })

  it('wraps a transport failure in ChannelError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const channel = new OatChannel(CONFIG, fetchImpl as unknown as typeof fetch)
    await expect(channel.push([SIGNAL])).rejects.toBeInstanceOf(ChannelError)
    await expect(channel.push([SIGNAL])).rejects.toThrow(/ECONNREFUSED/)
  })

  it('rejects a malformed success body rather than trusting it', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ not: 'the expected shape' }))
    const channel = new OatChannel(CONFIG, fetchImpl as unknown as typeof fetch)
    await expect(channel.push([SIGNAL])).rejects.toBeDefined()
  })
})
