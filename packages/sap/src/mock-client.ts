import {
  assertApproved,
  type SapAssetMasterRecord,
  type SapEventSink,
  type SapMasterSource,
  type SapOutboundEvent,
  type SapWriteApproval,
  type SapWriteResult,
} from './contract'

/**
 * An in-memory stand-in for SAP S/4HANA Public Cloud.
 *
 * We have no tenant or endpoint yet (assumption A2), and waiting for one would block every
 * other part of the system. Building against the ports instead means the real OData client
 * is a config swap, and it gives the sync path a deterministic test double permanently —
 * we would want one of these even with a live tenant.
 */
export class MockSapClient implements SapMasterSource, SapEventSink {
  private readonly records: SapAssetMasterRecord[]
  /** Every write-back attempted, for assertions in tests and for the demo. */
  readonly sent: Array<{ event: SapOutboundEvent; approval: SapWriteApproval }> = []

  constructor(records: SapAssetMasterRecord[] = DEMO_ASSET_MASTER) {
    this.records = records
  }

  async fetchAssetMaster(options: { changedSince?: Date } = {}): Promise<SapAssetMasterRecord[]> {
    // The mock holds no change timestamps, so a delta request returns everything. The sync
    // is an idempotent upsert, so a full pull is correct — just less efficient than the
    // real delta will be.
    void options.changedSince
    return structuredClone(this.records)
  }

  async send(event: SapOutboundEvent, approval: SapWriteApproval): Promise<SapWriteResult> {
    assertApproved(event, approval)
    this.sent.push({ event, approval })
    return { ok: true, sapReference: `MOCK-${event.kind}-${this.sent.length}` }
  }
}

/**
 * Demo asset master. Cost centres correspond to the seeded site codes, and asset numbers
 * to the seeded tags, so the mock sync has something to match on.
 */
export const DEMO_ASSET_MASTER: SapAssetMasterRecord[] = [
  {
    assetNo: '100000001',
    description: 'Haematology Analyser XN-1000',
    costCentre: 'KL01',
    assetClass: '3000',
    serialNumber: 'SN-XN1000-4471',
    manufacturer: 'Sysmex',
    capitalisedOn: '2023-04-11',
  },
  {
    assetNo: '100000002',
    description: 'Chemistry Analyser AU680',
    costCentre: 'KL01',
    assetClass: '3000',
    serialNumber: 'SN-AU680-1182',
    manufacturer: 'Beckman Coulter',
    capitalisedOn: '2022-09-30',
  },
  {
    assetNo: '100000003',
    description: 'Centrifuge 5810R',
    costCentre: 'KL01',
    assetClass: '3100',
    serialNumber: 'SN-5810R-8823',
    manufacturer: 'Eppendorf',
    capitalisedOn: '2024-01-15',
  },
  {
    assetNo: '100000004',
    description: 'Reporting Workstation',
    costCentre: 'KL01',
    assetClass: '4000',
    serialNumber: 'SN-WS-2201',
    manufacturer: 'Dell',
    capitalisedOn: '2024-06-02',
  },
  {
    assetNo: '100000005',
    description: 'Label Printer TD-4550',
    costCentre: 'PJ02',
    assetClass: '4100',
    serialNumber: 'SN-TD4550-0912',
    manufacturer: 'Brother',
    capitalisedOn: '2023-11-20',
  },
  {
    assetNo: '100000006',
    description: 'Immunoassay Analyser Architect',
    costCentre: 'PJ02',
    assetClass: '3000',
    serialNumber: 'SN-ARCH-3310',
    manufacturer: 'Abbott',
    capitalisedOn: '2021-07-08',
  },
  {
    assetNo: '100000007',
    description: 'Phlebotomy Laptop',
    costCentre: 'PJ02',
    assetClass: '4000',
    serialNumber: 'SN-LT-7741',
    manufacturer: 'Lenovo',
    capitalisedOn: '2025-02-14',
  },
  {
    assetNo: '100000008',
    description: 'Specimen Barcode Scanner',
    costCentre: 'JB03',
    assetClass: '4200',
    serialNumber: 'SN-SC-5510',
    manufacturer: 'Zebra',
    capitalisedOn: '2024-08-19',
  },
  {
    assetNo: '100000009',
    description: 'Microscope CX23',
    costCentre: 'JB03',
    assetClass: '3100',
    serialNumber: 'SN-CX23-2204',
    manufacturer: 'Olympus',
    capitalisedOn: '2022-03-05',
  },
  {
    assetNo: '100000010',
    description: 'Sample Rack Set',
    costCentre: 'JB03',
    assetClass: '5000',
    manufacturer: 'Generic',
    capitalisedOn: '2024-10-01',
  },
]
