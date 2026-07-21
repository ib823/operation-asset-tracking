import type { UnresolvedSignal } from '@oat/connectors'

/**
 * A collection module produces normalised-but-unresolved signals to push to OAT (ADR-0021).
 *
 * A module wraps a shared `@oat/connectors` adapter — it never re-implements collection or
 * normalisation. It runs on the LAN with no database, so everything it produces carries an
 * `externalRef`, never an OAT asset id: resolution (and the never-create rule) is cloud-side.
 *
 * The subnet SWEEP is deliberately NOT a `CollectModule`: it yields identity hints, not
 * signals, and so has no path to the register at all (see `./sweep`).
 */
export interface CollectModule {
  readonly id: string
  /** Poll the source and return signals ready to push. Reachability errors are the module's to swallow. */
  collect(): Promise<UnresolvedSignal[]>
}
