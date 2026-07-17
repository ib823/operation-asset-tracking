import type { AssetStatus } from '@oat/db'
import { isActivitySource, type EnginePolicy } from './idle-policy'
import { parseSignalValue, type SignalInput, type SignalSource, type SignalType } from './signals'

/**
 * The idle engine: a pure projection over the append-only signal log (ADR-0006), applying
 * the scan/telemetry precedence rules of ADR-0010.
 *
 * Who owns which fact:
 *
 *   location / custodian / UNDER_REPAIR / RETIRED   scan (human) only
 *   idle / utilisation                              telemetry only
 *   IN_USE <-> IDLE                                 contested; scan wins for a TTL
 */

export interface AssetProjection {
  status: AssetStatus
  /** Start of the current idle run — the moment the asset went quiet. Null when not idle. */
  idleSince: Date | null
  /** Most recent observation of any kind, including mere reachability. */
  lastSeenAt: Date | null
  /**
   * Most recent moment the asset is known to have been actively USED.
   *
   * Persisted rather than derived from `idleSince`, because the engine also runs as a
   * periodic sweep with an empty signal batch. An IN_USE asset has no `idleSince`, so
   * without this the sweep would have no baseline and could never age it into IDLE.
   */
  lastActiveAt: Date | null
  /** A human's contested-status assertion, and when it was made (ADR-0010). */
  scanAssertedStatus: AssetStatus | null
  scanAssertedAt: Date | null
}

/** A sustained disagreement between a fresh scan and telemetry. */
export interface Conflict {
  scanStatus: AssetStatus
  telemetryStatus: AssetStatus
  scanAssertedAt: Date
  sustainedMinutes: number
}

export interface ProjectResult {
  projection: AssetProjection
  /**
   * Set when telemetry has contradicted a live scan for long enough to be worth a human's
   * attention. The scan still wins (that is the TTL rule); this is diagnostic output.
   */
  conflict: Conflict | null
}

export interface ProjectInput {
  /**
   * The policy already RESOLVED for this asset (ADR-0014): asset → sub-type → class →
   * default, plus the site's scan TTL (ADR-0013). The engine takes the resolved values
   * rather than the asset's class, because it has no business knowing what a Site or an
   * IdleConfig is.
   */
  policy: EnginePolicy
  current: AssetProjection
  /** Signals in any order — late and out-of-order arrival is normal. */
  signals: readonly SignalInput[]
  now: Date
}

/**
 * Statuses only a human may set or clear (ADR-0010).
 *
 * Sticky, with no TTL. A machine on the repair bench still emits heartbeats and may look
 * busy; it must not resurrect itself, and it must not resurrect itself quietly after twelve
 * hours either. Deliberately asymmetric with the IN_USE/IDLE TTL: expiry is safe when the
 * worst case is a stale dashboard, and unsafe when the worst case is an unrepaired analyser
 * silently rejoining the pool.
 */
const ADMINISTRATIVE: readonly AssetStatus[] = ['UNDER_REPAIR', 'RETIRED']

/** The contested pair: the only place scan and telemetry answer the same question. */
const CONTESTED: readonly AssetStatus[] = ['IN_USE', 'IDLE']

function isAdministrative(status: AssetStatus): boolean {
  return ADMINISTRATIVE.includes(status)
}

function isContested(status: AssetStatus): boolean {
  return CONTESTED.includes(status)
}

const MINUTE_MS = 60_000

/**
 * How long telemetry must contradict a live scan before it is worth reporting.
 *
 * A single disagreement is just the world changing — a scan at 09:00 and an idle report at
 * 09:05 means someone walked away, not that anything is wrong. Sustained disagreement means
 * the scan was wrong, the device is misconfigured, or the asset ref maps to the wrong
 * machine.
 */
const CONFLICT_SUSTAINED_MINUTES = 60

interface Evidence {
  activeAt: Date | null
  status: { value: AssetStatus; at: Date; source: SignalSource } | null
}

const NO_EVIDENCE: Evidence = { activeAt: null, status: null }

