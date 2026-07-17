import type { SignalSource } from '@oat/core'

/**
 * How long a silence from each source still counts as "watching" (ADR-0018).
 *
 * Derived from each adapter's real poll interval rather than one global constant. A gap of
 * three intervals is treated as an outage: one missed poll is noise, three in a row is the
 * source being down — and an outage is unobserved time, never idleness.
 *
 * `scan` is the exception: a human with a barcode reader has no cadence at all. Two scans an
 * hour apart do not mean we watched the intervening hour, so its window is deliberately
 * short — a scan proves presence at that instant and very little either side of it.
 */
export const POLL_INTERVAL_MINUTES: Record<SignalSource, number> = {
  scan: 0,
  soti: 5,
  osquery: 15,
  ocs: 60,
  snmp: 15,
  lis: 5,
}

/** How many missed reports before we call it an outage. */
const OUTAGE_AFTER_INTERVALS = 3

/** Fallback when a source declares no cadence — the previous global constant (A14). */
export const DEFAULT_COVERAGE_GAP_MINUTES = 60

/**
 * The coverage gap for a source: how long a silence may last before it stops being evidence.
 *
 * A scan-only asset gets a small fixed window: a human's visit tells us about that moment,
 * not about the hours around it. Claiming coverage between two scans would be inventing
 * observation we never had.
 */
export function coverageGapMinutes(
  source: SignalSource,
  intervals: Partial<Record<SignalSource, number>> = POLL_INTERVAL_MINUTES,
): number {
  const interval = intervals[source]

  if (interval === undefined) return DEFAULT_COVERAGE_GAP_MINUTES
  // A source with no cadence (scan) covers a single interval-free instant. 15 minutes either
  // side is generous for "someone was standing there".
  if (interval <= 0) return 15

  return interval * OUTAGE_AFTER_INTERVALS
}

/** Coverage gaps for every source, as the rollup needs them. */
export function coverageGaps(
  intervals: Partial<Record<SignalSource, number>> = POLL_INTERVAL_MINUTES,
): Record<SignalSource, number> {
  const sources: SignalSource[] = ['scan', 'soti', 'osquery', 'ocs', 'snmp', 'lis']
  return Object.fromEntries(sources.map((s) => [s, coverageGapMinutes(s, intervals)])) as Record<SignalSource, number>
}
