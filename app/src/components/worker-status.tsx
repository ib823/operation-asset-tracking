import { workerHealth, type WorkerState } from '@oat/core'
import { prisma } from '@oat/db'
import { formatDuration } from '@/lib/format'

/**
 * The scheduler's heartbeat, in the header (ADR-0022).
 *
 * Shown to everyone who can read the register, not hidden in an admin page. A stopped worker
 * does not break any page — it silently freezes the operational picture, so the only person
 * who will notice is whoever happens to be looking at a number that has quietly stopped
 * changing. That is everyone, which is why this is in the header.
 *
 * Renders NOTHING when healthy. A permanent green badge is furniture; people stop seeing it
 * within a week, and then it is worse than nothing because it looks like coverage.
 */
const MESSAGE: Record<Exclude<WorkerState, 'healthy'>, { label: string; detail: string }> = {
  'never-run': {
    label: 'Scheduler has never run',
    detail: 'Idle status and utilisation are not being updated. Start the worker: pnpm --filter @oat/jobs start',
  },
  stale: {
    label: 'Scheduler has stopped',
    detail: 'Idle status and utilisation are frozen — the figures below are out of date.',
  },
  failing: {
    label: 'Scheduler is failing',
    detail: 'It is running but erroring. Idle status and utilisation may be out of date.',
  },
}

export async function WorkerStatus() {
  const health = await workerHealth(prisma)
  // Narrowed on `state`, not `healthy`: a boolean flag tells the compiler nothing about which
  // states remain, and the exhaustive MESSAGE map is the point.
  if (health.state === 'healthy') return null

  const message = MESSAGE[health.state]
  const sweep = health.jobs.find((job) => job.queue === 'idle-sweep')

  return (
    <span
      data-testid="worker-status"
      data-state={health.state}
      role="status"
      title={message.detail}
      className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-inset ring-amber-600/30 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-400/30"
    >
      {/* Colour is an accent, never the only carrier — the label always says what is wrong. */}
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      {message.label}
      {sweep?.minutesAgo ? (
        <span className="font-normal">· last ran {formatDuration(sweep.minutesAgo)} ago</span>
      ) : null}
    </span>
  )
}