function interpret(type: SignalType, value: unknown, observedAt: Date, source: SignalSource): Evidence {
  switch (type) {
    case 'utilisation': {
      const { busy } = parseSignalValue('utilisation', value)
      // `busy: false` is inactivity now; it does not say when the asset was last busy, so it
      // contributes no activity timestamp rather than a misleading one.
      return { activeAt: busy ? observedAt : null, status: null }
    }

    case 'idle': {
      const { idleMinutes } = parseSignalValue('idle', value)
      // Last active `idleMinutes` before observation. This is what stops an MDM flushing a
      // backlog after an outage from reading as fresh idleness.
      return { activeAt: new Date(observedAt.getTime() - idleMinutes * MINUTE_MS), status: null }
    }

    case 'status': {
      const { status } = parseSignalValue('status', value)
      return { activeAt: null, status: { value: status as AssetStatus, at: observedAt, source } }
    }

    case 'heartbeat':
      // Reachability is presence, never use — for any class (ADR-0008). An instrument idle
      // overnight answers pings all night.
      return NO_EVIDENCE

    case 'location':
      // Someone interacted with the asset, but treating that as use would let a passive
      // inventory sweep mask genuine idleness. Presence only.
      return NO_EVIDENCE
  }
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b
  if (!b) return a
  return a.getTime() >= b.getTime() ? a : b
}

/** What telemetry alone would conclude, ignoring any human assertion. */
function telemetryVerdict(
  lastActiveAt: Date | null,
  now: Date,
  thresholdMinutes: number,
): { status: AssetStatus; idleSince: Date | null } | null {
  // No activity evidence has ever reached us: an unmonitored asset, or one whose connector
  // is not deployed. Concluding IDLE here would libel every asset at a site with no
  // connectors — the graceful-degradation case — and would fabricate the very number the
  // client relies on. Decline to conclude.
  if (!lastActiveAt) return null

  const quietMinutes = (now.getTime() - lastActiveAt.getTime()) / MINUTE_MS
  return quietMinutes >= thresholdMinutes
    ? { status: 'IDLE', idleSince: lastActiveAt }
    : { status: 'IN_USE', idleSince: null }
}

/**
 * Derive an asset's operational state from its prior state plus a batch of signals.
 *
 * Pure: no I/O, no clock read (`now` is passed in). Idempotent and order-independent — it
 * reduces signals to maxima rather than folding state through them in sequence — which is
 * what lets it be re-run over history when the idle policy changes.
 */
