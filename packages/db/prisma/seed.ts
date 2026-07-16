import { PrismaClient, type AssetClass } from '@prisma/client'

/**
 * Phase 0 seed: 3 representative sites and 10 assets.
 *
 * The real estate is 32 sites (assumption A3). Three is enough to prove the per-site
 * dashboard groups correctly while staying legible in a demo.
 *
 * Assets are seeded WITHOUT `sapAssetNo` on purpose. They carry serial numbers, and the
 * mock SAP sync links them by serial — which both mirrors reality (an asset is tagged and
 * in use before finance capitalises it) and makes the sync's effect visible in the demo:
 * before sync, no SAP numbers; after, they appear.
 */

const prisma = new PrismaClient()

const SITES = [
  { code: 'KL01', name: 'Lablink Kuala Lumpur — Central Lab' },
  { code: 'PJ02', name: 'Lablink Petaling Jaya' },
  { code: 'JB03', name: 'Lablink Johor Bahru' },
]

interface SeedAsset {
  tag: string
  name: string
  class: AssetClass
  siteCode: string
  location: string
  serial?: string
  manufacturer?: string
}

const ASSETS: SeedAsset[] = [
  {
    tag: 'LAB-0001',
    name: 'Haematology Analyser XN-1000',
    class: 'LAB_INSTRUMENT',
    siteCode: 'KL01',
    location: 'Haematology Bench 1',
    serial: 'SN-XN1000-4471',
    manufacturer: 'Sysmex',
  },
  {
    tag: 'LAB-0002',
    name: 'Chemistry Analyser AU680',
    class: 'LAB_INSTRUMENT',
    siteCode: 'KL01',
    location: 'Chemistry Bench 2',
    serial: 'SN-AU680-1182',
    manufacturer: 'Beckman Coulter',
  },
  {
    tag: 'LAB-0003',
    name: 'Centrifuge 5810R',
    class: 'LAB_INSTRUMENT',
    siteCode: 'KL01',
    location: 'Prep Room',
    serial: 'SN-5810R-8823',
    manufacturer: 'Eppendorf',
  },
  {
    tag: 'LAB-0004',
    name: 'Reporting Workstation',
    class: 'IT',
    siteCode: 'KL01',
    location: 'Reporting Desk',
    serial: 'SN-WS-2201',
    manufacturer: 'Dell',
  },
  {
    tag: 'LAB-0005',
    name: 'Label Printer TD-4550',
    class: 'PRINTER',
    siteCode: 'PJ02',
    location: 'Reception',
    serial: 'SN-TD4550-0912',
    manufacturer: 'Brother',
  },
  {
    tag: 'LAB-0006',
    name: 'Immunoassay Analyser Architect',
    class: 'LAB_INSTRUMENT',
    siteCode: 'PJ02',
    location: 'Immunology Bench 1',
    serial: 'SN-ARCH-3310',
    manufacturer: 'Abbott',
  },
  {
    tag: 'LAB-0007',
    name: 'Phlebotomy Laptop',
    class: 'IT',
    siteCode: 'PJ02',
    location: 'Phlebotomy Room',
    serial: 'SN-LT-7741',
    manufacturer: 'Lenovo',
  },
  {
    tag: 'LAB-0008',
    name: 'Specimen Barcode Scanner',
    class: 'SCANNER',
    siteCode: 'JB03',
    location: 'Specimen Reception',
    serial: 'SN-SC-5510',
    manufacturer: 'Zebra',
  },
  {
    tag: 'LAB-0009',
    name: 'Microscope CX23',
    class: 'LAB_INSTRUMENT',
    siteCode: 'JB03',
    location: 'Microscopy Bench',
    serial: 'SN-CX23-2204',
    manufacturer: 'Olympus',
  },
  {
    tag: 'LAB-0010',
    name: 'Sample Rack Set',
    class: 'REUSABLE_COMPONENT',
    siteCode: 'JB03',
    location: 'Store Room',
    serial: 'SN-RACK-0001',
    manufacturer: 'Generic',
  },
]

async function main(): Promise<void> {
  // Upsert rather than delete-and-recreate: the seed must be safe to re-run against a
  // database that already has signals pointing at these assets.
  const siteIds = new Map<string, string>()
  for (const site of SITES) {
    const row = await prisma.site.upsert({
      where: { code: site.code },
      create: site,
      update: { name: site.name },
    })
    siteIds.set(site.code, row.id)
  }

  for (const asset of ASSETS) {
    const siteId = siteIds.get(asset.siteCode)
    if (!siteId) throw new Error(`seed: no site ${asset.siteCode} for asset ${asset.tag}`)

    await prisma.asset.upsert({
      where: { tag: asset.tag },
      create: {
        tag: asset.tag,
        name: asset.name,
        class: asset.class,
        siteId,
        location: asset.location,
        status: 'IN_USE',
        attributes: { serial: asset.serial ?? null, manufacturer: asset.manufacturer ?? null },
      },
      update: { name: asset.name, siteId, location: asset.location },
    })
  }

  console.log(`Seeded ${SITES.length} sites and ${ASSETS.length} assets.`)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
