import type { UnresolvedSignal } from '@oat/connectors'
import { describe, expect, it, vi } from 'vitest'
import type { OatChannel, PushResult } from './channel'
import { runCycle } from './collector'
import { HealthReporter } from './health'
import type { BuiltModules, CollectModule } from './modules'
import type { SweepModule } from './modules/sweep'

const SIGNAL: UnresolvedSignal = {
  externalRef: 'LAB-0005',
  source: 'snmp',
  type: 'utilisation',
  value: { busy: true },
  observedAt: '2026-07-20T10:00:00.000Z',
}

function module(id: string, signals: UnresolvedSignal[]): CollectModule {
  return { id, collect: async () => signals }
}

function fakeChannel(result: Partial<PushResult> = {}): OatChannel {
  const push = vi.fn(async (signals: readonly UnresolvedSignal[]): Promise<PushResult> => ({
    collectorId: 'collector-hq',
    accepted: signals.length,
    duplicates: 0,
    unmatched: [],
    assetsUpdated: [],
    ...result,
  }))
  return { push } as unknown as OatChannel
}

const built = (overrides: Partial<BuiltModules> = {}): BuiltModules => ({ collectors: [], sweep: null, ...overrides })

describe('runCycle', () => {
  it('collects from modules, pushes, and records an accepted cycle in health', async () => {
    const channel = fakeChannel({ accepted: 1 })
    const health = new HealthReporter('collector-hq', ['snmp'])

    const result = await runCycle({ modules: built({ collectors: [module('snmp', [SIGNAL])] }), channel, health })

    expect(result).toEqual({ collected: 1, accepted: 1, unmatched: 0, error: null })
    expect(channel.push as ReturnType<typeof vi.fn>).toHaveBeenCalledWith([SIGNAL])
    expect(health.snapshot().lastCycle).toEqual(result)
  })

  it('surfaces unmatched refs from the push result', async () => {
    const channel = fakeChannel({ accepted: 0, unmatched: ['GHOST'] })
    const health = new HealthReporter('c', ['snmp'])
    const result = await runCycle({ modules: built({ collectors: [module('snmp', [SIGNAL])] }), channel, health })
    expect(result.unmatched).toBe(1)
  })

  it('records an error but does not throw when the push fails', async () => {
    const channel = {
      push: vi.fn(async () => {
        throw new Error('OAT ingest returned 502')
      }),
    } as unknown as OatChannel
    const health = new HealthReporter('c', ['snmp'])

    const result = await runCycle({ modules: built({ collectors: [module('snmp', [SIGNAL])] }), channel, health })

    expect(result.error).toContain('502')
    expect(result.accepted).toBe(0)
    // The cycle is still recorded — a failed push is a known state, not a crash.
    expect(health.snapshot().cyclesRun).toBe(1)
  })

  it('degrades gracefully when one module throws — the others still push', async () => {
    const bad: CollectModule = {
      id: 'bad',
      collect: async () => {
        throw new Error('subnet down')
      },
    }
    const channel = fakeChannel()
    const health = new HealthReporter('c', ['snmp'])

    const result = await runCycle({
      modules: built({ collectors: [bad, module('snmp', [SIGNAL])] }),
      channel,
      health,
    })

    expect(result.collected).toBe(1)
    expect(channel.push as ReturnType<typeof vi.fn>).toHaveBeenCalledWith([SIGNAL])
  })

  it('does not push when nothing was collected', async () => {
    const channel = fakeChannel()
    const health = new HealthReporter('c', ['snmp'])
    const result = await runCycle({ modules: built({ collectors: [module('snmp', [])] }), channel, health })
    expect(result.collected).toBe(0)
    expect(channel.push as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('records "not enrolled" when there is no channel but signals were collected', async () => {
    const health = new HealthReporter('c', ['snmp'])
    const result = await runCycle({ modules: built({ collectors: [module('snmp', [SIGNAL])] }), channel: null, health })
    expect(result.error).toContain('not enrolled')
  })

  it('runs the sweep for discovery but never pushes hints as signals', async () => {
    const discover = vi.fn(async () => [{ address: '10.1.2.7', sysName: 'printer-x' }])
    const sweep = { id: 'sweep', discover } as unknown as SweepModule
    const channel = fakeChannel()
    const health = new HealthReporter('c', ['sweep'])

    const result = await runCycle({ modules: built({ sweep }), channel, health })

    expect(discover).toHaveBeenCalledOnce()
    // Sweep produced hints, but there were no signals — so nothing was pushed.
    expect(channel.push as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(result.collected).toBe(0)
  })
})