export function project({ current, signals, now, policy }: ProjectInput): ProjectResult {
  const { thresholdMinutes } = policy.idle

  let lastSeenAt = current.lastSeenAt
  // Seed from the prior projection so a batch with no activity evidence — or an empty batch,
  // as the sweep passes — still knows when the asset was last used.
  let lastActiveAt = current.lastActiveAt

  /**
   * The most recent thing a HUMAN said, administrative or contested — one assertion, not two.
   *
   * Tracking them separately was a real bug: an asset scanned UNDER_REPAIR in January and
   * scanned IN_USE today would re-project to UNDER_REPAIR forever, because the admin
   * assertion was applied unconditionally and the newer scan never got a look in. Operators
   * could put an asset into repair and never take it out again.
   *
   * Both signals are in the append-only log (ADR-0006), so every re-projection replayed the
   * old one. The unit test missed it by passing a single signal in the batch — which is not
   * what `reprojectAsset` does, and not what history looks like.
   */
  let humanAssertion: { value: AssetStatus; at: Date } | null =
    current.scanAssertedStatus && current.scanAssertedAt
      ? { value: current.scanAssertedStatus, at: current.scanAssertedAt }
      : null

  for (const signal of signals) {
    lastSeenAt = latest(lastSeenAt, signal.observedAt)

    let evidence: Evidence
    try {
      evidence = interpret(signal.type, signal.value, signal.observedAt, signal.source)
    } catch {
      // A malformed signal is a connector bug, not a reason to stall the engine or drop the
      // batch. It still counts as presence; only its claim is discarded.
      continue
    }

    // ADR-0008: only sources this class trusts may evidence activity. Everything else is
    // presence. This is what keeps an instrument's heartbeat from reading as utilisation.
    if (evidence.activeAt && isActivitySource(policy.idle, signal.source)) {
      lastActiveAt = latest(lastActiveAt, evidence.activeAt)
    }

    if (!evidence.status) continue

    // ADR-0010: telemetry cannot set or clear an administrative status, and cannot assert a
    // contested one. Only a human at the asset can.
    if (evidence.status.source !== 'scan') continue

    // Latest human word wins, whichever KIND it is. "It is under repair" and "it is back in
    // use" are the same conversation, and the later statement is the true one.
    if (!humanAssertion || evidence.status.at >= humanAssertion.at) {
      humanAssertion = { value: evidence.status.value, at: evidence.status.at }
    }
  }

  const base = { lastSeenAt, lastActiveAt }

  // A human's LATEST word being an administrative status wins outright, and is sticky.
  if (humanAssertion && isAdministrative(humanAssertion.value)) {
    return {
      projection: {
        ...base,
        status: humanAssertion.value,
        idleSince: null,
        scanAssertedStatus: null,
        scanAssertedAt: null,
      },
      conflict: null,
    }
  }

  // Sticky: an asset already under repair or retired stays there until a HUMAN clears it.
  // Telemetry keeps updating lastSeenAt but cannot move it.
  if (isAdministrative(current.status) && !humanAssertion) {
    return {
      projection: {
        ...base,
        status: current.status,
        idleSince: current.idleSince,
        scanAssertedStatus: null,
        scanAssertedAt: null,
      },
      conflict: null,
    }
  }

  const telemetry = telemetryVerdict(lastActiveAt, now, thresholdMinutes)

  // A live scan assertion outranks telemetry on IN_USE/IDLE, until its TTL expires.
  // `humanAssertion` is necessarily contested here — the administrative case returned above.
  const scanAssertion = humanAssertion && isContested(humanAssertion.value) ? humanAssertion : null

  if (scanAssertion) {
    const ageMinutes = (now.getTime() - scanAssertion.at.getTime()) / MINUTE_MS

    if (ageMinutes < policy.scanTtlMinutes) {
      // Telemetry contradicting a live scan for long enough is diagnostic: the scan was
      // wrong, the device is misconfigured, or the ref maps to the wrong machine. The scan
      // still wins — but somebody should look.
      const conflict: Conflict | null =
        telemetry && telemetry.status !== scanAssertion.value && ageMinutes >= CONFLICT_SUSTAINED_MINUTES
          ? {
              scanStatus: scanAssertion.value,
              telemetryStatus: telemetry.status,
              scanAssertedAt: scanAssertion.at,
              sustainedMinutes: Math.floor(ageMinutes),
            }
          : null

      return {
        projection: {
          ...base,
          status: scanAssertion.value,
          // An operator saying "in use" is a statement about now; date the idle run from the
          // scan rather than carrying a stale idleSince from before it.
          idleSince: scanAssertion.value === 'IDLE' ? scanAssertion.at : null,
          scanAssertedStatus: scanAssertion.value,
          scanAssertedAt: scanAssertion.at,
        },
        conflict,
      }
    }
    // TTL expired: telemetry resumes automatically, no cleanup needed. A judgement made this
    // morning is good information about this morning and says nothing about tomorrow.
  }

  if (!telemetry) {
    // No telemetry verdict and no live scan. Hold position rather than invent a status.
    return {
      projection: {
        ...base,
        status: current.status,
        idleSince: current.idleSince,
        scanAssertedStatus: null,
        scanAssertedAt: null,
      },
      conflict: null,
    }
  }

  return {
    projection: {
      ...base,
      status: telemetry.status,
      idleSince: telemetry.idleSince,
      scanAssertedStatus: null,
      scanAssertedAt: null,
    },
    conflict: null,
  }
}

/** Minutes an asset has been idle at `now`, or 0 if it is not idle. */
export function idleMinutes(projection: AssetProjection, now: Date): number {
  if (projection.status !== 'IDLE' || !projection.idleSince) return 0
  return Math.max(0, Math.floor((now.getTime() - projection.idleSince.getTime()) / MINUTE_MS))
}
