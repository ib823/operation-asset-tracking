/**
 * Collector health / heartbeat.
 *
 * The collector has no inbound listener (outbound-only, ADR-0021), so "is it alive?" cannot be
 * answered by scraping it. Instead it reports its own liveness two ways: a local heartbeat line
 * (for `docker logs` / a laptop console) and — once the channel exists (Phase 4) — a heartbeat
 * field on each push, so the cloud can tell a quiet collector (nothing to report) from a dead
 * one (nothing at all). This module holds that status; it opens no socket itself.
 */

export interface CycleResult {
  /** Signals collected this cycle, before resolution. */
  collected: number
  /** Signals OAT accepted (Phase 4). */
  accepted: number
  /** Refs OAT could not match to an asset (Phase 4). Reported, never created. */
  unmatched: number
  /** Set when the cycle failed (unreachable OAT, module error). */
  error: string | null
}

export interface CollectorHealth {
  collectorId: string
  /** ISO timestamp the process started. */
  startedAt: string
  enabledModules: string[]
  cyclesRun: number
  /** ISO timestamp of the last completed cycle, or null before the first. */
  lastCycleAt: string | null
  lastCycle: CycleResult | null
}

/**
 * A live status recorder. One per process.
 *
 * `now` is injected so tests are deterministic and a collector never depends on wall-clock
 * behaviour it cannot assert on — the same discipline the rest of the codebase uses for time.
 */
export class HealthReporter {
  private readonly health: CollectorHealth

  constructor(
    collectorId: string,
    enabledModules: string[],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.health = {
      collectorId,
      startedAt: this.now().toISOString(),
      enabledModules,
      cyclesRun: 0,
      lastCycleAt: null,
      lastCycle: null,
    }
  }

  /** Record a completed collect→push cycle. */
  recordCycle(result: CycleResult): void {
    this.health.cyclesRun += 1
    this.health.lastCycleAt = this.now().toISOString()
    this.health.lastCycle = result
  }

  snapshot(): CollectorHealth {
    // A copy: a caller inspecting health must not be able to mutate the live record.
    return { ...this.health, enabledModules: [...this.health.enabledModules] }
  }

  /** A one-line heartbeat for the local console. Never includes secrets. */
  heartbeatLine(): string {
    const h = this.health
    const last = h.lastCycle
      ? `last: ${h.lastCycle.collected} collected, ${h.lastCycle.accepted} accepted, ${h.lastCycle.unmatched} unmatched${h.lastCycle.error ? `, ERROR ${h.lastCycle.error}` : ''}`
      : 'no cycle yet'
    return `[collector ${h.collectorId}] modules=[${h.enabledModules.join(',') || 'none'}] cycles=${h.cyclesRun} ${last}`
  }
}
