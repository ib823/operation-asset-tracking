import { describe, expect, it } from 'vitest'
import { DEFAULT_IDLE_POLICY } from './idle-policy'
import { localDayBounds, rollUp, MAX_COVERAGE_GAP_MINUTES } from './utilisation'
import type { SignalInput } from './signals'

const DAY_START = new Date('2026-07-16T00:00:00Z')
const period = { start: DAY_START, end: new Date('2026-07-17T00:00:00Z') }

/** IT: 30-minute threshold, activity from osquery/soti. */
const IT = DEFAULT_IDLE_POLICY.IT
const INSTRUMENT = DEFAULT_IDLE_POLICY.LAB_INSTRUMENT

function at(minutesIntoDay: number): Date {
  return new Date(DAY_START.getTime() + minutesIntoDay * 60_000)
}

function busy(minutesIntoDay: number, source: SignalInput['source'] = 'soti'): SignalInput {
  return { assetId: 'a1', source, type: 'utilisation', value: { busy: true }, observedAt: at(minutesIntoDay) }
}

function heartbeat(minutesIntoDay: number, source: SignalInput['source'] = 'soti'): SignalInput {
  return { assetId: 'a1', source, type: 'heartbeat', value: {}, observedAt: at(minutesIntoDay) }
}

/** A poll every `every` minutes across [from, to], all reporting the asset as not busy. */
function quietPolls(from: number, to: number, every = 5): SignalInput[] {
  const out: SignalInput[] = []
  for (let m = from; m <= to; m += every) out.push(heartbeat(m))
  return out
}

