import type { RawSignal, SignalInput } from '@oat/core'
import { z } from 'zod'
import type { Connector } from './types'

/**
 * The scan connector: barcode/QR capture, and the manual fallback floor.
 *
 * This is the connector that must never be unavailable. Every automated source can be off —
 * no MDM, no osquery, no SNMP, no LIS — and Lablink can still run the register by walking a
 * site with a scanner. It is therefore built first and deliberately depends on nothing
 * external.
 *
 * A scan is an assertion by a human who is standing in front of the asset, which makes it
 * the most authoritative signal we have.
 */

export const ScanPayload = z.object({
  /** Scanned barcode/QR value — an asset tag or SAP asset number (assumption A4). */
  tag: z.string().min(1),
  observedAt: z.coerce.date().optional(),
  location: z.string().min(1).optional(),
  /** An operator asserting an administrative status while at the asset. */
  status: z.enum(['IN_USE', 'IDLE', 'UNDER_REPAIR', 'RETIRED']).optional(),
  custodianId: z.string().min(1).optional(),
  /** Who scanned. Recorded for the audit trail. */
  scannedBy: z.string().min(1).optional(),
})
export type ScanPayload = z.infer<typeof ScanPayload>

export class ScanConnector implements Connector {
  readonly id = 'scan' as const

  /**
   * Zero: a human with a barcode reader has no cadence.
   *
   * Scans are pushed, not polled, and two scans an hour apart do not mean we watched the
   * intervening hour. The coverage rule gives a source with no interval a small fixed window
   * rather than a multiple of nothing (ADR-0018).
   */
  readonly pollIntervalMinutes = 0

  /**
   * Accept a scan submission.
   *
   * One scan can carry several assertions (here, and moved, and under repair), and each is
   * a separate observation with its own meaning — so it fans out to one signal per claim
   * rather than one fat signal the engine would have to unpick.
   */
  async ingest(payload: unknown): Promise<RawSignal[]> {
    const scan = ScanPayload.parse(payload)
    const observedAt = scan.observedAt ?? new Date()

    const raws: RawSignal[] = []
    const base = { externalRef: scan.tag, observedAt }

    if (scan.location) {
      raws.push({ ...base, payload: { kind: 'location', location: scan.location, scannedBy: scan.scannedBy } })
    }
    if (scan.status) {
      raws.push({ ...base, payload: { kind: 'status', status: scan.status, scannedBy: scan.scannedBy } })
    }

    // A scan with no other claim still proves the asset exists and where it was seen.
    // Recording presence keeps "when did anyone last lay eyes on this?" answerable, which
    // is the whole value of the fallback floor during a stocktake.
    if (raws.length === 0) {
      raws.push({ ...base, payload: { kind: 'heartbeat', scannedBy: scan.scannedBy } })
    }

    return raws
  }

  normalise(raw: RawSignal, assetId: string): SignalInput {
    const payload = raw.payload as { kind: string; location?: string; status?: string }

    switch (payload.kind) {
      case 'location':
        return {
          assetId,
          source: 'scan',
          type: 'location',
          value: { location: payload.location },
          observedAt: raw.observedAt,
          dedupeKey: `scan:${raw.externalRef}:location:${raw.observedAt.toISOString()}`,
        }
      case 'status':
        return {
          assetId,
          source: 'scan',
          type: 'status',
          value: { status: payload.status },
          observedAt: raw.observedAt,
          dedupeKey: `scan:${raw.externalRef}:status:${raw.observedAt.toISOString()}`,
        }
      default:
        return {
          assetId,
          source: 'scan',
          type: 'heartbeat',
          value: {},
          observedAt: raw.observedAt,
          dedupeKey: `scan:${raw.externalRef}:seen:${raw.observedAt.toISOString()}`,
        }
    }
  }
}
