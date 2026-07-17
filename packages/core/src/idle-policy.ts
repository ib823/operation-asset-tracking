import type { AssetClass } from '@oat/db'
import type { SignalSource } from './signals'

/**
 * What "idle" means, per asset class (ADR-0008).
 *
 * Two knobs, because two different mistakes are possible:
 *
 *   - `thresholdMinutes` — how long quiet counts as idle. Wrong value, wrong dashboard.
 *   - `activitySources`  — which sources may evidence *use*. Wrong value, fabricated data.
 *
 * The second is the dangerous one. An analyser sitting idle overnight still answers an SNMP
 * ping all night; if reachability counted as use, every instrument would report ~100%
 * utilisation forever and the OAT's central claim would be confidently false. So an
 * instrument's activity comes from the LIS — which knows whether specimens were processed —
 * and from nothing else.
 */
export interface ClassIdlePolicy {
  /** Minutes of quiet before the asset counts as idle. */
  thresholdMinutes: number
  /**
   * Sources whose signals may evidence activity for this class. A signal from any other
   * source still records presence (`lastSeenAt`) but cannot suppress idleness.
   *
   * `'*'` means any source.
   */
  activitySources: readonly SignalSource[] | '*'
}

export type IdlePolicy = Record<AssetClass, ClassIdlePolicy>

/**
 * PROVISIONAL defaults — our engineering judgement, not Lablink's operational answer.
 *
 * No test can validate these numbers; a green suite proves the mechanics, not that 30
 * minutes is right for a workstation. They are surfaced as provisional in the UI so nobody
 * mistakes a placeholder for a client-approved figure. Confirm with the HQ Lab Manager.
 *
 * Changing them later is a recompute, not a migration: signals are an append-only log
 * (ADR-0006), so the inputs are still there. That is what makes shipping provisional
 * numbers safe rather than reckless.
 */
export const DEFAULT_IDLE_POLICY: IdlePolicy = {
  /** Between-run gaps are normal. Activity means specimens processed, which only the LIS knows. */
  LAB_INSTRUMENT: { thresholdMinutes: 120, activitySources: ['lis'] },
  /** OS-level idle from the endpoint agents; matches common screen-lock expectations. */
  IT: { thresholdMinutes: 30, activitySources: ['osquery', 'soti'] },
  /** Bursty by nature — quiet for long stretches while still in service. Page counts via SNMP. */
  PRINTER: { thresholdMinutes: 240, activitySources: ['snmp'] },
  SCANNER: { thresholdMinutes: 240, activitySources: ['snmp', 'soti'] },
  /**
   * Pooled items are scan-tracked and have no automated activity source. They will not go
   * idle on their own, which is correct: a rack on a shelf is stored, not idle.
   */
  REUSABLE_COMPONENT: { thresholdMinutes: 480, activitySources: [] },
  OTHER: { thresholdMinutes: 120, activitySources: '*' },
}

/**
 * How long a human's IN_USE/IDLE scan assertion outranks telemetry (ADR-0010).
 *
 * 12 hours covers one shift: the scan is trusted for as long as the person who made it could
 * plausibly still be right, and no longer. Config, not a constant — a two-shift site may
 * want 24, and that is an operational question for Lablink.
 */
export const DEFAULT_SCAN_TTL_MINUTES = 12 * 60

export interface EnginePolicy {
  idle: IdlePolicy
  scanTtlMinutes: number
}

export const DEFAULT_ENGINE_POLICY: EnginePolicy = {
  idle: DEFAULT_IDLE_POLICY,
  scanTtlMinutes: DEFAULT_SCAN_TTL_MINUTES,
}

/**
 * Resolve the engine policy, applying per-class overrides from config.
 *
 * Invalid entries are ignored rather than thrown: a bad config value should not take the
 * idle engine down across all 32 sites. Overriding a threshold must not silently reset that
 * class's `activitySources` — the two are independent, and conflating them would let a
 * threshold tweak re-enable heartbeat-as-activity for instruments, which is the exact
 * failure ADR-0008 exists to prevent.
 */
export function resolveIdlePolicy(overrides?: Partial<Record<string, number>>): IdlePolicy {
  const policy: IdlePolicy = Object.fromEntries(
    Object.entries(DEFAULT_IDLE_POLICY).map(([key, value]) => [key, { ...value }]),
  ) as IdlePolicy

  if (!overrides) return policy

  for (const [key, minutes] of Object.entries(overrides)) {
    if (key in policy && typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) {
      policy[key as AssetClass].thresholdMinutes = minutes
    }
  }
  return policy
}

export function resolveEnginePolicy(
  options: { idleOverrides?: Partial<Record<string, number>>; scanTtlMinutes?: number } = {},
): EnginePolicy {
  const ttl = options.scanTtlMinutes
  return {
    idle: resolveIdlePolicy(options.idleOverrides),
    scanTtlMinutes: typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_SCAN_TTL_MINUTES,
  }
}

export function classPolicy(policy: IdlePolicy, assetClass: AssetClass): ClassIdlePolicy {
  return policy[assetClass] ?? DEFAULT_IDLE_POLICY.OTHER
}

export function idleThresholdMinutes(policy: IdlePolicy, assetClass: AssetClass): number {
  return classPolicy(policy, assetClass).thresholdMinutes
}

/** Whether a source may evidence activity for this class (ADR-0008). */
export function isActivitySource(policy: IdlePolicy, assetClass: AssetClass, source: SignalSource): boolean {
  const sources = classPolicy(policy, assetClass).activitySources
  return sources === '*' ? true : sources.includes(source)
}
