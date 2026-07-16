import type { AssetClass, AssetStatus } from '@oat/db'
import { idleThresholdMinutes, type IdlePolicy } from './idle-policy'
import { parseSignalValue, type SignalInput, type SignalType } from './signals'

/**
 * The derived operational state of an asset: a projection over its signal log, never
 * written directly by a connector (ADR-0006).
 */
export interface AssetProjection {
  status: AssetStatus
  /** Start of the current idle run — the moment the asset went quiet. Null when not idle. */
  idleSince: Date | null
  /** Most recent observation of any kind, including mere reachability. */
  lastSeenAt: Date | null
  /**
   * Most recent moment the asset is known to have been actively used.
   *
   * Persisted rather than derived from `idleSince`, because the engine also runs as a
   * periodic sweep with an empty signal batch. An asset that is IN_USE has no `idleSince`,
   * so without this the sweep would have no baseline to measure quiet time from and could
   * never age it into IDLE.
   */
  lastActiveAt: Date | null
}

export interface ProjectInput {
  assetClass: AssetClass
  /** The asset's state before these signals. */
  current: AssetProjection
  /** Signals in any order — late and out-of-order arrival is normal. */
  signals: readonly SignalInput[]
  now: Date
  policy: IdlePolicy
}

/**
 * Statuses a human or authoritative system asserts, which telemetry must never overwrite.
 *
 * A centrifuge on a workbench awaiting repair still emits heartbeats. Without this, the
 * engine would cheerfully flip it back to IN_USE and the repair queue would empty itself.
 * Clearing one of these is an explicit act: a `status` signal saying so.
 */
const ADMINISTRATIVE: readonly AssetStatus[] = ['UNDER_REPAIR', 'RETIRED']

function isAdministrative(status: AssetStatus): boolean {
  return ADMINISTRATIVE.includes(status)
}

const MINUTE_MS = 60_000

/** What a signal tells us, once interpreted. */
interface Evidence {
  /** Latest moment the asset is known to have been actively used. */
  activeAt: Date | null
  /** An explicit status assertion. */
  status: { value: AssetStatus; at: Date } | null
}

function interpret(type: SignalType, value: unknown, observedAt: Date): Evidence {
  switch (type) {
    case 'utilisation': {
      const { busy } = parseSignalValue('utilisation', value)
      // `busy: false` is inactivity *now*, so it evidences no activity — the asset's idle
      // run is measured from whenever it was last busy, which this signal doesn't tell us.
      return { activeAt: busy ? observedAt : null, status: null }
    }

    case 'idle': {
      const { idleMinutes } = parseSignalValue('idle', value)
      // The asset was last active `idleMinutes` before it was observed. This is what keeps
      // a backlog flush after an MDM outage from reading as fresh idleness.
      return { activeAt: new Date(observedAt.getTime() - idleMinutes * MINUTE_MS), status: null }
    }

    case 'status': {
      const { status } = parseSignalValue('status', value)
      return { activeAt: null, status: { value: status as AssetStatus, at: observedAt } }
    }

    case 'heartbeat':
      // Reachable, not necessarily in use. Presence only — it moves lastSeenAt, nothing more.
      return { activeAt: null, status: null }

    case 'location':
      // A location fix means someone or something interacted with the asset. That is weak
      // evidence of use, but treating it as activity would let a passive inventory sweep
      // mask genuine idleness. Presence only.
      return { activeAt: null, status: null }
  }
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b
  if (!b) return a
  return a.getTime() >= b.getTime() ? a : b
}

/**
 * Derive an asset's operational state from its prior state plus a batch of signals.
 *
 * Pure: no I/O, no clock read (`now` is passed in). That is what makes it testable without
 * a database and re-runnable over history when the idle policy changes.
 *
 * The function is idempotent and order-independent — replaying the same signals in any
 * order yields the same projection — because it reduces signals to maxima rather than
 * folding state through them in sequence.
 */
export function project({ assetClass, current, signals, now, policy }: ProjectInput): AssetProjection {
  let lastSeenAt = current.lastSeenAt
  // Seed from the prior projection so a batch carrying no activity evidence — or an empty
  // batch, as the periodic sweep passes — still knows when the asset was last used.
  let lastActiveAt = current.lastActiveAt
  let statusAssertion: { value: AssetStatus; at: Date } | null = null

  for (const signal of signals) {
    lastSeenAt = latest(lastSeenAt, signal.observedAt)

    let evidence: Evidence
    try {
      evidence = interpret(signal.type, signal.value, signal.observedAt)
    } catch {
      // A malformed signal is a connector bug, not a reason to stall the engine or lose the
      // whole batch. It still counts as presence (lastSeenAt above); its claim is dropped.
      continue
    }

    lastActiveAt = latest(lastActiveAt, evidence.activeAt)

    if (evidence.status && (!statusAssertion || evidence.status.at >= statusAssertion.at)) {
      statusAssertion = evidence.status
    }
  }

  // An explicit assertion wins over anything telemetry implies, whatever its timestamp
  // relative to the telemetry: a human saying "this is under repair" is more authoritative
  // than a device saying "I'm awake".
  if (statusAssertion && isAdministrative(statusAssertion.value)) {
    return { status: statusAssertion.value, idleSince: null, lastSeenAt, lastActiveAt }
  }

  // An asset already parked in an administrative status stays there until a status signal
  // moves it out. Telemetry keeps updating lastSeenAt, but cannot resurrect it.
  if (isAdministrative(current.status) && !statusAssertion) {
    return { status: current.status, idleSince: current.idleSince, lastSeenAt, lastActiveAt }
  }

  if (!lastActiveAt) {
    // No activity evidence has ever reached us — from an unmonitored asset, or one whose
    // connector is not deployed. Concluding "idle" here would libel every asset in a site
    // with no connectors, which is exactly the graceful-degradation case. Hold position.
    return { status: current.status, idleSince: current.idleSince, lastSeenAt, lastActiveAt }
  }

  const quietMinutes = (now.getTime() - lastActiveAt.getTime()) / MINUTE_MS
  const threshold = idleThresholdMinutes(policy, assetClass)

  if (quietMinutes >= threshold) {
    // idleSince is when the asset went quiet, not when we noticed — that is the number the
    // dashboard and the client's "idle for how long?" question actually want.
    return { status: 'IDLE', idleSince: lastActiveAt, lastSeenAt, lastActiveAt }
  }

  return { status: 'IN_USE', idleSince: null, lastSeenAt, lastActiveAt }
}

/** Minutes an asset has been idle at `now`, or 0 if it is not idle. */
export function idleMinutes(projection: AssetProjection, now: Date): number {
  if (projection.status !== 'IDLE' || !projection.idleSince) return 0
  return Math.max(0, Math.floor((now.getTime() - projection.idleSince.getTime()) / MINUTE_MS))
}
