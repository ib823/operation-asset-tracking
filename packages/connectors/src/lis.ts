import type { RawSignal, SignalInput } from '@oat/core'
import { z } from 'zod'
import type { Connector } from './types'

/**
 * LIS connector — instrument activity via HL7/ASTM. **INTERFACE STUB, pending C4.**
 *
 * This is the most consequential connector in the system and the one we cannot yet build.
 *
 * Why it matters: `LAB_INSTRUMENT` derives idle from `lis` and from nothing else (ADR-0008).
 * An analyser sitting idle overnight still answers SNMP and still checks in to an MDM, so
 * every device-level source reports it as present and none of them can say whether it did
 * any work. Only the LIS knows that specimens were processed. Until this connector is live,
 * instrument utilisation reports **not measured** — never 0%, and never a fabricated 100%
 * (ADR-0015).
 *
 * Why it is a stub rather than an implementation:
 *
 *   - We have no LIS, no integration engine, and no message samples (C4).
 *   - HL7 v2 and ASTM E1394 are not one protocol but a family of local dialects. Every site
 *     negotiates its own segments, delimiters and vendor quirks. Writing a parser against
 *     the specification — rather than against Lablink's actual message stream — would
 *     produce something that looks finished, passes its own tests, and fails on contact.
 *
 * So this file defines the CONTRACT and the questions C4 must answer. The shape below is
 * deliberately the smallest thing the idle engine needs: an asset reference, an instant, and
 * evidence that work happened. Everything else in an HL7 message is somebody else's problem.
 *
 * When C4 lands, implement `poll`/`ingest` and delete `LisNotConfiguredError`. `normalise`
 * should need no changes — the engine's contract does not depend on the wire format.
 */

/**
 * One unit of instrument work, normalised from whatever the LIS sends.
 *
 * A result being reported means the instrument processed a specimen. That is the activity
 * signal — not a query, not a status poll, not the analyser being switched on.
 */
export const LisActivity = z.object({
  /** Asset tag or SAP asset number, however the LIS identifies the instrument. */
  assetRef: z.string().min(1),
  /**
   * When the instrument did the work — NOT when the message reached us.
   *
   * An integration engine may batch or replay messages hours late, and dating activity from
   * receipt would report a busy morning as a busy evening. The engine already distinguishes
   * `observedAt` from `ingestedAt` for exactly this (ADR-0006).
   */
  observedAt: z.coerce.date(),
  /** Specimens/results in this unit of work. Informational; presence is what signals activity. */
  resultCount: z.number().int().min(1).optional(),
  /** The LIS's own order/result id, for the audit trail and for deduplication. */
  messageId: z.string().optional(),
})
export type LisActivity = z.infer<typeof LisActivity>

/**
 * Questions C4 must answer before this can be implemented. Not rhetorical — each one changes
 * the code, and guessing any of them wrong produces a connector that runs and lies.
 */
export const OPEN_QUESTIONS = [
  'Transport: HL7 over MLLP, ASTM over serial/TCP, or files dropped by an integration engine?',
  'Direction: does the engine push to us (ingest), or do we poll an API/queue (poll)?',
  'Which message types signal work? ORU^R01 result messages are the obvious candidate, but ' +
    'some sites emit ORM order messages the instrument never actually ran.',
  'How is the INSTRUMENT identified in the message? OBX-18 (equipment instance) is the ' +
    'standard answer; many deployments leave it empty and encode the analyser in OBR-24 or ' +
    'a sending-facility field instead.',
  'How does that identifier map to an OAT tag or SAP asset number? A lookup table Lablink ' +
    'maintains, or a field they can populate?',
  'Which timestamp is the observation? OBX-14 (observation datetime) is the work; MSH-7 is ' +
    'when the message was built. They differ, and batching widens the gap.',
  'Re-sent and corrected results (OBX-11 = C): the same work reported twice must not ' +
    'double-count. Is the message id stable across a correction?',
] as const

/** Thrown by every method: the connector cannot run without a real LIS feed. */
export class LisNotConfiguredError extends Error {
  constructor() {
    super(
      'The LIS connector is an interface stub pending client dependency C4 (a real LIS / ' +
        'integration-engine feed). Instrument utilisation reports "not measured" until it lands — ' +
        'by design (ADR-0008). See packages/connectors/src/lis.ts.',
    )
    this.name = 'LisNotConfiguredError'
  }
}

/**
 * The LIS connector's shape, as the rest of the system will see it.
 *
 * Feature-flagged off (`OAT_CONNECTOR_LIS`), so nothing calls it. It exists so the contract
 * is reviewable now — and so the day the flag flips, rollup eligibility picks instruments up
 * automatically with no code change (ADR-0015).
 */
export class LisConnector implements Connector {
  readonly id = 'lis' as const

  /**
   * 5 minutes. A placeholder, and one of the things C4 settles: if the engine PUSHES to us
   * this number is meaningless, and the coverage gap (ADR-0018) needs a different basis
   * entirely — arrival cadence rather than poll cadence.
   */
  readonly pollIntervalMinutes = 5

  async poll(): Promise<RawSignal[]> {
    throw new LisNotConfiguredError()
  }

  async ingest(): Promise<RawSignal[]> {
    throw new LisNotConfiguredError()
  }

  /**
   * Implemented, and deliberately so.
   *
   * This half needs no LIS: given a normalised activity record, what it MEANS to the engine
   * is already decided. It is also the half worth reviewing now — and it is tested, so the
   * contract is real rather than aspirational.
   */
  normalise(raw: RawSignal, assetId: string): SignalInput {
    const activity = LisActivity.parse(raw.payload)

    return {
      assetId,
      source: 'lis',
      // `utilisation` with busy:true, not `idle`: the LIS tells us work HAPPENED at an
      // instant. It has no opinion about how long the instrument has been quiet — that is
      // the engine's job, from the class threshold (ADR-0008).
      type: 'utilisation',
      value: { busy: true },
      observedAt: activity.observedAt,
      // Keyed on the LIS's own message id where present: a corrected or re-sent result is
      // the same work reported twice and must not double-count.
      dedupeKey: activity.messageId
        ? `lis:${activity.messageId}`
        : `lis:${activity.assetRef}:${activity.observedAt.toISOString()}`,
    }
  }
}

/** True once a real LIS feed is configured. Always false today. */
export function lisConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OAT_LIS_ENDPOINT)
}
