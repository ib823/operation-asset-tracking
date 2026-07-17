import type { PrismaClient } from '@oat/db'

/**
 * Is the scheduler alive, and has it done anything lately? (ADR-0022)
 *
 * This exists because a deployment with no worker looks **perfectly healthy**. Every page
 * loads. Nothing errors. `/api/health` says the database answers. And the whole operational
 * picture quietly freezes: no asset ever goes idle, no scan TTL ever expires, no rollup is
 * ever written. The dashboard shows yesterday's truth forever, with total confidence.
 *
 * The only evidence is an ABSENCE — a heartbeat that stopped — and an absence has to be
 * looked for. Nothing else in the system will ever raise its hand.
 */

/** The sweep is the one that matters: it is what turns silence into IDLE. */
export const SWEEP_QUEUE = 'idle-sweep'

/**
 * How far behind the sweep may fall before we call the worker stale.
 *
 * The sweep runs every 5 minutes, so 15 is three missed runs — the same "one is noise, three
 * is a fault" reasoning as the connector coverage gaps (ADR-0018).
 */
export const SWEEP_STALE_AFTER_MINUTES = 15

export type WorkerState =
  /** Ran recently, and succeeded. */
  | 'healthy'
  /** Ran recently, and failed. Something is wrong, but the worker is alive. */
  | 'failing'
  /** Ran once, but not lately. The worker has stopped or is wedged. */
  | 'stale'
  /** Never ran at all. The worker has probably never been deployed. */
  | 'never-run'

export interface JobHealth {
  queue: string
  state: WorkerState
  lastStartedAt: Date | null
  lastFinishedAt: Date | null
  minutesAgo: number | null
  ok: boolean
  detail: string | null
}

export interface WorkerHealth {
  /** The overall verdict, driven by the sweep. */
  state: WorkerState
  /** True only when the sweep is healthy. What the UI should key off. */
  healthy: boolean
  jobs: JobHealth[]
}

function minutesSince(at: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000))
}

function stateOf(
  run: { startedAt: Date; finishedAt: Date | null; ok: boolean },
  now: Date,
  staleAfter: number,
): WorkerState {
  // Measured from the START, not the finish: a job that began and never finished is wedged,
  // and keying off finishedAt would leave it looking merely "not finished yet" forever.
  const age = minutesSince(run.startedAt, now)

  if (age > staleAfter) return 'stale'
  if (!run.ok) return 'failing'
  return 'healthy'
}

/**
 * Report the scheduler's health.
 *
 * Pure of clock reads (`now` is passed) so it is testable without waiting 15 minutes.
 */
export async function workerHealth(
  prisma: PrismaClient,
  options: { now?: Date; staleAfterMinutes?: number } = {},
): Promise<WorkerHealth> {
  const now = options.now ?? new Date()
  const staleAfter = options.staleAfterMinutes ?? SWEEP_STALE_AFTER_MINUTES

  const runs = await prisma.jobRun.findMany({ orderBy: { queue: 'asc' } })

  const jobs: JobHealth[] = runs.map((run) => ({
    queue: run.queue,
    state: stateOf(run, now, staleAfter),
    lastStartedAt: run.startedAt,
    lastFinishedAt: run.finishedAt,
    minutesAgo: minutesSince(run.startedAt, now),
    ok: run.ok,
    detail: run.detail,
  }))

  const sweep = jobs.find((job) => job.queue === SWEEP_QUEUE)

  // No sweep row at all means the worker has never run — which is the case worth shouting
  // about, and the one a naive "is the last run recent?" check reports as simply `false`
  // without saying why.
  const state: WorkerState = sweep?.state ?? 'never-run'

  return { state, healthy: state === 'healthy', jobs }
}
