import { describe, expect, it } from 'vitest'
import { idleMinutes, project, type AssetProjection } from './idle-engine'
import { DEFAULT_IDLE_POLICY, DEFAULT_SCAN_TTL_MINUTES, type EnginePolicy } from './idle-policy'
import type { SignalInput } from './signals'

const NOW = new Date('2026-07-16T12:00:00Z')

/** The engine takes an already-RESOLVED policy (ADR-0014), so tests state one directly. */
function policyFor(
  assetClass: keyof typeof DEFAULT_IDLE_POLICY,
  scanTtlMinutes = DEFAULT_SCAN_TTL_MINUTES,
): EnginePolicy {
  return { idle: DEFAULT_IDLE_POLICY[assetClass], scanTtlMinutes }
}

const policy = policyFor('IT')

function minutesBefore(n: number): Date {
  return new Date(NOW.getTime() - n * 60_000)
}

const fresh: AssetProjection = {
  status: 'IN_USE',
  idleSince: null,
  lastSeenAt: null,
  lastActiveAt: null,
  scanAssertedStatus: null,
  scanAssertedAt: null,
}

function signal(partial: Partial<SignalInput> & Pick<SignalInput, 'type' | 'value' | 'observedAt'>): SignalInput {
  return { assetId: 'a1', source: 'soti', ...partial }
}

/** An IT-class asset: threshold 30 min, activity from osquery/soti. */
function projectIt(input: { current?: AssetProjection; signals?: SignalInput[]; now?: Date; policy?: EnginePolicy }) {
  return project({
    current: input.current ?? fresh,
    signals: input.signals ?? [],
    now: input.now ?? NOW,
    policy: input.policy ?? policy,
  })
}

describe('idle thresholds', () => {
  it('flips to IDLE once quiet time passes the class threshold', () => {
    const { projection } = projectIt({
      signals: [signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(45) })],
    })

    expect(projection.status).toBe('IDLE')
    expect(projection.idleSince).toEqual(minutesBefore(45))
  })

  it('stays IN_USE while quiet time is under the threshold', () => {
    const { projection } = projectIt({
      signals: [signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(10) })],
    })

    expect(projection.status).toBe('IN_USE')
    expect(projection.idleSince).toBeNull()
  })

  it('applies the threshold for the asset class, not a global one', () => {
    // 150 minutes quiet: idle for IT (30), not for a printer (240). Each source is on its
    // own class's activity list.
    const itSignals = [
      signal({ source: 'soti', type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(150) }),
    ]
    const printerSignals = [
      signal({ source: 'snmp', type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(150) }),
    ]

    expect(project({ current: fresh, signals: itSignals, now: NOW, policy: policyFor('IT') }).projection.status).toBe(
      'IDLE',
    )
    expect(
      project({ current: fresh, signals: printerSignals, now: NOW, policy: policyFor('PRINTER') }).projection.status,
    ).toBe('IN_USE')
  })

  it('honours a resolved threshold override', () => {
    const relaxed: EnginePolicy = {
      idle: { ...DEFAULT_IDLE_POLICY.IT, thresholdMinutes: 90 },
      scanTtlMinutes: DEFAULT_SCAN_TTL_MINUTES,
    }
    const signals = [signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(45) })]

    expect(projectIt({ signals }).projection.status).toBe('IDLE')
    expect(projectIt({ signals, policy: relaxed }).projection.status).toBe('IN_USE')
  })

  it('dates idleness from when the asset went quiet, not from when we were told', () => {
    // An MDM reconnects after an outage and reports 90 minutes of accumulated idleness.
    const { projection } = projectIt({
      signals: [signal({ type: 'idle', value: { idleMinutes: 90 }, observedAt: minutesBefore(10) })],
    })

    expect(projection.idleSince).toEqual(minutesBefore(100))
    expect(idleMinutes(projection, NOW)).toBe(100)
  })

  it('is order-independent and idempotent', () => {
    const stale = signal({ type: 'idle', value: { idleMinutes: 60 }, observedAt: minutesBefore(120) })
    const recent = signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(5) })

    const a = projectIt({ signals: [stale, recent] }).projection
    const b = projectIt({ signals: [recent, stale] }).projection
    expect(a).toEqual(b)
    expect(a.status).toBe('IN_USE')

    // Replaying the same batch over the result changes nothing.
    expect(projectIt({ current: a, signals: [stale, recent] }).projection).toEqual(a)
  })

  it('ages into IDLE on an empty sweep, using the persisted lastActiveAt', () => {
    const active: AssetProjection = { ...fresh, lastSeenAt: minutesBefore(40), lastActiveAt: minutesBefore(40) }

    expect(projectIt({ current: active }).projection.status).toBe('IDLE')
  })
})