describe('rollUp', () => {
  it('measures busy against observed time, not elapsed time', () => {
    // Two hours of polling; the asset is busy throughout the first hour only.
    const signals = [...quietPolls(0, 120), busy(0), busy(20)]

    const result = rollUp({ policy: IT, signals, period })!

    expect(result.observedMinutes).toBe(120)
    // busy(20) marks [20, 50); busy(0) marks [0, 30). Union = [0, 50).
    expect(result.busyMinutes).toBe(50)
    expect(result.idleMinutes).toBe(70)
    expect(result.utilisationPct).toBeCloseTo(41.7, 0)
  })

  it('does NOT count an outage as idle — the failure that would libel a busy asset', () => {
    // Polls for the first hour, then the connector dies for the rest of the day.
    const signals = [...quietPolls(0, 60), busy(0)]

    const result = rollUp({ policy: IT, signals, period })!

    // Only the watched hour counts. The naive busy/periodLength would report ~2% over 1440
    // minutes and someone would propose disposing of a perfectly busy machine.
    expect(result.observedMinutes).toBe(60)
    expect(result.busyMinutes).toBe(30)
    expect(result.utilisationPct).toBe(50)
  })

  it('treats a silence longer than the coverage gap as unobserved', () => {
    // Two islands of polling with a 6-hour hole between them.
    const signals = [...quietPolls(0, 60), ...quietPolls(420, 480)]

    const result = rollUp({ policy: IT, signals, period })!

    // 60 + 60 minutes of coverage; the 6-hour hole is not idleness, it is ignorance.
    expect(result.observedMinutes).toBe(120)
  })

  it('counts a gap at exactly the cap as covered, and beyond it as not', () => {
    const within = [heartbeat(0), heartbeat(MAX_COVERAGE_GAP_MINUTES)]
    const beyond = [heartbeat(0), heartbeat(MAX_COVERAGE_GAP_MINUTES + 1)]

    expect(rollUp({ policy: IT, signals: within, period })!.observedMinutes).toBe(MAX_COVERAGE_GAP_MINUTES)
    expect(rollUp({ policy: IT, signals: beyond, period })).toBeNull()
  })

  it('returns null — not 0% — when nothing was observed', () => {
    // The decision that makes the rest safe: a zero you cannot distinguish from ignorance is
    // worse than a gap, because a gap prompts the question and a zero answers it wrongly.
    expect(rollUp({ policy: IT, signals: [], period })).toBeNull()
    expect(rollUp({ policy: IT, signals: [heartbeat(30)], period })).toBeNull()
  })

  it('records a device that heartbeats all night as observed AND idle', () => {
    // The case the naive formula gets wrong in reverse: presence is not use.
    const result = rollUp({ policy: IT, signals: quietPolls(0, 480), period })!

    expect(result.observedMinutes).toBe(480)
    expect(result.busyMinutes).toBe(0)
    expect(result.utilisationPct).toBe(0)
  })

  it('unions overlapping activity windows rather than summing them', () => {
    // Two signals 5 minutes apart, each marking a 30-minute window.
    const result = rollUp({ policy: IT, signals: [...quietPolls(0, 120), busy(0), busy(5)], period })!

    // [0,30) ∪ [5,35) = [0,35). Summing would manufacture 60 minutes of use from 35.
    expect(result.busyMinutes).toBe(35)
  })

  it('ignores activity from a source the class does not trust', () => {
    // An analyser answering SNMP all day is not an analyser doing work (ADR-0008).
    const signals = [...quietPolls(0, 120, 5).map((s) => ({ ...s, source: 'snmp' as const })), busy(0, 'snmp')]

    const result = rollUp({ policy: INSTRUMENT, signals, period })!

    expect(result.observedMinutes).toBe(120)
    // Observed, but zero evidence of use — which is the honest answer until the LIS lands.
    expect(result.busyMinutes).toBe(0)
  })

  it('accepts activity from the LIS for an instrument', () => {
    const signals = [...quietPolls(0, 120, 5).map((s) => ({ ...s, source: 'lis' as const })), busy(0, 'lis')]

    const result = rollUp({ policy: INSTRUMENT, signals, period })!

    // Instrument threshold is 120 minutes, so one activity signal covers the whole window.
    expect(result.busyMinutes).toBe(120)
    expect(result.utilisationPct).toBe(100)
  })

  it('dates activity from an idle report, not from when it arrived', () => {
    // At minute 120 the MDM reports 90 minutes idle, so the asset was last busy at minute 30.
    const signals: SignalInput[] = [
      ...quietPolls(0, 180),
      { assetId: 'a1', source: 'soti', type: 'idle', value: { idleMinutes: 90 }, observedAt: at(120) },
    ]

    const result = rollUp({ policy: IT, signals, period })!

    // Busy window [30, 60), all inside coverage.
    expect(result.busyMinutes).toBe(30)
  })

  it('does not let activity leak into an unobserved window', () => {
    // Busy at minute 55, threshold 30 → window [55, 85). Coverage stops at 60.
    const signals = [...quietPolls(0, 60), busy(55)]

    const result = rollUp({ policy: IT, signals, period })!

    // Only [55,60) counts. An activity window extending into an outage is not evidence
    // about the outage.
    expect(result.busyMinutes).toBe(5)
    expect(result.observedMinutes).toBe(60)
  })

  it('clamps to the period, so a window spanning midnight is not double-counted', () => {
    // Polls every 5 minutes from 1380, so the last one lands at 1435 and coverage is
    // [1380, 1435] — 55 minutes.
    const signals = [...quietPolls(1380, 1439), busy(1430)]

    const result = rollUp({ policy: IT, signals, period })!

    expect(result.observedMinutes).toBe(55)
    // busy(1430) marks [1430, 1460), clamped to the day's end at 1440, then intersected with
    // coverage ending at 1435 → [1430, 1435). The window must not spill into tomorrow, and
    // must not claim minutes we were not watching.
    expect(result.busyMinutes).toBe(5)
    expect(result.busyMinutes + result.idleMinutes).toBe(result.observedMinutes)
  })

  it('is order-independent', () => {
    const signals = [...quietPolls(0, 120), busy(0), busy(20)]
    const shuffled = [...signals].reverse()

    expect(rollUp({ policy: IT, signals: shuffled, period })).toEqual(rollUp({ policy: IT, signals, period }))
  })

  it('drops a malformed signal without losing the batch', () => {
    const signals: SignalInput[] = [
      ...quietPolls(0, 120),
      { assetId: 'a1', source: 'soti', type: 'idle', value: { idleMinutes: 'nonsense' }, observedAt: at(60) },
      busy(0),
    ]

    const result = rollUp({ policy: IT, signals, period })!
    expect(result.busyMinutes).toBe(30)
  })

  it('never reports busy exceeding observed', () => {
    // Continuous activity for a whole day of polling.
    const signals = [...quietPolls(0, 1440), ...Array.from({ length: 100 }, (_, i) => busy(i * 10))]

    const result = rollUp({ policy: IT, signals, period })!

    expect(result.busyMinutes).toBeLessThanOrEqual(result.observedMinutes)
    expect(result.utilisationPct).toBeLessThanOrEqual(100)
    expect(result.busyMinutes + result.idleMinutes).toBe(result.observedMinutes)
  })
})

describe('localDayBounds', () => {
  it('bounds a Malaysian calendar day, not a UTC one', () => {
    // Asia/Kuala_Lumpur is UTC+8, so local midnight is 16:00 UTC the previous day. The two
    // disagree by 8 hours — a whole shift.
    const bounds = localDayBounds(new Date('2026-07-16T10:00:00Z'), 'Asia/Kuala_Lumpur')

    expect(bounds.start.toISOString()).toBe('2026-07-15T16:00:00.000Z')
    expect(bounds.end.toISOString()).toBe('2026-07-16T16:00:00.000Z')
  })

  it('spans exactly 24 hours', () => {
    const bounds = localDayBounds(new Date('2026-07-16T10:00:00Z'), 'Asia/Kuala_Lumpur')
    expect(bounds.end.getTime() - bounds.start.getTime()).toBe(24 * 60 * 60_000)
  })

  it('puts an instant just after local midnight in the right day', () => {
    // 16:30 UTC is 00:30 on the 17th in KL.
    const bounds = localDayBounds(new Date('2026-07-16T16:30:00Z'), 'Asia/Kuala_Lumpur')
    expect(bounds.start.toISOString()).toBe('2026-07-16T16:00:00.000Z')
  })
})
