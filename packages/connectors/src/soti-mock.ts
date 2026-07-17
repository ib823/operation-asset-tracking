import type { RawSignal, SignalInput } from '@oat/core'
import { z } from 'zod'
import type { Connector } from './types'

/**
 * A mock SOTI MDM connector.
 *
 * SOTI reports device status, idle time, battery and location for managed devices. We have
 * no SOTI tenant yet, so this emits deterministic device reports against the shape the real
 * adapter will normalise. The real HTTP client is a Phase 2 swap behind this same interface.
 *
 * Feature-flagged off by default (`OAT_CONNECTOR_SOTI`): a deployment without SOTI must not
 * poll a system that isn't there.
 */

/** A device report as SOTI's API shapes it (placeholder field names — assumption A2). */
export const SotiDeviceReport = z.object({
  deviceId: z.string(),
  /** Asset tag or SAP asset number, as configured in the MDM's custom field. */
  assetRef: z.string(),
  /** Minutes the device has been idle at the time of the report. */
  idleMinutes: z.number().min(0),
  batteryPct: z.number().min(0).max(100).optional(),
  location: z.string().optional(),
  reportedAt: z.coerce.date(),
})
export type SotiDeviceReport = z.infer<typeof SotiDeviceReport>

export class MockSotiConnector implements Connector {
  readonly id = 'soti' as const
  /** Matches the real adapter, so a demo's coverage arithmetic behaves like production. */
  readonly pollIntervalMinutes = 5
  private readonly reports: SotiDeviceReport[]

  constructor(reports: SotiDeviceReport[] = []) {
    this.reports = reports
  }

  async poll(): Promise<RawSignal[]> {
    return this.reports.map((report) => ({
      externalRef: report.assetRef,
      observedAt: report.reportedAt,
      payload: report,
    }))
  }

  normalise(raw: RawSignal, assetId: string): SignalInput {
    const report = SotiDeviceReport.parse(raw.payload)

    // SOTI's `idleMinutes` is the whole point: it tells us when the device was last used,
    // which survives the MDM being unreachable for a while. Mapping it to an `idle` signal
    // lets the engine date the idle run from the right moment rather than from now.
    return {
      assetId,
      source: 'soti',
      type: 'idle',
      value: { idleMinutes: report.idleMinutes },
      observedAt: report.reportedAt,
      // SOTI may re-report the same reading across overlapping polls; key on the device and
      // the instant it described so a redelivery collapses onto the same row.
      dedupeKey: `soti:${report.deviceId}:${report.reportedAt.toISOString()}`,
    }
  }
}
