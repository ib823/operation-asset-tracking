import { hashPassword } from '@oat/auth/server'
import { normaliseSubType } from '@oat/core'
import { PrismaClient, type AssetClass, type Role } from '@oat/db'
import { seedDemoSignals } from './demo-signals'

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
  // KL01 runs two shifts, so a scan is believed for a full day rather than half of one
  // (ADR-0013). The other sites follow the default — null means "track the default", not a
  // frozen copy of it.
  { code: 'KL01', name: 'Lablink Kuala Lumpur — Central Lab', scanTtlMinutes: 24 * 60 },
  { code: 'PJ02', name: 'Lablink Petaling Jaya', scanTtlMinutes: null },
  { code: 'JB03', name: 'Lablink Johor Bahru', scanTtlMinutes: null },
]

interface SeedAsset {
  tag: string
  name: string
  class: AssetClass
  /** Free text (ADR-0014) — Lablink names their own equipment. */
  subType?: string
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
    subType: 'Analyser',
    siteCode: 'KL01',
    location: 'Haematology Bench 1',
    serial: 'SN-XN1000-4471',
    manufacturer: 'Sysmex',
  },
  {
    tag: 'LAB-0002',
    name: 'Chemistry Analyser AU680',
    class: 'LAB_INSTRUMENT',
    subType: 'Analyser',
    siteCode: 'KL01',
    location: 'Chemistry Bench 2',
    serial: 'SN-AU680-1182',
    manufacturer: 'Beckman Coulter',
  },
  {
    tag: 'LAB-0003',
    name: 'Centrifuge 5810R',
    class: 'LAB_INSTRUMENT',
    subType: 'Centrifuge',
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
    subType: 'Analyser',
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
    subType: 'Microscope',
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
      update: { name: site.name, scanTtlMinutes: site.scanTtlMinutes },
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
        subType: normaliseSubType(asset.subType),
        siteId,
        location: asset.location,
        // Status is NOT asserted here. It is derived from seeded signals by the real engine
        // (see `seedDemoSignals` / ADR-0022) — the demo must never claim a status it has not
        // observed. The DB default only bootstraps the column before the first projection.
        attributes: { serial: asset.serial ?? null, manufacturer: asset.manufacturer ?? null },
      },
      update: { name: asset.name, siteId, location: asset.location, subType: normaliseSubType(asset.subType) },
    })
  }

  await seedUsers(siteIds)

  // Make every asset's operational state observation-backed: seed real signals and let the
  // engine derive status / idle / alerts / utilisation (never a literal). See ADR-0022.
  const demo = await seedDemoSignals(prisma)

  console.log(
    `Seeded ${SITES.length} sites, ${ASSETS.length} assets and ${USERS.length} users. ` +
      `Derived from ${demo.seededSignals} signals: ${demo.reprojected.length} assets reprojected, ` +
      `${demo.rollup.written} utilisation snapshot(s) written.`,
  )
}

interface SeedUser {
  email: string
  name: string
  roles: Role[]
  siteCode?: string
}

/** One user per RFP Appendix F role, so RBAC is demoable and testable end to end. */
const USERS: SeedUser[] = [
  { email: 'finance@lablink.example', name: 'Faridah (Finance)', roles: ['FINANCE'] },
  { email: 'purchasing@lablink.example', name: 'Prakash (Purchasing)', roles: ['PURCHASING'] },
  { email: 'branch.kl@lablink.example', name: 'Bala (Branch, KL01)', roles: ['BRANCH'], siteCode: 'KL01' },
  { email: 'branch.pj@lablink.example', name: 'Bee Ling (Branch, PJ02)', roles: ['BRANCH'], siteCode: 'PJ02' },
  { email: 'labmanager@lablink.example', name: 'Hana (HQ Lab Manager)', roles: ['HQ_LAB_MANAGER'] },
  { email: 'it@lablink.example', name: 'Iqbal (IT)', roles: ['IT'] },
  { email: 'developer@lablink.example', name: 'Devi (Developer)', roles: ['DEVELOPER'] },
]

async function seedUsers(siteIds: Map<string, string>): Promise<void> {
  // A known development password, never a secret and never a default in any real deployment.
  // Overridable so CI and a demo can differ, and so nobody is tempted to hardcode one.
  const password = process.env.OAT_SEED_PASSWORD ?? 'devpassword123'
  const passwordHash = await hashPassword(password)

  for (const user of USERS) {
    const siteId = user.siteCode ? siteIds.get(user.siteCode) : null
    if (user.siteCode && !siteId) throw new Error(`seed: no site ${user.siteCode} for user ${user.email}`)

    await prisma.user.upsert({
      where: { email: user.email },
      create: { email: user.email, name: user.name, roles: user.roles, siteId: siteId ?? null, passwordHash },
      // Re-seeding must not silently reset a password someone changed, but roles and site
      // are seed-owned and safe to refresh.
      update: { name: user.name, roles: user.roles, siteId: siteId ?? null },
    })
  }
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
