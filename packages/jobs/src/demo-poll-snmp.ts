/**
 * One-shot SNMP demo poll — `pnpm demo:poll-snmp`.
 *
 * Runs the REAL production SNMP poll path on demand, so the demo shows real utilisation
 * immediately instead of waiting for the scheduler's 15-minute cadence. It reuses exactly
 * what the scheduler uses — `snmpConnector()` for resolution and `pollConnector()` for the
 * resolve→normalise→ingest write — so this proves the production path, it does not fake it.
 *
 * Why it polls TWICE. A printer's utilisation is a DELTA. prtMarkerLifeCount is a lifetime
 * counter; a single reading proves only that the device is reachable (a heartbeat), never
 * that it printed. Evidence of work is a SECOND reading higher than the first — which is the
 * rule the SNMP connector encodes (ADR-0008: reachable is not busy). The first poll here
 * establishes the baseline; after a short wait, during which the emulated printer's counter
 * advances, the second poll observes the pages printed since and writes `utilisation
 * busy:true`. Both reads hit the real SNMP agent over the wire.
 *
 * (The connector holds its page-count baseline in memory, so the two reads must share one
 * connector instance — which is why the demo does both in one process rather than leaning on
 * two separate scheduler ticks.)
 */
import { pollConnector } from '@oat/connectors'
import { prisma } from '@oat/db'
import { snmpConnector } from './connectors'

/** Long enough for snmpsim's page counter (rate=10/s) to advance well past the baseline. */
const WAIT_MS = Number(process.env.OAT_DEMO_SNMP_WAIT_MS ?? 3000)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function firstTargetTag(): string | null {
  const raw = process.env.OAT_SNMP_TARGETS ?? ''
  const tag = raw.split(',')[0]?.split('@')[0]?.trim()
  return tag && tag.length > 0 ? tag : null
}

async function main(): Promise<void> {
  const { connector, mode } = snmpConnector()

  // `mock` here means "no targets configured": snmpConnector() falls back to an empty target
  // list. Nothing to poll, so say what to set rather than silently doing nothing.
  if (mode !== 'real') {
    console.error(
      '[demo] No SNMP targets configured. Set OAT_CONNECTOR_SNMP=1 and OAT_SNMP_TARGETS ' +
        '(e.g. LAB-0005@snmpsim:161), then re-run. See docs/DEMO.md.',
    )
    process.exitCode = 1
    return
  }

  console.log(`[demo] SNMP poll (mode=${mode}), target(s): ${process.env.OAT_SNMP_TARGETS}`)

  console.log('[demo] poll 1/2 — establishing the page-count baseline...')
  const first = await pollConnector(prisma, connector)
  console.log(
    `[demo]   -> ${first.accepted} accepted, ${first.duplicates} duplicate(s), ` +
      `unmatched [${first.unmatched.join(', ') || 'none'}]`,
  )

  if (first.unmatched.length > 0) {
    // The target answered, but its tag matches no asset — so nothing was written. This is the
    // most likely demo misconfiguration, and a silent success would hide it.
    console.error(
      `[demo] The SNMP target tag(s) [${first.unmatched.join(', ')}] match no asset in the ` +
        'register. The connector never creates assets (ADR-0009); the target tag must equal a ' +
        'seeded asset tag (default LAB-0005). Nothing was written. Re-seed or fix OAT_SNMP_TARGETS.',
    )
    process.exitCode = 1
    return
  }

  console.log(`[demo] waiting ${WAIT_MS}ms for the printer's page counter to advance...`)
  await sleep(WAIT_MS)

  console.log('[demo] poll 2/2 — detecting pages printed since the baseline...')
  const second = await pollConnector(prisma, connector)
  console.log(
    `[demo]   -> ${second.accepted} accepted, ${second.duplicates} duplicate(s), ` +
      `unmatched [${second.unmatched.join(', ') || 'none'}]`,
  )

  // Read the result straight back from the register — the same rows the asset detail page shows.
  const tag = firstTargetTag()
  if (!tag) return

  const asset = await prisma.asset.findUnique({
    where: { tag },
    select: {
      tag: true,
      name: true,
      status: true,
      lastActiveAt: true,
      lastSeenAt: true,
      signals: {
        where: { source: 'snmp' },
        orderBy: { observedAt: 'desc' },
        take: 5,
        select: { source: true, type: true, value: true, observedAt: true },
      },
    },
  })

  if (!asset) {
    console.error(`[demo] Asset ${tag} not found after polling — unexpected.`)
    process.exitCode = 1
    return
  }

  console.log(
    `\n[demo] ${asset.tag} — ${asset.name}\n` +
      `[demo]   status=${asset.status}  lastActive=${asset.lastActiveAt?.toISOString() ?? '—'}  ` +
      `lastSeen=${asset.lastSeenAt?.toISOString() ?? '—'}`,
  )
  console.log('[demo]   recent SNMP signals (newest first):')
  for (const s of asset.signals) {
    console.log(`[demo]     ${s.observedAt.toISOString()}  ${s.source}/${s.type}  ${JSON.stringify(s.value)}`)
  }

  const gotUtilisation = asset.signals.some((s) => s.source === 'snmp' && s.type === 'utilisation')
  if (gotUtilisation) {
    console.log('\n[demo] ✔ Real SNMP utilisation signal written — visible on /assets/<id> under "Recent signals".')
  } else {
    console.log(
      '\n[demo] No utilisation signal yet — the counter may not have advanced between reads. ' +
        'Raise OAT_DEMO_SNMP_WAIT_MS (e.g. 6000) and re-run.',
    )
  }
}

main()
  .catch((error: unknown) => {
    console.error('[demo] failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
