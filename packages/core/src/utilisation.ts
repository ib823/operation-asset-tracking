import { isActivitySource, type ClassIdlePolicy } from './idle-policy'
import { parseSignalValue, type SignalInput, type SignalType } from './signals'

/**
 * The utilisation rollup (ADR-0015).
 *
 * The number the HQ Lab Manager reads, and the number that will justify a disposal proposal
 * to Finance. It is the most consequential figure the OAT produces and the easiest to get
 * quietly, plausibly wrong.
 *
 * The rule that keeps it honest: **the denominator is OBSERVED time, not elapsed time.** The
 * naive `busy / periodLength` cannot tell "this asset was idle" from "we weren't watching",
 * so a connector outage becomes evidence against the machine — and a busy analyser reports
 * 40% with a chart to back it up.
 */

const MINUTE_MS = 60_000

/**
 * A silence longer than this is UNOBSERVED, not idle.
 *
 * If a connector goes quiet for six hours we did not learn six hours of idleness; we learned
 * nothing. Too high and outages read as coverage; too low and a slow poll cycle reads as an
 * outage. Revisit per connector once real poll intervals are known.
 */
export const MAX_COVERAGE_GAP_MINUTES = 60

export interface Interval {
  start: Date
  end: Date
}

export interface UtilisationResult {
  periodStart: Date
  periodEnd: Date
  /** Minutes within the period we had coverage for. The denominator. */
  observedMinutes: number
  busyMinutes: number
  idleMinutes: number
  /** Busy as a percentage of OBSERVED time (not of the period), 0–100. */
  utilisationPct: number
}

export interface RollupInput {
  policy: ClassIdlePolicy
  /** Signals overlapping the period. Any order. */
  signals: readonly SignalInput[]
  period: Interval
}

/** Merge overlapping/adjacent intervals. Union, never sum — two activity signals five
 *  minutes apart must not manufacture two hours of use. */
function union(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return []

  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime())
  const merged: Interval[] = [sorted[0]!]

  for (const next of sorted.slice(1)) {
    const last = merged[merged.length - 1]!
    if (next.start.getTime() <= last.end.getTime()) {
      if (next.end.getTime() > last.end.getTime()) last.end = next.end
    } else {
      merged.push({ ...next })
    }
  }
  return merged
}

function clamp(intervals: Interval[], period: Interval): Interval[] {
  const out: Interval[] = []
  for (const i of intervals) {
    const start = new Date(Math.max(i.start.getTime(), period.start.getTime()))
    const end = new Date(Math.min(i.end.getTime(), period.end.getTime()))
    if (end.getTime() > start.getTime()) out.push({ start, end })
  }
  return out
}

function totalMinutes(intervals: Interval[]): number {
  return intervals.reduce((sum, i) => sum + (i.end.getTime() - i.start.getTime()) / MINUTE_MS, 0)
}

/** Subtract `holes` from `base`. Both must already be unioned and sorted. */
function subtract(base: Interval[], holes: Interval[]): Interval[] {
  let out = base.map((i) => ({ ...i }))

  for (const hole of holes) {
    const next: Interval[] = []
    for (const seg of out) {
      if (hole.end <= seg.start || hole.start >= seg.end) {
        next.push(seg)
        continue
      }
      if (hole.start > seg.start) next.push({ start: seg.start, end: hole.start })
      if (hole.end < seg.end) next.push({ start: hole.end, end: seg.end })
    }
    out = next
  }
  return out
}

/**
 * When was the asset known to be ACTIVE, per this signal?
 *
 * Mirrors the live engine's `interpret`, so the rollup and the dashboard cannot disagree
 * about what a signal means.
 */
function activityAt(type: SignalType, value: unknown, observedAt: Date): Date | null {
  switch (type) {
    case 'utilisation': {
      const { busy } = parseSignalValue('utilisation', value)
      return busy ? observedAt : null
    }
    case 'idle': {
      const { idleMinutes } = parseSignalValue('idle', value)
      // Last active `idleMinutes` before observation — what stops an MDM flushing a backlog
      // after an outage from reading as fresh idleness.
      return new Date(observedAt.getTime() - idleMinutes * MINUTE_MS)
    }
    default:
      // heartbeat / location / status: presence or assertion, never activity (ADR-0008).
      return null
  }
}

