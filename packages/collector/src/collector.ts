import type { OatChannel } from './channel'
import type { HealthReporter, CycleResult } from './health'
import { collectAll, type BuiltModules } from './modules'

/**
 * The collect → push cycle (ADR-0021).
 *
 * One tick of the collector: run every collection module, run the sweep for discovery, and push
 * whatever signals were gathered to OAT. Everything degrades gracefully — a module that throws,
 * a sweep that fails, or an unreachable OAT is recorded and survived, never fatal (CLAUDE.md).
 */

export interface CollectorDeps {
  modules: BuiltModules
  /** Null until the collector is enrolled (has a channel). A cycle then collects but cannot push. */
  channel: OatChannel | null
  health: HealthReporter
  log?: (message: string) => void
}

export async function runCycle(deps: CollectorDeps): Promise<CycleResult> {
  const log = deps.log ?? (() => {})

  // 1. Collect signals from the signal-producing modules (SNMP, osquery).
  const signals = await collectAll(deps.modules.collectors, (id, error) => {
    log(`[collector] module ${id} failed: ${error instanceof Error ? error.message : 'unknown'}`)
  })

  // 2. Sweep for discovery. Hints are logged, NOT pushed as signals — presence is not use, and
  //    a hint has no source. Its value is an operational worklist; it never reaches the register.
  if (deps.modules.sweep) {
    try {
      const hints = await deps.modules.sweep.discover()
      log(
        `[collector] sweep found ${hints.length} device(s): ${hints.map((h) => h.sysName ?? h.address).join(', ') || 'none'}`,
      )
    } catch (error) {
      log(`[collector] sweep failed: ${error instanceof Error ? error.message : 'unknown'}`)
    }
  }

  // 3. Push. At-least-once is safe (OAT dedupes), so a failure is recorded and retried next tick.
  let accepted = 0
  let unmatched = 0
  let error: string | null = null

  if (signals.length === 0) {
    log('[collector] nothing to push this cycle')
  } else if (!deps.channel) {
    error = 'not enrolled: no outbound channel configured'
    log(`[collector] ${signals.length} signal(s) collected but ${error}`)
  } else {
    try {
      const result = await deps.channel.push(signals)
      accepted = result.accepted
      unmatched = result.unmatched.length
      log(
        `[collector] pushed ${signals.length}: ${result.accepted} accepted, ${result.duplicates} dup, ` +
          `${result.unmatched.length} unmatched${result.unmatched.length ? ` [${result.unmatched.join(', ')}]` : ''}`,
      )
    } catch (pushError) {
      error = pushError instanceof Error ? pushError.message : 'push failed'
      log(`[collector] push failed (will retry next cycle): ${error}`)
    }
  }

  const result: CycleResult = { collected: signals.length, accepted, unmatched, error }
  deps.health.recordCycle(result)
  return result
}

/**
 * Run the cycle on a fixed interval. Returns a stop function.
 *
 * The first cycle runs immediately (so a demo does not wait a full interval), then every
 * `intervalMs`. A cycle that throws unexpectedly is caught — the loop must outlive one bad tick.
 */
export function startLoop(deps: CollectorDeps, intervalMs: number): () => void {
  let stopped = false
  const tick = () => {
    if (stopped) return
    runCycle(deps).catch((error: unknown) => {
      ;(deps.log ?? (() => {}))(`[collector] cycle crashed: ${error instanceof Error ? error.message : 'unknown'}`)
    })
  }

  tick()
  const handle = setInterval(tick, intervalMs)
  return () => {
    stopped = true
    clearInterval(handle)
  }
}