/** ADR-0008: only a class's declared sources may evidence activity. */
describe('activity sources', () => {
  it('does not let a heartbeat evidence use, for any class', () => {
    const { projection } = projectIt({
      signals: [signal({ type: 'heartbeat', value: {}, observedAt: minutesBefore(3) })],
    })

    expect(projection.lastSeenAt).toEqual(minutesBefore(3))
    expect(projection.lastActiveAt).toBeNull()
  })

  it('ignores an SNMP reachability claim on a lab instrument', () => {
    // The failure this rule exists to prevent: an analyser idle overnight still answers
    // SNMP. If that counted as use, every instrument would show ~100% utilisation forever.
    const { projection } = project({
      current: fresh,
      signals: [signal({ source: 'snmp', type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(5) })],
      now: NOW,
      policy: policyFor('LAB_INSTRUMENT'),
    })

    expect(projection.lastActiveAt).toBeNull()
    // And it still records that we heard from the device.
    expect(projection.lastSeenAt).toEqual(minutesBefore(5))
  })

  it('accepts LIS activity on a lab instrument', () => {
    const { projection } = project({
      current: fresh,
      signals: [signal({ source: 'lis', type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(5) })],
      now: NOW,
      policy: policyFor('LAB_INSTRUMENT'),
    })

    expect(projection.lastActiveAt).toEqual(minutesBefore(5))
    expect(projection.status).toBe('IN_USE')
  })

  it('reports unknown rather than idle for an instrument with no LIS connector', () => {
    // Honest-by-default: before the LIS is wired, instruments show no utilisation rather
    // than a fabricated one.
    const { projection } = project({
      current: fresh,
      signals: [signal({ source: 'snmp', type: 'heartbeat', value: {}, observedAt: minutesBefore(600) })],
      now: NOW,
      policy: policyFor('LAB_INSTRUMENT'),
    })

    expect(projection.status).toBe('IN_USE')
    expect(projection.idleSince).toBeNull()
    expect(projection.lastActiveAt).toBeNull()
  })

  it('never idles a reusable component, which has no automated activity source', () => {
    const { projection } = project({
      current: fresh,
      signals: [signal({ source: 'scan', type: 'heartbeat', value: {}, observedAt: minutesBefore(5000) })],
      now: NOW,
      policy: policyFor('REUSABLE_COMPONENT'),
    })

    // A rack on a shelf is stored, not idle.
    expect(projection.status).toBe('IN_USE')
  })
})

