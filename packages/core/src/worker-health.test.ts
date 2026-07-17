import { describe, expect, it, vi } from 'vitest'
import { SWEEP_QUEUE, workerHealth } from './worker-health'

const NOW = new Date('2026-07-17T12:00:00Z')

function minutesAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 60_000)
}

/** A stand-in for the JobRun table. The logic needs no database. */
function prismaWith(
  rows: Array<{ queue: string; startedAt: Date; finishedAt: Date | null; ok: boolean; detail?: string | null }>,
) {
  return {
    jobRun: { findMany: vi.fn(async () => rows.map((r) => ({ detail: null, ...r }))) },
  } as unknown as Parameters<typeof workerHealth>[0]
}

describe('workerHealth', () => {
  it('reports never-run when the worker has never started', async () => {
    // The case that matters most, and the one a naive "is the last run recent?" check reports
    // as a bare false: a deployment where nobody ever started the worker looks perfectly
    // healthy from every other angle.
    const health = await workerHealth(prismaWith([]), { now: NOW })

    expect(health.state).toBe('never-run')
    expect(health.healthy).toBe(false)
  })

  it('reports healthy when the sweep ran recently and succeeded', async () => {
    const health = await workerHealth(
      prismaWith([{ queue: SWEEP_QUEUE, startedAt: minutesAgo(2), finishedAt: minutesAgo(2), ok: true }]),
      { now: NOW },
    )

    expect(health.state).toBe('healthy')
    expect(health.healthy).toBe(true)
    expect(health.jobs[0]!.minutesAgo).toBe(2)
  })

  it('reports stale once the sweep falls three runs behind', async () => {
    const health = await workerHealth(
      prismaWith([{ queue: SWEEP_QUEUE, startedAt: minutesAgo(20), finishedAt: minutesAgo(20), ok: true }]),
      { now: NOW },
    )

    expect(health.state).toBe('stale')
    expect(health.healthy).toBe(false)
  })

  it('reports failing when the sweep ran recently but errored', async () => {
    // Alive but broken is a different problem from absent, and needs a different response.
    const health = await workerHealth(
      prismaWith([
        { queue: SWEEP_QUEUE, startedAt: minutesAgo(1), finishedAt: minutesAgo(1), ok: false, detail: 'boom' },
      ]),
      { now: NOW },
    )

    expect(health.state).toBe('failing')
    expect(health.jobs[0]!.detail).toBe('boom')
  })

  it('measures from the START, so a wedged job shows as stale not pending', async () => {
    // A job that began an hour ago and never finished is hung. Keying off finishedAt would
    // leave it looking merely "not finished yet", forever.
    const health = await workerHealth(
      prismaWith([{ queue: SWEEP_QUEUE, startedAt: minutesAgo(60), finishedAt: null, ok: true }]),
      { now: NOW },
    )

    expect(health.state).toBe('stale')
  })

  it('honours a configured staleness window', async () => {
    const rows = [{ queue: SWEEP_QUEUE, startedAt: minutesAgo(20), finishedAt: minutesAgo(20), ok: true }]

    expect((await workerHealth(prismaWith(rows), { now: NOW, staleAfterMinutes: 30 })).state).toBe('healthy')
    expect((await workerHealth(prismaWith(rows), { now: NOW, staleAfterMinutes: 10 })).state).toBe('stale')
  })

  it('reports every job, but the SWEEP decides the verdict', async () => {
    // A failing SOTI poll is a connector problem, not a dead scheduler. The sweep is the one
    // that must run: it is what turns silence into IDLE.
    const health = await workerHealth(
      prismaWith([
        { queue: SWEEP_QUEUE, startedAt: minutesAgo(1), finishedAt: minutesAgo(1), ok: true },
        {
          queue: 'poll-soti',
          startedAt: minutesAgo(1),
          finishedAt: minutesAgo(1),
          ok: false,
          detail: 'MDM unreachable',
        },
      ]),
      { now: NOW },
    )

    expect(health.state).toBe('healthy')
    expect(health.jobs).toHaveLength(2)
    expect(health.jobs.find((j) => j.queue === 'poll-soti')!.state).toBe('failing')
  })
})
