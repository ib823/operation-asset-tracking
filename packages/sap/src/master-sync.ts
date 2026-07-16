import type { AssetClass, PrismaClient } from '@oat/db'
import { mapAssetClass, type SapAssetMasterRecord, type SapMasterSource } from './contract'

/**
 * SAP → OAT one-way asset master sync.
 *
 * Idempotent: safe to run on any schedule, and safe to re-run after a partial failure.
 * Writes nothing back to SAP — this module holds no sink and cannot.
 */

export interface SyncResult {
  fetched: number
  created: number
  /** Existing OAT assets newly matched to an SAP record. */
  linked: number
  updated: number
  /** SAP records that could not be placed at a site. */
  skipped: Array<{ assetNo: string; reason: string }>
}

export interface SyncOptions {
  changedSince?: Date
  /** Actor recorded in the audit trail. */
  actor?: string
}

/**
 * Fields SAP owns. The OAT mirrors them for display and never edits them — the ledger is
 * authoritative for identity and classification, so a local edit would silently diverge
 * and be overwritten by the next sync anyway.
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

  const result: SyncResult = { fetched: records.length, created: 0, linked: 0, updated: 0, skipped: [] }

  const sites = await prisma.site.findMany({ select: { id: true, code: true } })
  const siteByCode = new Map(sites.map((s) => [s.code, s.id]))

  for (const record of records) {
    // Cost centre is the only site signal SAP gives us. An unmapped one means the site list
    // is behind SAP — a configuration gap to report, not a reason to invent a site or to
    // abort the run and leave the rest of the estate unsynced.
    const siteId = siteByCode.get(record.costCentre)
    if (!siteId) {
      result.skipped.push({ assetNo: record.assetNo, reason: `no site for cost centre ${record.costCentre}` })
      continue
    }

    const existing = await findMatch(prisma, record)

    if (!existing) {
      // SAP knows an asset we have never tagged. Create it so it is visible in the
      // register; the physical tag is applied later and reconciled by scan.
      const created = await prisma.asset.create({
        data: {
          sapAssetNo: record.assetNo,
          tag: `SAP-${record.assetNo}`,
          siteId,
          ...ownedBySap(record),
          status: record.deactivated ? 'RETIRED' : 'IN_USE',
          attributes: sapAttributes(record),
        },
      })
      result.created++
      await audit(prisma, actor, 'SAP_SYNC_CREATE', created.id, null, { sapAssetNo: record.assetNo })
      continue
    }

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
    })
  }

  return result
}

/**
 * Find the OAT asset an SAP record refers to.
 *
 * Two-step because an asset is usually tagged and in operational use *before* finance
 * capitalises it: the SAP number does not exist yet at tagging time. Serial number is the
 * only identifier both systems independently hold, so it is what bridges the gap the first
 * time; after that, `sapAssetNo` is the stable key.
 */
async function findMatch(prisma: PrismaClient, record: SapAssetMasterRecord) {
  const byAssetNo = await prisma.asset.findUnique({ where: { sapAssetNo: record.assetNo } })
  if (byAssetNo) return byAssetNo

  if (!record.serialNumber) return null

  // Only ever adopt an *unlinked* asset. An asset already carrying a different sapAssetNo
  // is a data conflict to be investigated, not silently re-pointed.
  return prisma.asset.findFirst({
    where: { sapAssetNo: null, attributes: { path: ['serial'], equals: record.serialNumber } },
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
    data: {
      actor,
      action,
      entity: 'Asset',
      entityId,
      before: before as never,
      after: after as never,
    },
  })
}
