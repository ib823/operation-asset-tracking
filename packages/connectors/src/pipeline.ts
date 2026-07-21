import {
  ingestSignals,
  resolveAssetByRef,
  SignalSource,
  SignalType,
  type IngestResult,
  type SignalInput,
} from '@oat/core'
import type { PrismaClient } from '@oat/db'
import { z } from 'zod'
import type { Connector } from './types'
import type { RawSignal } from '@oat/core'

/**
 * The one path from a connector's raw output into the register.
 *
 * Resolve → normalise → ingest. Keeping this in one place means every connector gets the
 * same reference resolution, the same handling of assets we don't know, and the same
 * deduplicated write — rather than each adapter reinventing it slightly differently.
 */

export interface RunResult extends IngestResult {
  connector: string
  /** External refs the connector reported that match no asset in the register. */
  unmatched: string[]
}

export async function runConnector(
  prisma: PrismaClient,
  connector: Connector,
  raws: readonly RawSignal[],
  options: { now?: Date } = {},
): Promise<RunResult> {
  const signals: SignalInput[] = []
  const unmatched: string[] = []

  // Cache resolutions: a poll commonly reports many observations for the same device, and
  // there is no reason to ask the database the same question repeatedly.
  const resolved = new Map<string, string | null>()

  for (const raw of raws) {
    let assetId = resolved.get(raw.externalRef)
    if (assetId === undefined) {
      assetId = await resolveAssetByRef(prisma, raw.externalRef)
      resolved.set(raw.externalRef, assetId)
    }

    if (!assetId) {
      // A device the register has never heard of. Report it rather than creating an asset:
      // a connector inventing register entries would let a misconfigured MDM quietly
      // populate the asset register with junk. Reconciliation is a human decision.
      if (!unmatched.includes(raw.externalRef)) unmatched.push(raw.externalRef)
      continue
    }

    try {
      signals.push(connector.normalise(raw, assetId))
    } catch {
      // A payload this connector cannot normalise is its own bug. Drop the observation and
      // keep the rest of the batch — one bad reading must not cost us the whole poll.
      continue
    }
  }

  const result = await ingestSignals(prisma, signals, options.now ? { now: options.now } : {})
  return { connector: connector.id, unmatched, ...result }
}

/** Poll a connector and ingest whatever it returns. No-op for push-only connectors. */
export async function pollConnector(
  prisma: PrismaClient,
  connector: Connector,
  options: { now?: Date } = {},
): Promise<RunResult> {
  if (!connector.poll) {
    return { connector: connector.id, unmatched: [], accepted: 0, duplicates: 0, assetsUpdated: [] }
  }
  return runConnector(prisma, connector, await connector.poll(), options)
}

/** Accept a pushed payload and ingest it. No-op for poll-only connectors. */
export async function ingestToConnector(
  prisma: PrismaClient,
  connector: Connector,
  payload: unknown,
  options: { now?: Date } = {},
): Promise<RunResult> {
  if (!connector.ingest) {
    return { connector: connector.id, unmatched: [], accepted: 0, duplicates: 0, assetsUpdated: [] }
  }
  return runConnector(prisma, connector, await connector.ingest(payload), options)
}

/**
 * The collector split (ADR-0021).
 *
 * The on-LAN collector cannot resolve an OAT asset id — it has no database, by design, which
 * is exactly what makes it structurally unable to create an asset. So the resolve→ingest
 * pipeline above is cut in half at the network boundary:
 *
 *   collector (on the LAN)          |  OAT (cloud)
 *   poll() + collectUnresolved()    |  ingestUnresolved() = resolve + ingest
 *   ─────────────── UnresolvedSignal[] over HTTPS ──────────────▶
 *
 * Both halves compose the SAME primitives `runConnector` uses — `connector.normalise`,
 * `resolveAssetByRef`, `ingestSignals` — so there is one implementation, not a fork. The only
 * difference from `runConnector` is *where* the two primitives run.
 */

