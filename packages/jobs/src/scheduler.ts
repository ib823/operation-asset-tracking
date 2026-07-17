import { pollConnector, resolveConnectorFlags } from '@oat/connectors'
import { rollUpDay, sweepIdleAssets } from '@oat/core'
import { prisma } from '@oat/db'
import { PgBoss } from 'pg-boss'
import {
  connectorCoverageGaps,
  enabledActivitySources,
  osqueryConnector,
  snmpConnector,
  sotiConnector,
} from './connectors'

/**
 * The scheduler (ADR-0005: pg-boss, one queue, in Postgres).
 *
 * Wired ONCE, here, for everything that runs on a clock:
 *
 *   - connector polls        each adapter's own cadence
 *   - the idle sweep         turns silence into IDLE, and expires scan TTLs
 *   - the utilisation rollup nightly, over yesterday
 *
 * Deliberately not three mechanisms. Every one of these was a manual endpoint through Phases
 * 1-2, which was fine for a demo and useless in production: idleness accrues *because*
 * nothing is reported, so nothing will ever trigger its own discovery.
 *
 * The endpoints stay. They are the same code path, and being able to run a rollup by hand —
 * after fixing a threshold, say — is worth keeping.
 */

let boss: PgBoss | null = null

/** Queue names. Stable strings: pg-boss persists them, so renaming one orphans its jobs. */
const QUEUE = {
  pollSoti: 'poll-soti',
  pollOsquery: 'poll-osquery',
  pollSnmp: 'poll-snmp',
  sweep: 'idle-sweep',
  rollup: 'utilisation-rollup',
} as const

/**
 * Cron in UTC, because pg-boss schedules in UTC.
 *
 * The rollup runs at 00:30 Asia/Kuala_Lumpur = 16:30 UTC the previous day (A6). It rolls up
 * *yesterday* local, so it must run after that day has actually ended locally — running at
 * UTC midnight would roll up a day still half in progress in Malaysia, and produce a figure
 * that changes when you look again.
 */
const ROLLUP_CRON = '30 16 * * *'

/** Every 5 minutes. Idleness and TTL expiry are clock-driven, so the sweep IS the mechanism. */
const SWEEP_CRON = '*/5 * * * *'

/** A cron expression running every `minutes` minutes, floored to a whole minute. */
function everyMinutes(minutes: number): string {
  return `*/${Math.max(1, Math.floor(minutes))} * * * *`
}

/**
 * Start the scheduler. Idempotent — a second call is a no-op.
 *
 * Safe with multiple app instances: pg-boss locks jobs in Postgres, and `schedule()` upserts,
 * so N replicas produce one run per tick rather than N.
 */
