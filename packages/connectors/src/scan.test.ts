import { describe, expect, it } from 'vitest'
import { ScanConnector } from './scan'
import { MockSotiConnector } from './soti-mock'

const connector = new ScanConnector()
const observedAt = new Date('2026-07-16T10:00:00Z')

describe('ScanConnector', () => {
  it('emits a location signal from a scan carrying a location', async () => {
    const raws = await connector.ingest({ tag: 'LAB-0001', location: 'Bench 3', observedAt })
    expect(raws).toHaveLength(1)

    const signal = connector.normalise(raws[0]!, 'asset-1')
    expect(signal).toMatchObject({ source: 'scan', type: 'location', value: { location: 'Bench 3' }, observedAt })
  })

  it('emits one signal per assertion when a scan carries several', async () => {
    const raws = await connector.ingest({
      tag: 'LAB-0001',
      location: 'Repair bench',
      status: 'UNDER_REPAIR',
      observedAt,
    })

    const types = raws.map((raw) => connector.normalise(raw, 'asset-1').type)
    expect(types).toEqual(['location', 'status'])
  })

  it('records presence for a bare scan with no other claim', async () => {
    // A stocktake walk-past: no location, no status, but we did see it.
    const raws = await connector.ingest({ tag: 'LAB-0001', observedAt })

    const signal = connector.normalise(raws[0]!, 'asset-1')
    expect(signal.type).toBe('heartbeat')
    expect(signal.observedAt).toEqual(observedAt)
  })

  it('defaults observedAt to now when the scanner does not supply one', async () => {
    const before = Date.now()
    const raws = await connector.ingest({ tag: 'LAB-0001' })
    expect(raws[0]!.observedAt.getTime()).toBeGreaterThanOrEqual(before)
  })

  it('rejects a scan with no tag', async () => {
    await expect(connector.ingest({ location: 'Bench 3' })).rejects.toThrow()
  })

  it('produces a stable dedupe key so a resubmitted scan collapses', async () => {
    const raws1 = await connector.ingest({ tag: 'LAB-0001', location: 'Bench 3', observedAt })
    const raws2 = await connector.ingest({ tag: 'LAB-0001', location: 'Bench 3', observedAt })

    expect(connector.normalise(raws1[0]!, 'asset-1').dedupeKey).toBe(
      connector.normalise(raws2[0]!, 'asset-1').dedupeKey,
    )
  })
})

describe('MockSotiConnector', () => {
  const report = {
    deviceId: 'DEV-77',
    assetRef: 'LAB-0004',
    idleMinutes: 45,
    batteryPct: 88,
    reportedAt: observedAt,
  }

  it('normalises a device report into an idle signal carrying idleMinutes', async () => {
    const soti = new MockSotiConnector([report])
    const raws = await soti.poll()
    expect(raws).toHaveLength(1)
    expect(raws[0]!.externalRef).toBe('LAB-0004')

    const signal = soti.normalise(raws[0]!, 'asset-4')
    expect(signal).toMatchObject({ source: 'soti', type: 'idle', value: { idleMinutes: 45 }, observedAt })
  })

  it('keys on the device and the instant described, so an overlapping poll dedupes', async () => {
    const soti = new MockSotiConnector([report, report])
    const raws = await soti.poll()

    const keys = raws.map((raw) => soti.normalise(raw, 'asset-4').dedupeKey)
    expect(keys[0]).toBe(keys[1])
  })

  it('polls empty when the MDM has no devices to report', async () => {
    await expect(new MockSotiConnector().poll()).resolves.toEqual([])
  })
})
