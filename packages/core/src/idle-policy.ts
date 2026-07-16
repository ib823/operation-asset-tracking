import type { AssetClass } from '@oat/db'

/**
 * How long an asset of a given class must be quiet before it counts as idle.
 *
 * "Idle" means something different per class: a laptop untouched for 30 minutes is idle;
 * a centrifuge untouched for 30 minutes is between runs. The client has not yet defined
 * these (assumption A1 in PROGRESS.md), so the values below are defensible defaults and
 * the policy is config-driven — the real numbers are a config change, not a code change.
 */
export type IdlePolicy = Record<AssetClass, number>

export const DEFAULT_IDLE_POLICY: IdlePolicy = {
  /** Between-run gaps are normal; two hours quiet suggests genuinely unused. */
  LAB_INSTRUMENT: 120,
  /** OS-level idle; matches common screen-lock expectations. */
  IT: 30,
  /** Bursty by nature — printers are quiet for long stretches while still in service. */
  PRINTER: 240,
  SCANNER: 240,
  /** Pooled items legitimately sit on a shelf between uses. */
  REUSABLE_COMPONENT: 480,
  OTHER: 120,
}

/**
 * Resolve the idle policy, allowing per-class overrides from config.
 *
 * `overrides` is expected to come from environment/DB config in Phase 2. Unknown or
 * non-positive values are ignored rather than throwing: a bad config entry should not take
 * the idle engine down.
 */
export function resolveIdlePolicy(overrides?: Partial<Record<string, number>>): IdlePolicy {
  const policy: IdlePolicy = { ...DEFAULT_IDLE_POLICY }
  if (!overrides) return policy

  for (const [key, minutes] of Object.entries(overrides)) {
    if (key in policy && typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) {
      policy[key as AssetClass] = minutes
    }
  }
  return policy
}

export function idleThresholdMinutes(policy: IdlePolicy, assetClass: AssetClass): number {
  return policy[assetClass] ?? DEFAULT_IDLE_POLICY.OTHER
}