/**
 * Roll a period of signals into a utilisation figure.
 *
 * Pure: no I/O, no clock read. Re-runnable over history when a threshold changes, because
 * signals are an append-only log (ADR-0006).
 *
 * Returns null when there was **no coverage** — meaning "we do not know". Deliberately not a
 * 0% row: a zero indistinguishable from ignorance is worse than a gap, because a gap prompts
 * the question and a zero answers it wrongly (ADR-0015).
 */
export function rollUp({ policy, signals, period }: RollupInput): UtilisationResult | null {
  const ordered = [...signals].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())

  // COVERAGE comes from presence: ANY signal proves we were watching, including a heartbeat.
  // That is what makes a device heartbeating all night correctly observed AND correctly idle
  // — the case the naive formula gets wrong in reverse.
  const coverage: Interval[] = []
  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i]!.observedAt
    const to = ordered[i + 1]!.observedAt
    const gapMinutes = (to.getTime() - from.getTime()) / MINUTE_MS
    // A longer silence is unobserved, not idle.
    if (gapMinutes <= MAX_COVERAGE_GAP_MINUTES) coverage.push({ start: from, end: to })
  }

  const observed = clamp(union(coverage), period)
  const observedMinutes = totalMinutes(observed)

  // No coverage: we never watched, so we know nothing. Say so by writing no row.
  if (observedMinutes <= 0) return null

  // BUSY comes from activity, and only from sources this class trusts (ADR-0008). An
  // observation at `a` marks [a, a + threshold) busy — the same rule the live engine applies.
  const busyWindows: Interval[] = []
  for (const signal of ordered) {
    if (!isActivitySource(policy, signal.source)) continue

    let active: Date | null
    try {
      active = activityAt(signal.type, signal.value, signal.observedAt)
    } catch {
      // A malformed signal is a connector bug. Drop its claim, keep the batch.
      continue
    }
    if (!active) continue

    busyWindows.push({ start: active, end: new Date(active.getTime() + policy.thresholdMinutes * MINUTE_MS) })
  }

  // Busy only counts where we were actually watching: an activity window extending into an
  // outage is not evidence about the outage.
  const busy = clamp(union(busyWindows), period).filter(() => true)
  const busyObserved = intersect(busy, observed)
  const busyMinutes = totalMinutes(busyObserved)
  const idleMinutes = Math.max(0, observedMinutes - busyMinutes)

  return {
    periodStart: period.start,
    periodEnd: period.end,
    observedMinutes: Math.round(observedMinutes),
    busyMinutes: Math.round(busyMinutes),
    idleMinutes: Math.round(idleMinutes),
    utilisationPct: Math.round((busyMinutes / observedMinutes) * 1000) / 10,
  }
}

/** Intersection of two unioned interval sets. */
function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = []
  for (const x of a) {
    for (const y of b) {
      const start = new Date(Math.max(x.start.getTime(), y.start.getTime()))
      const end = new Date(Math.min(x.end.getTime(), y.end.getTime()))
      if (end.getTime() > start.getTime()) out.push({ start, end })
    }
  }
  return union(out)
}

export { subtract as subtractIntervals, union as unionIntervals }

/**
 * The UTC instants bounding a local calendar day.
 *
 * Rollups are per local day (assumption A6: Asia/Kuala_Lumpur). A lab manager comparing
 * utilisation against a shift needs local days, not UTC ones — and the two disagree by 8
 * hours, which is a whole shift.
 */
export function localDayBounds(day: Date, timeZone: string): Interval {
  // Intl gives the local calendar date for this instant; reconstructing midnight from it
  // avoids hand-rolling offset arithmetic (and DST, should the estate ever leave Malaysia).
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(day)

  const start = zonedMidnight(parts, timeZone)
  return { start, end: new Date(start.getTime() + 24 * 60 * MINUTE_MS) }
}

function zonedMidnight(isoDate: string, timeZone: string): Date {
  // Guess UTC midnight, measure the zone's offset at that instant, then correct.
  const guess = new Date(`${isoDate}T00:00:00Z`)
  const offsetMs = offsetOf(guess, timeZone)
  return new Date(guess.getTime() - offsetMs)
}

function offsetOf(at: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)

  const get = (type: string) => Number(formatted.find((p) => p.type === type)?.value ?? '0')
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - at.getTime()
}