/** ADR-0010: scan and telemetry own different facts. */
describe('scan and telemetry precedence', () => {
  const scanIdle = (at: number) =>
    signal({ source: 'scan', type: 'status', value: { status: 'IDLE' }, observedAt: minutesBefore(at) })
  const scanInUse = (at: number) =>
    signal({ source: 'scan', type: 'status', value: { status: 'IN_USE' }, observedAt: minutesBefore(at) })

  it('lets a fresh scan of IN_USE beat telemetry saying idle', () => {
    const { projection } = projectIt({
      signals: [signal({ type: 'idle', value: { idleMinutes: 200 }, observedAt: minutesBefore(1) }), scanInUse(5)],
    })

    expect(projection.status).toBe('IN_USE')
    expect(projection.scanAssertedStatus).toBe('IN_USE')
  })

  it('lets telemetry resume once the scan TTL expires', () => {
    // The same assertion, now 13 hours old — past the 12h TTL.
    const { projection } = projectIt({
      current: { ...fresh, scanAssertedStatus: 'IN_USE', scanAssertedAt: minutesBefore(13 * 60) },
      signals: [signal({ type: 'idle', value: { idleMinutes: 200 }, observedAt: minutesBefore(1) })],
    })

    expect(projection.status).toBe('IDLE')
    // The expired assertion is cleared, not left to confuse the next projection.
    expect(projection.scanAssertedStatus).toBeNull()
  })

  it('holds the scan right up to the TTL boundary', () => {
    const { projection } = projectIt({
      current: { ...fresh, scanAssertedStatus: 'IN_USE', scanAssertedAt: minutesBefore(11 * 60 + 59) },
      signals: [signal({ type: 'idle', value: { idleMinutes: 200 }, observedAt: minutesBefore(1) })],
    })

    expect(projection.status).toBe('IN_USE')
  })

  it('self-heals at the TTL with no new signals at all', () => {
    // The sweep passes an empty batch: status changes purely because the TTL expired.
    const { projection } = projectIt({
      current: {
        ...fresh,
        status: 'IN_USE',
        lastActiveAt: minutesBefore(20 * 60),
        scanAssertedStatus: 'IN_USE',
        scanAssertedAt: minutesBefore(13 * 60),
      },
    })

    expect(projection.status).toBe('IDLE')
  })

  it('honours a configured per-site TTL (ADR-0013)', () => {
    const shortTtl = policyFor('IT', 60)

    const { projection } = projectIt({
      current: { ...fresh, scanAssertedStatus: 'IN_USE', scanAssertedAt: minutesBefore(90) },
      signals: [signal({ type: 'idle', value: { idleMinutes: 200 }, observedAt: minutesBefore(1) })],
      policy: shortTtl,
    })

    expect(projection.status).toBe('IDLE')
  })

  it('dates the idle run from a scan asserting IDLE', () => {
    const { projection } = projectIt({ signals: [scanIdle(30)] })

    expect(projection.status).toBe('IDLE')
    expect(projection.idleSince).toEqual(minutesBefore(30))
  })

  it('ignores a telemetry attempt to assert a contested status', () => {
    // Only a human may assert IN_USE/IDLE directly; telemetry speaks through idle/utilisation.
    const { projection } = projectIt({
      signals: [signal({ source: 'soti', type: 'status', value: { status: 'IN_USE' }, observedAt: minutesBefore(1) })],
    })

    expect(projection.scanAssertedStatus).toBeNull()
  })

  describe('administrative statuses are sticky', () => {
    const underRepair: AssetProjection = {
      ...fresh,
      status: 'UNDER_REPAIR',
      lastSeenAt: minutesBefore(300),
      lastActiveAt: minutesBefore(300),
    }

    it('does not let telemetry resurrect an asset under repair', () => {
      const { projection } = projectIt({
        current: underRepair,
        signals: [signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(1) })],
      })

      expect(projection.status).toBe('UNDER_REPAIR')
    })

    it('has no TTL — it stays under repair indefinitely', () => {
      // Unlike a contested assertion this must not expire: an unrepaired analyser silently
      // rejoining the pool is a different order of harm from a stale dashboard.
      const { projection } = projectIt({
        current: { ...underRepair, lastSeenAt: minutesBefore(90 * 24 * 60) },
        now: new Date(NOW.getTime() + 90 * 24 * 60 * 60_000),
      })

      expect(projection.status).toBe('UNDER_REPAIR')
    })

    it('still tracks lastSeenAt while under repair', () => {
      const { projection } = projectIt({
        current: underRepair,
        signals: [signal({ type: 'heartbeat', value: {}, observedAt: minutesBefore(1) })],
      })

      expect(projection.lastSeenAt).toEqual(minutesBefore(1))
    })

    it('lets a human scan clear it', () => {
      const { projection } = projectIt({
        current: underRepair,
        signals: [scanInUse(1), signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(1) })],
      })

      expect(projection.status).toBe('IN_USE')
    })

    it('lets a later scan clear an earlier UNDER_REPAIR that is STILL IN THE LOG', () => {
      // The realistic case, and a real bug this missed for two phases.
      //
      // `reprojectAsset` replays the signal log (ADR-0006), so BOTH scans are always in the
      // batch — not just the newest. The engine tracked the latest administrative assertion
      // and the latest contested one separately, then let administrative win unconditionally.
      // So January's "under repair" beat today's "it is back in use", forever: an operator
      // could put an asset into repair and never take it out.
      //
      // The old test passed only because it fed a single signal, which is not what history
      // looks like.
      const { projection } = projectIt({
        current: underRepair,
        signals: [
          signal({ source: 'scan', type: 'status', value: { status: 'UNDER_REPAIR' }, observedAt: minutesBefore(500) }),
          scanInUse(2),
        ],
      })

      expect(projection.status).toBe('IN_USE')
    })

    it('keeps UNDER_REPAIR when it is the later of the two scans', () => {
      // The same rule in the other direction: latest human word wins, whichever kind it is.
      const { projection } = projectIt({
        current: fresh,
        signals: [
          scanInUse(500),
          signal({ source: 'scan', type: 'status', value: { status: 'UNDER_REPAIR' }, observedAt: minutesBefore(2) }),
        ],
      })

      expect(projection.status).toBe('UNDER_REPAIR')
    })

    it('is order-independent about which human word came last', () => {
      const older = signal({
        source: 'scan',
        type: 'status',
        value: { status: 'UNDER_REPAIR' },
        observedAt: minutesBefore(500),
      })
      const newer = scanInUse(2)

      expect(projectIt({ current: underRepair, signals: [older, newer] }).projection.status).toBe(
        projectIt({ current: underRepair, signals: [newer, older] }).projection.status,
      )
    })

    it('lets a scan assert UNDER_REPAIR over live telemetry', () => {
      const { projection } = projectIt({
        signals: [
          signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(1) }),
          signal({ source: 'scan', type: 'status', value: { status: 'UNDER_REPAIR' }, observedAt: minutesBefore(2) }),
        ],
      })

      expect(projection.status).toBe('UNDER_REPAIR')
      expect(projection.idleSince).toBeNull()
    })

    it('ignores a telemetry attempt to set an administrative status', () => {
      // A device must never be able to declare itself retired.
      const { projection } = projectIt({
        signals: [
          signal({ source: 'soti', type: 'status', value: { status: 'RETIRED' }, observedAt: minutesBefore(1) }),
        ],
      })

      expect(projection.status).not.toBe('RETIRED')
    })
  })

  describe('conflict detection', () => {
    it('reports sustained telemetry disagreement with a live scan', () => {
      const { projection, conflict } = projectIt({
        current: { ...fresh, scanAssertedStatus: 'IN_USE', scanAssertedAt: minutesBefore(180) },
        signals: [signal({ type: 'idle', value: { idleMinutes: 300 }, observedAt: minutesBefore(1) })],
      })

      // The scan still wins — the conflict is diagnostic output, not a veto.
      expect(projection.status).toBe('IN_USE')
      expect(conflict).toMatchObject({ scanStatus: 'IN_USE', telemetryStatus: 'IDLE', sustainedMinutes: 180 })
    })

    it('does not report a brief disagreement', () => {
      // A scan at 09:00 and an idle report at 09:05 is the world changing, not a fault.
      const { conflict } = projectIt({
        current: { ...fresh, scanAssertedStatus: 'IN_USE', scanAssertedAt: minutesBefore(5) },
        signals: [signal({ type: 'idle', value: { idleMinutes: 300 }, observedAt: minutesBefore(1) })],
      })

      expect(conflict).toBeNull()
    })

    it('reports no conflict when scan and telemetry agree', () => {
      const { conflict } = projectIt({
        current: { ...fresh, scanAssertedStatus: 'IN_USE', scanAssertedAt: minutesBefore(180) },
        signals: [signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(1) })],
      })

      expect(conflict).toBeNull()
    })
  })
})

describe('robustness', () => {
  it('drops a malformed signal without losing the rest of the batch', () => {
    const { projection } = projectIt({
      signals: [
        signal({ type: 'idle', value: { idleMinutes: 'not-a-number' }, observedAt: minutesBefore(2) }),
        signal({ type: 'utilisation', value: { busy: true }, observedAt: minutesBefore(5) }),
      ],
    })

    expect(projection.status).toBe('IN_USE')
    // The malformed signal still counts as presence — we did hear from the asset.
    expect(projection.lastSeenAt).toEqual(minutesBefore(2))
  })

  it('treats a location fix as presence, not use', () => {
    const idled: AssetProjection = {
      ...fresh,
      status: 'IDLE',
      idleSince: minutesBefore(200),
      lastSeenAt: minutesBefore(200),
      lastActiveAt: minutesBefore(200),
    }

    const { projection } = projectIt({
      current: idled,
      signals: [
        signal({ source: 'scan', type: 'location', value: { location: 'Bench 3' }, observedAt: minutesBefore(1) }),
      ],
    })

    // An inventory sweep walking past a shelved asset must not make it look used.
    expect(projection.status).toBe('IDLE')
    expect(projection.idleSince).toEqual(minutesBefore(200))
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
