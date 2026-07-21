import { ingestUnresolved, UnresolvedSignal } from '@oat/connectors'
import { audit } from '@oat/auth'
import { prisma } from '@oat/db'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireCollectorAuth } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/collector/ingest — the on-LAN collector's outbound push endpoint (ADR-0021).
 *
 * This is OAT's IRE: it takes normalised-but-unresolved signals a collector observed on a
 * customer LAN, resolves each `externalRef` to a KNOWN asset, and ingests it. A reference that
 * matches nothing is REPORTED, never registered — the collector cannot create an asset in
 * either direction (ADR-0009). It writes ONLY the operational signal log; there is no path from
 * here to SAP (SAP boundary, ADR-0004).
 *
 * Modelled on the SOTI poll endpoint, with two differences: it authenticates a per-collector
 * bearer (not the shared service token), and the collector — unlike the SOTI mock — is the
 * source of truth for the telemetry it carries, having normalised it on the LAN.
 */

/** A bound on batch size: a collector poll is bursty but not unbounded, and this caps abuse. */
const MAX_SIGNALS = 5_000

const IngestBody = z.object({
  signals: z.array(UnresolvedSignal).max(MAX_SIGNALS),
})

export async function POST(request: Request): Promise<NextResponse> {
  const auth = requireCollectorAuth(request)
  if (!auth.ok) return auth.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const parsed = IngestBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid signals', details: parsed.error.flatten() }, { status: 400 })
  }

  // Resolve → ingest, the shared cloud-side pipeline. Never creates an asset.
  const result = await ingestUnresolved(prisma, parsed.data.signals, { label: `collector:${auth.collectorId}` })

  // One audit row per push, attributed to the collector as a system actor (RFP 1.41): the
  // SignalEvents are the observation log, this records that a given collector delivered them.
  await audit(prisma, `system:collector:${auth.collectorId}`, {
    action: 'COLLECTOR_INGEST',
    entity: 'Collector',
    entityId: auth.collectorId,
    after: { accepted: result.accepted, duplicates: result.duplicates, unmatched: result.unmatched.length },
  })

  return NextResponse.json({
    collectorId: auth.collectorId,
    accepted: result.accepted,
    duplicates: result.duplicates,
    unmatched: result.unmatched,
    assetsUpdated: result.assetsUpdated,
  })
}
