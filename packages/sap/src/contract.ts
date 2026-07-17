/**
 * The SAP boundary, as types.
 *
 * SAP FI-AA is the financial system of record. The OAT is the operational layer. They
 * share `sapAssetNo` and nothing else. This file is the whole of the permitted surface —
 * see docs/decisions/0004-sap-boundary-typed-contract.md.
 *
 *   SAP → OAT   one-way master sync                    (SapMasterSource)
 *   OAT → SAP   accounting-relevant events only        (SapEventSink)
 *   signals     never cross into SAP                   (not representable below)
 */

/** An asset as SAP FI-AA knows it. Financial fields stay in SAP; we read identity only. */
export interface SapAssetMasterRecord {
  /** SAP asset number — the shared key. */
  assetNo: string
  description: string
  /** SAP cost centre; maps to an OAT Site via site code. */
  costCentre: string
  /** SAP asset class; mapped to an OAT AssetClass by `mapAssetClass`. */
  assetClass: string
  /**
   * SAP FI-AA's inventory number field, holding the OAT asset tag where Lablink populates it.
   *
   * The strongest match we get (ADR-0009): a human deliberately wrote the same number into
   * both systems, which is a statement of identity rather than an inference.
   */
  inventoryNumber?: string
  serialNumber?: string
  manufacturer?: string
  /** Capitalisation date. Read for reference; the OAT never computes on it. */
  capitalisedOn?: string
  /** True when SAP has deactivated/retired the asset. */
  deactivated?: boolean
}

/**
 * The three event types the OAT may write back to SAP. Each is accounting-relevant — it
 * changes something the financial ledger is entitled to know.
 *
 * This union is deliberately closed. Telemetry has no member here, so "push utilisation to
 * SAP" is not a policy question to be argued in review — it is a type error.
 */
export type SapOutboundEvent =
  | {
      kind: 'DISPOSAL_PROPOSED'
      assetNo: string
      /** Operational justification for the finance team, not a telemetry dump. */
      reason: string
      proposedAt: Date
    }
  | {
      kind: 'IMPAIRMENT_FLAG'
      assetNo: string
      reason: string
      flaggedAt: Date
    }
  | {
      kind: 'LOCATION_CHANGED'
      assetNo: string
      /** Cost centre codes — the only location concept SAP shares with us. */
      fromCostCentre: string | null
      toCostCentre: string
      movedAt: Date
    }

/**
 * Authorisation for a write-back. No event reaches SAP without one.
 *
 * Types are erased at runtime and this path may one day be driven by a queue payload, so
 * the sink revalidates rather than trusting that the compiler already did.
 */
export interface SapWriteApproval {
  approvedBy: string
  approvedAt: Date
  /** OAT-side reference (approval record id) for the audit trail. */
  reference: string
}

/** Inbound port: read-only by construction. It has no write method to grow into one. */
export interface SapMasterSource {
  /** Fetch the asset master, optionally only records changed since a watermark. */
  fetchAssetMaster(options?: { changedSince?: Date }): Promise<SapAssetMasterRecord[]>
}

/** Outbound port: accepts only the closed event union, only with an approval. */
export interface SapEventSink {
  send(event: SapOutboundEvent, approval: SapWriteApproval): Promise<SapWriteResult>
}

export interface SapWriteResult {
  ok: boolean
  /** SAP-side document/reference id when the write succeeded. */
  sapReference?: string
  error?: string
}

/** Thrown when a write-back is attempted without a usable approval. */
export class SapApprovalRequiredError extends Error {
  constructor(kind: SapOutboundEvent['kind']) {
    super(`SAP write-back rejected: ${kind} requires an approval reference`)
    this.name = 'SapApprovalRequiredError'
  }
}

export function assertApproved(event: SapOutboundEvent, approval: SapWriteApproval | undefined): void {
  if (!approval?.reference || !approval.approvedBy) {
    throw new SapApprovalRequiredError(event.kind)
  }
}

/**
 * Map an SAP asset class to an OAT one.
 *
 * The mapping is a placeholder until the client supplies their real class list
 * (assumption A2). Unknown classes fall to OTHER rather than throwing: a class we have not
 * seen is a reason to review a mapping table, not to fail the nightly sync and leave the
 * register stale.
 */
const SAP_CLASS_MAP: Record<string, string> = {
  '3000': 'LAB_INSTRUMENT',
  '3100': 'LAB_INSTRUMENT',
  '4000': 'IT',
  '4100': 'PRINTER',
  '4200': 'SCANNER',
  '5000': 'REUSABLE_COMPONENT',
}

export function mapAssetClass(sapClass: string): string {
  return SAP_CLASS_MAP[sapClass] ?? 'OTHER'
}