export async function startScheduler(): Promise<PgBoss | null> {
  if (boss) return boss

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('[scheduler] DATABASE_URL is not set; not starting')
    return null
  }

  const instance = new PgBoss({
    connectionString,
    // pg-boss owns its own schema, so its tables never collide with Prisma's migrations and
    // `prisma migrate` never tries to drop them.
    schema: 'pgboss',
    // The queue shares the app's database, so it must not eat the connection budget the
    // requests need (ADR-0005 named this as the cost of one-database).
    max: 4,
  })

  instance.on('error', (error: unknown) => console.error('[scheduler] pg-boss error:', error))

  await instance.start()
  boss = instance

  const flags = resolveConnectorFlags()

  // Only schedule a connector that is actually deployed. A poll against a system that is not
  // there is noise in the log every 5 minutes forever, and trains everyone to ignore it.
  if (flags.soti) {
    await register(instance, QUEUE.pollSoti, everyMinutes(sotiConnector().connector.pollIntervalMinutes), async () => {
      const { connector, mode } = sotiConnector()
      const result = await pollConnector(prisma, connector)
      const detail = `${mode}: ${result.accepted} accepted, ${result.unmatched.length} unmatched`
      console.log(`[scheduler] soti ${detail}`)
      return detail
    })
  }

  if (flags.osquery) {
    await register(
      instance,
      QUEUE.pollOsquery,
      everyMinutes(osqueryConnector().connector.pollIntervalMinutes),
      async () => {
        const { connector, mode } = osqueryConnector()
        const result = await pollConnector(prisma, connector)
        const detail = `${mode}: ${result.accepted} accepted`
        console.log(`[scheduler] osquery ${detail}`)
        return detail
      },
    )
  }

  if (flags.snmp) {
    await register(instance, QUEUE.pollSnmp, everyMinutes(snmpConnector().connector.pollIntervalMinutes), async () => {
      const { connector, mode } = snmpConnector()
      const result = await pollConnector(prisma, connector)
      const detail = `${mode}: ${result.accepted} accepted`
      console.log(`[scheduler] snmp ${detail}`)
      return detail
    })
  }

  // The sweep and the rollup run whatever connectors are deployed. With none, the sweep is a
  // cheap no-op and the rollup writes nothing — which is the correct behaviour, not an
  // error: the register still works via scan (graceful degradation).
  await register(instance, QUEUE.sweep, SWEEP_CRON, async () => {
    const { swept } = await sweepIdleAssets(prisma)
    if (swept > 0) console.log(`[scheduler] idle sweep: ${swept} assets re-projected`)
    return `${swept} assets re-projected`
  })

  await register(instance, QUEUE.rollup, ROLLUP_CRON, async () => {
    const summary = await rollUpDay(prisma, {
      enabledSources: enabledActivitySources(),
      coverageGaps: connectorCoverageGaps(),
    })
    const detail =
      `${summary.periodStart.toISOString().slice(0, 10)}: ${summary.written} written, ` +
      `${summary.unobserved} unobserved, skipped [${summary.skippedClasses.join(', ')}]`
    console.log(`[scheduler] rollup ${detail}`)
    return detail
  })

  console.log('[scheduler] started')
  return instance
}

/**
 * Create a queue, attach its worker, and put it on a cron.
 *
 * A handler that throws must not take the scheduler down — one unreachable MDM is not a
 * reason to stop sweeping idle assets. pg-boss retries the job; we log and move on.
 */
async function register(instance: PgBoss, queue: string, cron: string, handler: () => Promise<string>): Promise<void> {
  await instance.createQueue(queue)

  await instance.work(queue, async () => {
    const startedAt = new Date()
    // Record the START before doing the work: a job that hangs forever leaves a row with a
    // startedAt and no finishedAt, which is exactly the state worth seeing. Only writing on
    // success would make a wedged worker indistinguishable from an absent one.
    await recordRun(queue, { startedAt, ok: true, detail: 'running' })

    try {
      const detail = await handler()
      await recordRun(queue, { startedAt, finishedAt: new Date(), ok: true, detail })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`[scheduler] ${queue} failed:`, detail)
      await recordRun(queue, { startedAt, finishedAt: new Date(), ok: false, detail })
      // Rethrow so pg-boss retries. The heartbeat is for humans; the retry is for the job.
      throw error
    }
  })

  await instance.schedule(queue, cron)
}

/**
 * Record a job's heartbeat.
 *
 * Never allowed to fail the job: a heartbeat that breaks the work it measures would be worse
 * than no heartbeat. If this write fails, the run still counts — the row just goes stale, and
 * a stale row is the signal anyway.
 */
async function recordRun(
  queue: string,
  run: { startedAt: Date; finishedAt?: Date; ok: boolean; detail?: string },
): Promise<void> {
  try {
    await prisma.jobRun.upsert({
      where: { queue },
      create: { queue, ...run },
      update: { ...run, finishedAt: run.finishedAt ?? null },
    })
  } catch (error) {
    console.error(`[scheduler] could not record run for ${queue}:`, error instanceof Error ? error.message : error)
  }
}

/** Stop the scheduler. For tests and for a clean shutdown. */
export async function stopScheduler(): Promise<void> {
  if (!boss) return
  await boss.stop({ graceful: true })
  boss = null
}

export const SCHEDULER_QUEUES = QUEUE
export const SCHEDULER_CRON = { rollup: ROLLUP_CRON, sweep: SWEEP_CRON }
export { everyMinutes }
