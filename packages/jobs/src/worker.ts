/**
 * The scheduler process.
 *
 * Runs pg-boss: connector polls, the idle sweep, the nightly utilisation rollup.
 *
 * A SEPARATE process from the web app, deliberately (ADR-0020). It is a different workload
 * with a different lifecycle, and it needs Node's `dgram`, `fs` and a Postgres driver — none
 * of which belong anywhere near a bundle that Next also builds for the Edge runtime.
 */
import { startScheduler, stopScheduler } from './scheduler'

async function main(): Promise<void> {
  const boss = await startScheduler()
  if (!boss) {
    console.error('[worker] scheduler did not start')
    process.exitCode = 1
    return
  }

  // Shut down gracefully so an in-flight rollup finishes rather than being killed halfway
  // through writing snapshots.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`[worker] ${signal} — stopping`)
      void stopScheduler().then(() => process.exit(0))
    })
  }

  console.log('[worker] running')
}

main().catch((error: unknown) => {
  console.error('[worker] failed to start:', error)
  process.exit(1)
})
