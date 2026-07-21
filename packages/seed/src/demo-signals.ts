import {
  DEFAULT_TIMEZONE,
  ingestSignals,
  localDayBounds,
  rollUpDay,
  type SignalInput,
  type SignalSource,
} from '@oat/core'
import type { PrismaClient } from '@oat/db'

/**
 * Demo signal seeding — make every asset's operational state OBSERVATION-BACKED (ADR-0022).
 *
 * The register seeds assets, but their status must NOT be a literal: the whole product claim
 * is "we never assert what we have not measured". So instead of writing `status: IN_USE`, we
 * seed real signals — a human scan, an MDM idle report, an SNMP page-count history — and let
 * the SAME engine the live system uses derive status, idle, alerts and utilisation from them
 * (`ingestSignals` → `reprojectAsset` → `recordIdleAlert`, then `rollUpDay`). Nothing here is
 * a hardcoded status or percentage; every number the demo shows is engine-derived from these
 * signals, exactly as it would be from a real connector.
 *
 * The demo's connector posture matches the compose demo: SCAN (fallback floor), SOTI (a mock
 * MDM) and SNMP (the on-LAN collector) are deployed; osquery/LIS are not (client deps C4/C6).
 * So instruments derive utilisation from nothing (LIS absent → "not measured", ADR-0008),
 * and their status is human-scan-backed — which is honest, not a gap.
 *
 * All seeded signals carry a `seed:` dedupeKey prefix, so re-seeding replaces them cleanly
 * without touching real signals a collector may have pushed.
 */

/** Connectors the demo treats as deployed. Drives rollup eligibility (ADR-0015), honestly. */
const DEMO_ENABLED_SOURCES: SignalSource[] = ['scan', 'soti', 'snmp']

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export interface DemoSignalSummary {
  seededSignals: number
  reprojected: string[]
  rollup: { eligible: number; written: number; unobserved: number }
}

/**
 * Seed observation-backed state for the demo estate and derive everything from it.
 *
 * Idempotent: clears prior `seed:` signals and the derived tables for the seeded assets, then
 * re-seeds relative to now and re-derives.
 */
export async function seedDemoSignals(prisma: PrismaClient): Promise<DemoSignalSummary> {
  const now = new Date()
  const assets = await prisma.asset.findMany({ select: { id: true, tag: true } })
  const idByTag = new Map(assets.map((a) => [a.tag, a.id]))
  const ids = assets.map((a) => a.id)

  // Reset derived state and prior demo signals only. Real collector signals (non-`seed:`
  // dedupeKeys) are preserved; the alerts/snapshots below are caches and are rebuilt.
  await prisma.idleAlert.deleteMany({ where: { assetId: { in: ids } } })
  await prisma.conflictAlert.deleteMany({ where: { assetId: { in: ids } } })
  await prisma.utilisationSnapshot.deleteMany({ where: { assetId: { in: ids } } })
  await prisma.signalEvent.deleteMany({ where: { assetId: { in: ids }, dedupeKey: { startsWith: 'seed:' } } })

  const signals: SignalInput[] = []
  const push = (s: SignalInput) => signals.push(s)

  /** A human scanned this asset and marked it in use — the fallback-floor observation. */
  const scanInUse = (tag: string, minutesAgo: number) => {
    const id = idByTag.get(tag)
    if (!id) return
    push({
      assetId: id,
      source: 'scan',
      type: 'status',
      value: { status: 'IN_USE' },
      observedAt: new Date(now.getTime() - minutesAgo * MIN),
      dedupeKey: `seed:scan:${tag}`,
    })
  }

  /** An MDM (SOTI) reported this endpoint idle — `idleMinutes` before the report. */
  const sotiIdle = (tag: string, idleMinutes: number, reportedMinutesAgo: number) => {
    const id = idByTag.get(tag)
    if (!id) return
    push({
      assetId: id,
      source: 'soti',
      type: 'idle',
      value: { idleMinutes },
      observedAt: new Date(now.getTime() - reportedMinutesAgo * MIN),
      dedupeKey: `seed:soti-idle:${tag}`,
    })
  }

  // 1. Observation-backed IN_USE via a recent human scan (analysers, scanner, microscope,
  //    reusable rack). Instruments have no LIS, so utilisation stays "not measured" — the
  //    status is what a human vouched for, nothing more claimed.
  for (const tag of ['LAB-0001', 'LAB-0002', 'LAB-0003', 'LAB-0006', 'LAB-0008', 'LAB-0009', 'LAB-0010']) {
    scanInUse(tag, 180) // scanned ~3h ago, within the scan TTL → IN_USE (ADR-0010)
  }

  // 2. The money story: an IT workstation the MDM has seen idle for ~9 days. Past the IT
  //    alert threshold (7 days) → the engine raises an idle alert. IDLE + alert, both derived.
  sotiIdle('LAB-0004', 9 * 24 * 60, 20)

  // 3. A laptop idle ~95 min — past the IT idle threshold (30m) but well under the alert
  //    threshold. IDLE, no alert: shows the distinction is real, not cosmetic.
  sotiIdle('LAB-0007', 95, 10)

  // 4. The printer (LAB-0005): a recent SNMP page-count move keeps it IN_USE now, and a full
  //    day of SNMP history yesterday gives the rollup engine a real utilisation % to compute.
  const printerId = idByTag.get('LAB-0005')
  if (printerId) {
    // Recent activity → IN_USE now (independent of whether the live collector has run).
    push({
      assetId: printerId,
      source: 'snmp',
      type: 'utilisation',
      value: { busy: true },
      observedAt: new Date(now.getTime() - 25 * MIN),
      dedupeKey: `seed:snmp-live:LAB-0005`,
    })

    // Yesterday, local day: an SNMP sweep every 30 min across the working day (coverage), with
    // one genuine print job. The engine computes observed vs busy → a real sub-100% figure.
    const { start } = localDayBounds(new Date(now.getTime() - DAY), DEFAULT_TIMEZONE)
    const firstPoll = 8 * 60 // 08:00 local
    const lastPoll = 20 * 60 // 20:00 local
    const busyAt = 10 * 60 // one print job around 10:00 (PRINTER threshold marks 4h busy)
    for (let m = firstPoll, i = 0; m <= lastPoll; m += 30, i++) {
      const observedAt = new Date(start.getTime() + m * MIN)
      const busy = m === busyAt
      push({
        assetId: printerId,
        source: 'snmp',
        type: busy ? 'utilisation' : 'heartbeat',
        value: busy ? { busy: true } : {},
        observedAt,
        dedupeKey: `seed:snmp-y:LAB-0005:${i}`,
      })
    }
  }

  // Persist + derive status/idle/alerts through the real pipeline (never a literal write).
  const result = await ingestSignals(prisma, signals)

  // Roll up yesterday for the deployed activity sources → the utilisation snapshot the
  // dashboard reads. Only classes with a deployed source and real coverage get a figure;
  // everything else is honestly "not measured".
  const rollup = await rollUpDay(prisma, {
    day: new Date(now.getTime() - DAY),
    enabledSources: DEMO_ENABLED_SOURCES,
  })

  return {
    seededSignals: result.accepted,
    reprojected: result.assetsUpdated,
    rollup: { eligible: rollup.eligible, written: rollup.written, unobserved: rollup.unobserved },
  }
}
