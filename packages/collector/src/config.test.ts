import { describe, expect, it } from 'vitest'
import { channelFromEnv, configProblems, DEFAULT_POLL_INTERVAL_MS, enabledModules, loadCollectorConfig } from './config'
import { HealthReporter } from './health'

/**
 * Config is env-only and fails closed. These tests pin that a half-configured channel is NOT a
 * partial mode (it is null), that modules need both a flag and targets, and that the collector
 * reports why it is not ready rather than sitting quietly.
 */

const BASE = {
  OAT_URL: 'https://oat.lablink.example',
  OAT_COLLECTOR_ID: 'collector-hq',
  OAT_COLLECTOR_TOKEN: 'secret-token',
} satisfies NodeJS.ProcessEnv

describe('channelFromEnv', () => {
  it('builds a channel when url, id and token are all present', () => {
    expect(channelFromEnv(BASE)).toEqual({
      oatUrl: 'https://oat.lablink.example',
      collectorId: 'collector-hq',
      token: 'secret-token',
    })
  })

  it.each([
    ['OAT_URL', { ...BASE, OAT_URL: '' }],
    ['OAT_COLLECTOR_ID', { ...BASE, OAT_COLLECTOR_ID: '' }],
    ['OAT_COLLECTOR_TOKEN', { ...BASE, OAT_COLLECTOR_TOKEN: '' }],
  ])('returns null when %s is missing — a half-channel is a misconfiguration, not a mode', (_name, env) => {
    expect(channelFromEnv(env)).toBeNull()
  })
})

describe('loadCollectorConfig', () => {
  it('enables the SNMP module only when the flag AND targets are both set', () => {
    const withTargets = loadCollectorConfig({
      ...BASE,
      OAT_CONNECTOR_SNMP: '1',
      OAT_SNMP_TARGETS: 'LAB-0005@printer:161',
    })
    expect(enabledModules(withTargets)).toContain('snmp')

    const flagOnly = loadCollectorConfig({ ...BASE, OAT_CONNECTOR_SNMP: '1' })
    // Flag on but no targets = nothing configured. The honest "not deployed" state.
    expect(enabledModules(flagOnly)).not.toContain('snmp')
  })

  it('does not enable SNMP when the flag is off even if targets exist', () => {
    const config = loadCollectorConfig({ ...BASE, OAT_SNMP_TARGETS: 'LAB-0005@printer:161' })
    expect(enabledModules(config)).not.toContain('snmp')
  })

  it('enables the sweep only with flag + CIDR', () => {
    expect(enabledModules(loadCollectorConfig({ ...BASE, OAT_COLLECTOR_SWEEP: '1' }))).not.toContain('sweep')
    expect(
      enabledModules(
        loadCollectorConfig({ ...BASE, OAT_COLLECTOR_SWEEP: '1', OAT_COLLECTOR_SWEEP_CIDR: '10.1.2.0/24' }),
      ),
    ).toContain('sweep')
  })

  it('defaults the poll interval and accepts a positive override', () => {
    expect(loadCollectorConfig(BASE).pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS)
    expect(loadCollectorConfig({ ...BASE, OAT_COLLECTOR_POLL_INTERVAL_MS: '60000' }).pollIntervalMs).toBe(60000)
    // A garbage or non-positive value falls back rather than polling in a tight loop.
    expect(loadCollectorConfig({ ...BASE, OAT_COLLECTOR_POLL_INTERVAL_MS: '-5' }).pollIntervalMs).toBe(
      DEFAULT_POLL_INTERVAL_MS,
    )
  })
})

describe('configProblems', () => {
  it('reports a missing channel and no modules, so a stalled collector is never silent', () => {
    const problems = configProblems(loadCollectorConfig({}))
    expect(problems.some((p) => p.includes('outbound channel'))).toBe(true)
    expect(problems.some((p) => p.includes('collection module'))).toBe(true)
  })

  it('is empty when a channel and at least one module are configured', () => {
    const config = loadCollectorConfig({ ...BASE, OAT_CONNECTOR_SNMP: '1', OAT_SNMP_TARGETS: 'LAB-0005@printer:161' })
    expect(configProblems(config)).toEqual([])
  })
})

describe('HealthReporter', () => {
  it('records cycles and never leaks a token in its heartbeat line', () => {
    const clock = () => new Date('2026-07-20T12:00:00.000Z')
    const health = new HealthReporter('collector-hq', ['snmp'], clock)

    expect(health.snapshot().cyclesRun).toBe(0)
    expect(health.heartbeatLine()).toContain('no cycle yet')

    health.recordCycle({ collected: 2, accepted: 1, unmatched: 1, error: null })
    const snap = health.snapshot()
    expect(snap.cyclesRun).toBe(1)
    expect(snap.lastCycle).toEqual({ collected: 2, accepted: 1, unmatched: 1, error: null })
    expect(health.heartbeatLine()).toContain('1 accepted')
    expect(health.heartbeatLine()).not.toContain('secret')
  })

  it('returns a defensive copy from snapshot', () => {
    const health = new HealthReporter('c', ['snmp'])
    health.snapshot().enabledModules.push('tampered')
    expect(health.snapshot().enabledModules).toEqual(['snmp'])
  })
})
