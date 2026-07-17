import { ingestSignals, resolveAssetByRef, type IngestResult, type SignalInput } from '@oat/core'
import type { PrismaClient } from '@oat/db'
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
