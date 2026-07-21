import { describe, expect, it } from 'vitest'
import { loadCollectorConfig } from '../config'
import { buildModules, collectAll } from './index'
import { OsqueryModule } from './osquery'
import { SnmpModule } from './snmp'
import type { CollectModule } from './types'

const BASE = {
  OAT_URL: 'https://oat.lablink.example',
  OAT_COLLECTOR_ID: 'collector-hq',
  OAT_COLLECTOR_TOKEN: 'secret',
} satisfies NodeJS.ProcessEnv

describe('OsqueryModule', () => {
  it('uses the mock when Fleet is not configured, and normalises to unresolved idle signals', async () => {
    const module = new OsqueryModule(null, [
      { assetRef: 'LAB-0100', idleMinutes: 20, observedAt: new Date('2026-07-20T10:00:00Z') },
    ])
    expect(module.mode).toBe('mock')

    const signals = await module.collect()
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ externalRef: 'LAB-0100', source: 'osquery', type: 'idle' })
    // Carries an externalRef, never an assetId — resolution is cloud-side.
    expect(signals[0]).not.toHaveProperty('assetId')
  })

  it('reports real mode when Fleet config is present', () => {
    const module = new OsqueryModule({ baseUrl: 'https://fleet.example', apiToken: 't' })
    expect(module.mode).toBe('real')
  })
})

describe('SnmpModule', () => {
  it('collects nothing when it has no targets, without error', async () => {
    // The honest "not deployed" state: no targets means nothing to poll.
    const module = new SnmpModule({ targets: [] })
    await expect(module.collect()).resolves.toEqual([])
  })
})

describe('buildModules', () => {
  it('builds only the modules whose flag and targets are both set', () => {
    const config = loadCollectorConfig({
      ...BASE,
      OAT_CONNECTOR_SNMP: '1',
      OAT_SNMP_TARGETS: 'LAB-0005@printer:161',
      OAT_COLLECTOR_SWEEP: '1',
      OAT_COLLECTOR_SWEEP_CIDR: '10.1.2.0/29',
    })
    const built = buildModules(config)

    expect(built.collectors.map((m) => m.id)).toEqual(['snmp'])
    expect(built.sweep).not.toBeNull()
  })

  it('builds no collectors and no sweep for an empty config', () => {
    const built = buildModules(loadCollectorConfig(BASE))
    expect(built.collectors).toEqual([])
    expect(built.sweep).toBeNull()
  })
})

describe('collectAll (graceful degradation)', () => {
  it('skips a module that throws and still returns the others signals', async () => {
    const good: CollectModule = {
      id: 'good',
      collect: async () => [
        { externalRef: 'LAB-1', source: 'snmp', type: 'heartbeat', value: {}, observedAt: '2026-07-20T10:00:00.000Z' },
      ],
    }
    const bad: CollectModule = {
      id: 'bad',
      collect: async () => {
        throw new Error('subnet unreachable')
      },
    }

    const errors: string[] = []
    const signals = await collectAll([bad, good], (id) => errors.push(id))

    expect(signals.map((s) => s.externalRef)).toEqual(['LAB-1'])
    expect(errors).toEqual(['bad'])
  })
})
