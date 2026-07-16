import { describe, expect, it } from 'vitest'
import {
  assertApproved,
  mapAssetClass,
  SapApprovalRequiredError,
  type SapOutboundEvent,
  type SapWriteApproval,
} from './contract'
import { MockSapClient } from './mock-client'

const approval: SapWriteApproval = {
  approvedBy: 'finance.manager@lablink.example',
  approvedAt: new Date('2026-07-16T09:00:00Z'),
  reference: 'APPR-001',
}

const disposal: SapOutboundEvent = {
  kind: 'DISPOSAL_PROPOSED',
  assetNo: '100000003',
  reason: 'Idle for 18 months; replaced by KL01 centrifuge pool',
  proposedAt: new Date('2026-07-16T08:00:00Z'),
}

describe('SAP boundary', () => {
  it('accepts the three permitted accounting-relevant event kinds', async () => {
    const sap = new MockSapClient()

    const events: SapOutboundEvent[] = [
      disposal,
      { kind: 'IMPAIRMENT_FLAG', assetNo: '100000002', reason: 'Water damage', flaggedAt: new Date() },
      {
        kind: 'LOCATION_CHANGED',
        assetNo: '100000004',
        fromCostCentre: 'KL01',
        toCostCentre: 'PJ02',
        movedAt: new Date(),
      },
    ]

    for (const event of events) {
      await expect(sap.send(event, approval)).resolves.toMatchObject({ ok: true })
    }
    expect(sap.sent).toHaveLength(3)
  })

  it('rejects a write-back with no approval reference', async () => {
    const sap = new MockSapClient()
    await expect(sap.send(disposal, { ...approval, reference: '' })).rejects.toThrow(SapApprovalRequiredError)
    expect(sap.sent).toHaveLength(0)
  })

  it('rejects a write-back with no approver', async () => {
    const sap = new MockSapClient()
    await expect(sap.send(disposal, { ...approval, approvedBy: '' })).rejects.toThrow(SapApprovalRequiredError)
  })

  it('rejects a write-back with no approval at all', () => {
    expect(() => assertApproved(disposal, undefined)).toThrow(SapApprovalRequiredError)
  })

  /**
   * The load-bearing test for ADR-0004. If the outbound union ever grows a member that
   * telemetry satisfies — or a generic escape hatch appears — the @ts-expect-error below
   * stops erroring and this test fails. That failure is the alarm.
   */
  it('makes pushing telemetry into SAP a type error', () => {
    const sap = new MockSapClient()

    // @ts-expect-error a utilisation reading is not an accounting-relevant event
    void (() => sap.send({ kind: 'UTILISATION', assetNo: '100000001', utilisationPct: 12 }, approval))

    // @ts-expect-error a heartbeat is not an accounting-relevant event
    void (() => sap.send({ kind: 'heartbeat', assetNo: '100000001', observedAt: new Date() }, approval))

    // @ts-expect-error idle telemetry is not an accounting-relevant event
    void (() => sap.send({ kind: 'IDLE', assetNo: '100000001', idleMinutes: 400 }, approval))

    expect(sap.sent).toHaveLength(0)
  })

  it('exposes no generic write method to bypass the union', () => {
    const sap = new MockSapClient() as unknown as Record<string, unknown>
    for (const escapeHatch of ['post', 'put', 'request', 'sendRaw', 'call']) {
      expect(sap[escapeHatch]).toBeUndefined()
    }
  })
})

describe('mapAssetClass', () => {
  it('maps known SAP asset classes', () => {
    expect(mapAssetClass('3000')).toBe('LAB_INSTRUMENT')
    expect(mapAssetClass('4000')).toBe('IT')
    expect(mapAssetClass('4100')).toBe('PRINTER')
  })

  it('falls back to OTHER rather than throwing on an unknown class', () => {
    // An unmapped class must not fail the nightly sync and leave the register stale.
    expect(mapAssetClass('9999')).toBe('OTHER')
  })
})