/**
 * A normalised signal that has not yet been matched to an OAT asset — the wire contract
 * between a collector and OAT. It is a `SignalInput` with `assetId` replaced by the raw
 * `externalRef` the device reported, and `observedAt` as an ISO string so it survives JSON.
 *
 * Validated with zod because it crosses a trust boundary (a collector on customer hardware).
 */
export const UnresolvedSignal = z.object({
  /** The tag/serial/device id the source reported. NOT an OAT asset id — resolution is cloud-side. */
  externalRef: z.string().min(1),
  source: SignalSource,
  type: SignalType,
  /** Validated against the per-type schema at ingest, exactly as any other signal is. */
  value: z.unknown(),
  /** ISO 8601. Re-hydrated to a Date server-side. */
  observedAt: z.string().datetime(),
  dedupeKey: z.string().optional(),
})
export type UnresolvedSignal = z.infer<typeof UnresolvedSignal>

/**
 * `assetId` placeholder for the collector side.
 *
 * `normalise(raw, assetId)` uses `assetId` ONLY to copy it into the returned signal (verified
 * in every adapter — see docs/collector/INSPECTION.md §2); every meaningful field is derived
 * from `raw` alone. So the collector runs the real `normalise` with this placeholder and drops
 * the id: no adapter changes, no forked normalisation logic. The real id is attached cloud-side
 * by `ingestUnresolved` after `resolveAssetByRef`.
 */
const UNRESOLVED_PLACEHOLDER = ''

/**
 * COLLECTOR SIDE. Normalise a connector's raw output into unresolved signals, ready to push.
 *
 * Runs entirely on the LAN with no database. Holds no identity; produces `externalRef`s. A
 * payload this connector cannot normalise is dropped (its own bug) so one bad reading does not
 * cost the whole poll — the same rule `runConnector` applies.
 */
export function collectUnresolved(connector: Connector, raws: readonly RawSignal[]): UnresolvedSignal[] {
  const out: UnresolvedSignal[] = []
  for (const raw of raws) {
    let signal: SignalInput
    try {
      signal = connector.normalise(raw, UNRESOLVED_PLACEHOLDER)
    } catch {
      continue
    }
    out.push({
      externalRef: raw.externalRef,
      source: signal.source,
      type: signal.type,
      value: signal.value,
      observedAt: signal.observedAt.toISOString(),
      ...(signal.dedupeKey ? { dedupeKey: signal.dedupeKey } : {}),
    })
  }
  return out
}

/**
 * CLOUD SIDE. Resolve each unresolved signal to a known asset and ingest it.
 *
 * This is OAT's IRE (ADR-0009): a ref that matches an existing asset is ingested; a ref that
 * matches nothing is REPORTED as `unmatched` and never written — the collector cannot cause an
 * asset to be created, in either direction. Reuses `resolveAssetByRef` and `ingestSignals`
 * verbatim, with the same per-ref resolution cache `runConnector` uses.
 */
export async function ingestUnresolved(
  prisma: PrismaClient,
  unresolved: readonly UnresolvedSignal[],
  options: { now?: Date; label?: string } = {},
): Promise<RunResult> {
  const signals: SignalInput[] = []
  const unmatched: string[] = []
  const resolved = new Map<string, string | null>()

  for (const u of unresolved) {
    let assetId = resolved.get(u.externalRef)
    if (assetId === undefined) {
      assetId = await resolveAssetByRef(prisma, u.externalRef)
      resolved.set(u.externalRef, assetId)
    }

    if (!assetId) {
      // Unknown to the register: report it, never create it (ADR-0009). Same branch as
      // `runConnector`, on the same resolution primitive.
      if (!unmatched.includes(u.externalRef)) unmatched.push(u.externalRef)
      continue
    }

    signals.push({
      assetId,
      source: u.source,
      type: u.type,
      value: u.value,
      observedAt: new Date(u.observedAt),
      ...(u.dedupeKey ? { dedupeKey: u.dedupeKey } : {}),
    })
  }

  const result = await ingestSignals(prisma, signals, options.now ? { now: options.now } : {})
  const label = options.label ?? ([...new Set(unresolved.map((u) => u.source))].join('+') || 'collector')
  return { connector: label, unmatched, ...result }
}
