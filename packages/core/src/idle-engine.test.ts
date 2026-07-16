import { describe, expect, it } from 'vitest'
import { idleMinutes, project, type AssetProjection } from './idle-engine'
import { DEFAULT_IDLE_POLICY } from './idle-policy'
import type { SignalInput } from './signals'

const NOW = new Date('2026-07-16T12:00:00Z')
const policy = DEFAULT_IDLE_POLICY

function minutesBefore(n: number): Date {
  return new Date(NOW.getTime() - n * 60_000)
}

const fresh: AssetProjection = {
  status: 'IN_USE',
  idleSince: null,
  lastSeenAt: null,
  lastActiveAt: null,
}

function signal(partial: Partial<SignalInput> & Pick<SignalInput, 'type' | 'value' | 'observedAt'>): SignalInput {
  return { assetId: 'a1', source: 'soti', ...partial }
}

describe('project', () => {
  it('flips an asset to IDLE once quiet time passes its class threshold', () => {
    // IT threshold is 30 minutes; last busy 45 minutes ago.
    const result = project({
      assetClass: 'IT',
      current: fresh,
      signals: [signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(45) })],
      now: NOW,
      policy,
    })

    expect(result.status).toBe('IDLE')
    expect(result.idleSince).toEqual(minutesBefore(45))
  })

  it('keeps an asset IN_USE while quiet time is under the threshold', () => {
    const result = project({
      assetClass: 'IT',
      current: fresh,
      signals: [signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(10) })],
      now: NOW,
      policy,
    })

    expect(result.status).toBe('IN_USE')
    expect(result.idleSince).toBeNull()
  })

  it('applies the threshold for the asset class, not a global one', () => {
    // 150 minutes quiet: idle for IT (30) but not for a printer (240).
    const signals = [signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(150) })]

    expect(project({ assetClass: 'IT', current: fresh, signals, now: NOW, policy }).status).toBe('IDLE')
    expect(project({ assetClass: 'PRINTER', current: fresh, signals, now: NOW, policy }).status).toBe('IN_USE')
  })

  it('flips back to IN_USE when fresh activity arrives', () => {
    const idled: AssetProjection = {
      status: 'IDLE',
      idleSince: minutesBefore(200),
      lastSeenAt: minutesBefore(200),
      lastActiveAt: minutesBefore(200),
    }

    const result = project({
      assetClass: 'IT',
      current: idled,
      signals: [signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(5) })],
      now: NOW,
      policy,
    })

    expect(result.status).toBe('IN_USE')
    expect(result.idleSince).toBeNull()
  })

  it('dates idleness from when the asset went quiet, not from when we were told', () => {
    // An MDM reconnects after an outage and reports 90 minutes of accumulated idleness.
    // The idle run started 90 minutes before the observation, not at the observation.
    const observedAt = minutesBefore(10)
    const result = project({
      assetClass: 'IT',
      current: fresh,
      signals: [signal({ type: 'idle', value: { idleMinutes: 90 }, observedAt })],
      now: NOW,
      policy,
    })

    expect(result.status).toBe('IDLE')
    expect(result.idleSince).toEqual(minutesBefore(100))
    expect(idleMinutes(result, NOW)).toBe(100)
  })

  it('is order-independent — a late-arriving stale signal cannot undo newer activity', () => {
    const stale = signal({ type: 'idle', value: { idleMinutes: 60 }, observedAt: minutesBefore(120) })
    const recent = signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(5) })

    const inOrder = project({ assetClass: 'IT', current: fresh, signals: [stale, recent], now: NOW, policy })
    const reversed = project({ assetClass: 'IT', current: fresh, signals: [recent, stale], now: NOW, policy })

    expect(inOrder).toEqual(reversed)
    expect(inOrder.status).toBe('IN_USE')
  })

  it('is idempotent — replaying the same batch changes nothing', () => {
    const signals = [signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(45) })]

    const once = project({ assetClass: 'IT', current: fresh, signals, now: NOW, policy })
    const twice = project({ assetClass: 'IT', current: once, signals, now: NOW, policy })

    expect(twice).toEqual(once)
  })

  it('ages an asset into IDLE on an empty sweep, using the persisted lastActiveAt', () => {
    // The periodic sweep passes no signals. Without a persisted lastActiveAt the engine
    // would have no baseline and this asset would stay IN_USE forever.
    const active: AssetProjection = {
      status: 'IN_USE',
      idleSince: null,
      lastSeenAt: minutesBefore(40),
      lastActiveAt: minutesBefore(40),
    }

    const result = project({ assetClass: 'IT', current: active, signals: [], now: NOW, policy })

    expect(result.status).toBe('IDLE')
    expect(result.idleSince).toEqual(minutesBefore(40))
  })

  describe('administrative statuses', () => {
    const underRepair: AssetProjection = {
      status: 'UNDER_REPAIR',
      idleSince: null,
      lastSeenAt: minutesBefore(300),
      lastActiveAt: minutesBefore(300),
    }

    it('does not let telemetry resurrect an asset that is under repair', () => {
      // A machine on the repair bench still emits heartbeats and may still look "busy".
      const result = project({
        assetClass: 'IT',
        current: underRepair,
        signals: [signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(1) })],
        now: NOW,
        policy,
      })

      expect(result.status).toBe('UNDER_REPAIR')
    })

    it('still tracks lastSeenAt for an asset under repair', () => {
      const result = project({
        assetClass: 'IT',
        current: underRepair,
        signals: [signal({ type: 'heartbeat', value: {}, observedAt: minutesBefore(1) })],
        now: NOW,
        policy,
      })

      expect(result.lastSeenAt).toEqual(minutesBefore(1))
    })

    it('lets an explicit status signal move an asset out of repair', () => {
      const result = project({
        assetClass: 'IT',
        current: underRepair,
        signals: [
          signal({ source: 'scan', type: 'status', value: { status: 'IN_USE' }, observedAt: minutesBefore(1) }),
          signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(1) }),
        ],
        now: NOW,
        policy,
      })

      expect(result.status).toBe('IN_USE')
    })

    it('lets an operator scan assert UNDER_REPAIR over live telemetry', () => {
      const result = project({
        assetClass: 'IT',
        current: fresh,
        signals: [
          signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(1) }),
          signal({ source: 'scan', type: 'status', value: { status: 'UNDER_REPAIR' }, observedAt: minutesBefore(2) }),
        ],
        now: NOW,
        policy,
      })

      expect(result.status).toBe('UNDER_REPAIR')
      expect(result.idleSince).toBeNull()
    })
  })

  describe('absence of evidence', () => {
    it('does not conclude IDLE for an asset no connector has ever reported activity for', () => {
      // Graceful degradation: with connectors disabled, every asset would otherwise be
      // libelled as idle the moment the threshold elapsed.
      const result = project({
        assetClass: 'IT',
        current: fresh,
        signals: [signal({ type: 'heartbeat', value: {}, observedAt: minutesBefore(600) })],
        now: NOW,
        policy,
      })

      expect(result.status).toBe('IN_USE')
      expect(result.idleSince).toBeNull()
    })

    it('treats a heartbeat as presence, not use', () => {
      const result = project({
        assetClass: 'IT',
        current: fresh,
        signals: [signal({ type: 'heartbeat', value: {}, observedAt: minutesBefore(3) })],
        now: NOW,
        policy,
      })

      expect(result.lastSeenAt).toEqual(minutesBefore(3))
      expect(result.lastActiveAt).toBeNull()
    })

    it('treats a location fix as presence, not use', () => {
      const idled: AssetProjection = {
        status: 'IDLE',
        idleSince: minutesBefore(200),
        lastSeenAt: minutesBefore(200),
        lastActiveAt: minutesBefore(200),
      }

      // An inventory sweep walking past a shelved asset must not make it look used.
      const result = project({
        assetClass: 'IT',
        current: idled,
        signals: [
          signal({ source: 'scan', type: 'location', value: { location: 'Bench 3' }, observedAt: minutesBefore(1) }),
        ],
        now: NOW,
        policy,
      })

      expect(result.status).toBe('IDLE')
      expect(result.idleSince).toEqual(minutesBefore(200))
    })
  })

  it('drops a malformed signal without losing the rest of the batch', () => {
    const result = project({
      assetClass: 'IT',
      current: fresh,
      signals: [
        signal({ type: 'idle', value: { idleMinutes: 'not-a-number' }, observedAt: minutesBefore(2) }),
        signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(5) }),
      ],
      now: NOW,
      policy,
    })

    expect(result.status).toBe('IN_USE')
    // The malformed signal still counts as presence — we did hear from the asset.
    expect(result.lastSeenAt).toEqual(minutesBefore(2))
  })
})

describe('idleMinutes', () => {
  it('reports 0 for an asset that is not idle', () => {
    expect(idleMinutes({ ...fresh, status: 'IN_USE' }, NOW)).toBe(0)
  })

  it('measures from idleSince', () => {
    expect(idleMinutes({ ...fresh, status: 'IDLE', idleSince: minutesBefore(90) }, NOW)).toBe(90)
  })
})
