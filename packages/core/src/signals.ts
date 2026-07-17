import { z } from 'zod'

/**
 * Signal vocabulary.
 *
 * Signals are immutable observations from connectors (ADR-0006). Connectors emit them;
 * only the idle engine draws conclusions from them.
 */

/** Connector identity. A string rather than a DB enum: adding a connector must not need a migration. */
export const SignalSource = z.enum(['scan', 'soti', 'osquery', 'ocs', 'snmp', 'lis'])
export type SignalSource = z.infer<typeof SignalSource>

export const SignalType = z.enum(['heartbeat', 'idle', 'utilisation', 'location', 'status'])
export type SignalType = z.infer<typeof SignalType>

/** The asset was reachable at `observedAt`. Carries no evidence about use. */
export const HeartbeatValue = z.object({})

/**
 * The asset was idle at `observedAt`, and had been for `idleMinutes`.
 *
 * `idleMinutes` matters: an MDM that reconnects after an outage and reports "idle for 90
 * minutes" is telling us about the past, not the present. Without it we would read the
 * whole outage as fresh idleness.
 */
export const IdleValue = z.object({
  idleMinutes: z.number().min(0),
})

/** The asset was in use (`busy: true`) or not, at `observedAt`. */
export const UtilisationValue = z.object({
  busy: z.boolean(),
})

export const LocationValue = z.object({
  location: z.string().min(1),
})

/**
 * An administrative status assertion by a human or an authoritative system — the engine
 * does not infer these from telemetry.
 */
export const StatusValue = z.object({
  status: z.enum(['IN_USE', 'IDLE', 'UNDER_REPAIR', 'RETIRED']),
})

/** A signal as a connector produces it, before it is persisted. */
export interface SignalInput {
  assetId: string
  source: SignalSource
  type: SignalType
  value: unknown
  observedAt: Date
  /** Idempotency key, unique per source. Redelivery of the same observation must not double-count. */
  dedupeKey?: string
}

/** A raw payload from an external system, before normalisation. */
export interface RawSignal {
  /** How the external system identifies the asset — a tag, serial, or device id. */
  externalRef: string
  observedAt: Date
  payload: unknown
}

const VALUE_SCHEMAS = {
  heartbeat: HeartbeatValue,
  idle: IdleValue,
  utilisation: UtilisationValue,
  location: LocationValue,
  status: StatusValue,
} as const satisfies Record<SignalType, z.ZodTypeAny>

/**
 * Validate a signal's `value` against the schema for its `type`.
 *
 * Signals cross a trust boundary (webhook payloads, polled third-party APIs), so the shape
 * is checked before it reaches the engine rather than assumed.
 */
export function parseSignalValue<T extends SignalType>(type: T, value: unknown): z.infer<(typeof VALUE_SCHEMAS)[T]> {
  return VALUE_SCHEMAS[type].parse(value) as z.infer<(typeof VALUE_SCHEMAS)[T]>
}
