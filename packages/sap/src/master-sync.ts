import type { Asset, AssetClass, PrismaClient, ReconciliationReason } from '@oat/db'
import { mapAssetClass, type SapAssetMasterRecord, type SapMasterSource } from './contract'

/**
 * SAP → OAT one-way asset master sync (ADR-0009).
 *
 * Idempotent: safe on any schedule, and safe to re-run after a partial failure. Writes
 * nothing back to SAP — this module holds no sink and cannot.
 *
 * Matching precedence: existing link → tag → serial → manual (reconciliation queue).
 *
 * The OAT never creates assets. SAP knowing about an asset is not evidence that anyone
 * tagged it; a sync that can invent register rows can poison the register unattended at 2am,
 * and every phantom row would look exactly as legitimate as a real one.
 */

export interface SyncResult {
  fetched: number
  /** Existing OAT assets newly matched to an SAP record. */
  linked: number
  updated: number
  /** SAP records that could not be placed and now await a human. */
  queued: number
}

export interface SyncOptions {
  changedSince?: Date
  /** Actor recorded in the audit trail. */
  actor?: string
}

/**
 * Fields SAP owns. The OAT mirrors them for display and never edits them — the ledger is
 * authoritative for identity and classification, so a local edit would silently diverge and
 * be overwritten by the next sync anyway.
 */
function ownedBySap(record: SapAssetMasterRecord) {
  return {
    name: record.description,
    class: mapAssetClass(record.assetClass) as AssetClass,
  }
}

function sapAttributes(record: SapAssetMasterRecord) {
  return {
    serial: record.serialNumber ?? null,
    manufacturer: record.manufacturer ?? null,
    capitalisedOn: record.capitalisedOn ?? null,
    sapAssetClass: record.assetClass,
    sapCostCentre: record.costCentre,
  }
}

export async function syncAssetMaster(
  prisma: PrismaClient,
  source: SapMasterSource,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const actor = options.actor ?? 'system:sap-sync'
  const records = await source.fetchAssetMaster(options.changedSince ? { changedSince: options.changedSince } : {})

  const result: SyncResult = { fetched: records.length, linked: 0, updated: 0, queued: 0 }

  const sites = await prisma.site.findMany({ select: { id: true, code: true } })
  const siteByCode = new Map(sites.map((s) => [s.code, s.id]))

  for (const record of records) {
    // Cost centre is the only site signal SAP gives us. An unmapped one means our site list
    // is behind SAP — a configuration gap for a human, not a reason to invent a site or to
    // abort the run and leave the rest of the estate unsynced.
    const siteId = siteByCode.get(record.costCentre)
    if (!siteId) {
      await queue(prisma, record, 'UNKNOWN_COST_CENTRE')
      result.queued++
      continue
    }

    const match = await findMatch(prisma, record)

    if (match.kind === 'conflict') {
      // A serial or tag we recognise, on an asset already linked to a different SAP number.
      // Never silently re-point: one of the two records is wrong and only a human can say
      // which.
      await queue(prisma, record, 'CONFLICTING_LINK')
      result.queued++
      continue
    }

    if (match.kind === 'none') {
      await queue(prisma, record, 'NO_MATCH')
      result.queued++
      continue
    }

    const existing = match.asset
    const isNewLink = existing.sapAssetNo === null

    const before = {
      sapAssetNo: existing.sapAssetNo,
      name: existing.name,
      class: existing.class,
      siteId: existing.siteId,
      status: existing.status,
    }

    const updated = await prisma.asset.update({
      where: { id: existing.id },
      data: {
        sapAssetNo: record.assetNo,
        siteId,
        ...ownedBySap(record),
        // SAP retiring an asset is authoritative — it has left the books. But SAP must not
        // dictate operational status otherwise: it has no idea whether a machine is idle or
        // under repair, and overwriting that would erase the very thing the OAT exists for.
        ...(record.deactivated ? { status: 'RETIRED' as const } : {}),
        attributes: { ...(existing.attributes as object), ...sapAttributes(record) },
      },
    })

    if (isNewLink) result.linked++
    else result.updated++

    await audit(prisma, actor, isNewLink ? 'SAP_SYNC_LINK' : 'SAP_SYNC_UPDATE', updated.id, before, {
      sapAssetNo: updated.sapAssetNo,
      name: updated.name,
      class: updated.class,
      siteId: updated.siteId,
      status: updated.status,
      matchedBy: match.kind,
    })

    // The record is placed, so any queue item for it is now stale.
    await prisma.reconciliationItem.updateMany({
      where: { sapAssetNo: record.assetNo, status: 'OPEN' },
      data: { status: 'RESOLVED', resolvedAssetId: updated.id, resolvedBy: actor, resolvedAt: new Date() },
    })
  }

  return result
}

type Match = { kind: 'sapAssetNo' | 'tag' | 'serial'; asset: Asset } | { kind: 'none' } | { kind: 'conflict' }

/**
 * Find the OAT asset an SAP record refers to (ADR-0009).
 *
 * Precedence: existing link → tag → serial. Tag before serial because a tag match is a
 * deliberate human statement that these are the same asset — someone wrote the same number
 * into both systems — whereas a serial match is an inference from data the two systems
 * captured independently.
 *
 * Only ever adopts an UNLINKED asset. One already carrying a different sapAssetNo is a data
 * conflict to investigate, never something to re-point.
 */
async function findMatch(prisma: PrismaClient, record: SapAssetMasterRecord): Promise<Match> {
  const linked = await prisma.asset.findUnique({ where: { sapAssetNo: record.assetNo } })
  if (linked) return { kind: 'sapAssetNo', asset: linked }

  if (record.inventoryNumber) {
    const byTag = await prisma.asset.findUnique({ where: { tag: record.inventoryNumber } })
    if (byTag) {
      return byTag.sapAssetNo === null ? { kind: 'tag', asset: byTag } : { kind: 'conflict' }
    }
  }

  if (record.serialNumber) {
    const bySerial = await prisma.asset.findFirst({
      where: { attributes: { path: ['serial'], equals: record.serialNumber } },
    })
    if (bySerial) {
      return bySerial.sapAssetNo === null ? { kind: 'serial', asset: bySerial } : { kind: 'conflict' }
    }
  }

  return { kind: 'none' }
}

/**
 * Queue an SAP record for human reconciliation.
 *
 * Upsert on sapAssetNo: a nightly sync must not stack a fresh item every run for the same
 * unresolved record. `lastSeenAt` bumps via @updatedAt, so age — the thing worth alerting on
 * — stays accurate.
 */
async function queue(prisma: PrismaClient, record: SapAssetMasterRecord, reason: ReconciliationReason): Promise<void> {
  const sapRecord = JSON.parse(JSON.stringify(record))

  await prisma.reconciliationItem.upsert({
    where: { sapAssetNo: record.assetNo },
    create: { sapAssetNo: record.assetNo, sapRecord, reason },
    // Refresh the record and reason, but never revive one a human already dismissed — that
    // would re-open the same settled argument every night until they stopped reading the queue.
    update: { sapRecord, reason },
  })
}

async function audit(
  prisma: PrismaClient,
  actor: string,
  action: string,
  entityId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await prisma.auditLog.create({
    data: { actor, action, entity: 'Asset', entityId, before: before as never, after: after as never },
  })
}
