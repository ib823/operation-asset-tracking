import type { AssetClass } from '@oat/db'
import type { SignalSource } from './signals'

/**
 * What "idle" means (ADR-0008), and how it is resolved (ADR-0014).
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
  /** Minutes idle before an alert is raised (ADR-0015 threshold alerts). */
  alertAfterMinutes: number
  /**
   * Sources whose signals may evidence activity for this class. A signal from any other
   * source still records presence (`lastSeenAt`) but cannot suppress idleness.
   *
   * NOT overridable below class (ADR-0014): this is not a tuning knob, it is the rule that
   * keeps utilisation honest.
   *
   * `'*'` means any source. An empty list means no automated source — scan-tracked only.
   */
  activitySources: readonly SignalSource[] | '*'
}

export type IdlePolicy = Record<AssetClass, ClassIdlePolicy>

/**
 * PROVISIONAL defaults — our engineering judgement, not Lablink's operational answer
 * (assumption A10).
 *
 * No test can validate these numbers; a green suite proves the mechanics, not that 30
 * minutes is right for a workstation. They are surfaced as provisional in the UI so nobody
 * mistakes a placeholder for a client-approved figure. Changing them later is a recompute,
 * not a migration (ADR-0006) — which is what makes shipping provisional numbers safe rather
 * than reckless.
 */
export const DEFAULT_IDLE_POLICY: IdlePolicy = {
  /** Between-run gaps are normal. Activity means specimens processed, which only the LIS knows. */
  LAB_INSTRUMENT: { thresholdMinutes: 120, alertAfterMinutes: 14 * 24 * 60, activitySources: ['lis'] },
  /** OS-level idle from the endpoint agents; matches common screen-lock expectations. */
  IT: { thresholdMinutes: 30, alertAfterMinutes: 7 * 24 * 60, activitySources: ['osquery', 'soti'] },
  /** Bursty by nature — quiet for long stretches while still in service. Page counts via SNMP. */
  PRINTER: { thresholdMinutes: 240, alertAfterMinutes: 30 * 24 * 60, activitySources: ['snmp'] },
  SCANNER: { thresholdMinutes: 240, alertAfterMinutes: 30 * 24 * 60, activitySources: ['snmp', 'soti'] },
  /**
   * Pooled items are scan-tracked and have no automated activity source. They will not go
   * idle on their own, which is correct: a rack on a shelf is stored, not idle.
   */
  REUSABLE_COMPONENT: { thresholdMinutes: 480, alertAfterMinutes: 60 * 24 * 60, activitySources: [] },
  OTHER: { thresholdMinutes: 120, alertAfterMinutes: 14 * 24 * 60, activitySources: '*' },
}

/**
 * How long a human's IN_USE/IDLE scan assertion outranks telemetry (ADR-0010).
 *
 * 12 hours covers one shift: the scan is trusted for as long as the person who made it could
 * plausibly still be right. Per-site overridable (ADR-0013) — a two-shift site may want 24.
 */
export const DEFAULT_SCAN_TTL_MINUTES = 12 * 60

/** An idle-config override row, as stored. */
export interface IdleConfigOverride {
  scope: 'CLASS' | 'SUB_TYPE' | 'ASSET'
  /** CLASS → "IT" · SUB_TYPE → "LAB_INSTRUMENT:Analyser" · ASSET → the asset id. */
  key: string
  thresholdMinutes: number
  alertAfterMinutes?: number | null
}

/** Where a resolved value came from. Surfaced in the UI — a number whose origin you cannot
 *  see is a number nobody trusts (ADR-0014). */
export type PolicySource = 'asset' | 'sub-type' | 'class' | 'default'

export interface ResolvedIdlePolicy extends ClassIdlePolicy {
  thresholdSource: PolicySource
  alertSource: PolicySource
}

/** The asset context needed to resolve a policy. Deliberately not the Prisma model: the
 *  engine should not know what a row looks like. */
export interface AssetContext {
  id: string
  class: AssetClass
  subType?: string | null
}

/**
 * Canonical form of a sub-type (ADR-0019).
 *
 * Free text is what makes sub-types usable without a migration (ADR-0014); it is also what
 * makes " Analyser" and "analyser" three different sub-types by accident. Normalise on write
 * and on lookup, so a stray space or a capital letter cannot silently create a second
 * sub-type that no config matches.
 *
 * Collapses internal whitespace, trims, and Title-cases the first letter of each word — a
 * canonical display form rather than a lowercased one, because this is shown to humans.
 */
export function normaliseSubType(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null

  const collapsed = raw.trim().replace(/\s+/g, ' ')
  if (collapsed.length === 0) return null

  return collapsed
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

/**
 * The config key for a sub-type.
 *
 * Case-folded, so lookup cannot miss on capitalisation even if a row was written before
 * normalisation existed.
 */
export function subTypeKey(assetClass: AssetClass, subType: string): string {
  const canonical = normaliseSubType(subType) ?? subType
  return `${assetClass}:${canonical}`
}

/** Compare two sub-type keys ignoring case, so an old row still matches a new asset. */
function keyMatches(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Resolve an asset's idle policy: asset → sub-type → class → default (ADR-0014).
 *
 * Pure, and takes the whole override set rather than querying — so it is testable without a
 * database, and callers load the small config table once per sweep rather than per asset.
 *
 * `thresholdMinutes` and `alertAfterMinutes` resolve INDEPENDENTLY: a sub-type row that sets
 * only a threshold must not also blank out the class's alert setting. Invalid values are
 * skipped rather than thrown — a bad config row must not take the engine down estate-wide.
 */
export function resolveIdlePolicy(
  asset: AssetContext,
  overrides: readonly IdleConfigOverride[] = [],
  defaults: IdlePolicy = DEFAULT_IDLE_POLICY,
): ResolvedIdlePolicy {
  const base = defaults[asset.class] ?? DEFAULT_IDLE_POLICY.OTHER

  // Most specific first. `activitySources` is never consulted here — it comes from the class
  // and cannot be overridden (ADR-0008).
  const chain: Array<{ source: PolicySource; override?: IdleConfigOverride }> = [
    { source: 'asset', override: overrides.find((o) => o.scope === 'ASSET' && o.key === asset.id) },
    {
      source: 'sub-type',
      override: asset.subType
        ? overrides.find((o) => o.scope === 'SUB_TYPE' && keyMatches(o.key, subTypeKey(asset.class, asset.subType!)))
        : undefined,
    },
    { source: 'class', override: overrides.find((o) => o.scope === 'CLASS' && o.key === asset.class) },
  ]

  let thresholdMinutes = base.thresholdMinutes
  let thresholdSource: PolicySource = 'default'
  let alertAfterMinutes = base.alertAfterMinutes
  let alertSource: PolicySource = 'default'

  for (const { source, override } of chain) {
    if (!override) continue
    if (thresholdSource === 'default' && isPositive(override.thresholdMinutes)) {
      thresholdMinutes = override.thresholdMinutes
      thresholdSource = source
    }
    if (alertSource === 'default' && isPositive(override.alertAfterMinutes)) {
      alertAfterMinutes = override.alertAfterMinutes
      alertSource = source
    }
  }

  return { thresholdMinutes, alertAfterMinutes, activitySources: base.activitySources, thresholdSource, alertSource }
}

/**
 * Resolve a site's scan TTL (ADR-0013).
 *
 * Null on the site means "follow the default", not "zero" and not a frozen copy — a site
 * that has never been configured should track the default as it changes.
 */
export function resolveScanTtlMinutes(
  site: { scanTtlMinutes?: number | null } | null | undefined,
  fallback: number = DEFAULT_SCAN_TTL_MINUTES,
): number {
  return isPositive(site?.scanTtlMinutes) ? site!.scanTtlMinutes! : fallback
}

/** The policy the engine needs for one asset. */
export interface EnginePolicy {
  idle: ClassIdlePolicy
  scanTtlMinutes: number
}

export const DEFAULT_ENGINE_POLICY: EnginePolicy = {
  idle: DEFAULT_IDLE_POLICY.OTHER,
  scanTtlMinutes: DEFAULT_SCAN_TTL_MINUTES,
}

/** Whether a source may evidence activity for this policy (ADR-0008). */
export function isActivitySource(policy: ClassIdlePolicy, source: SignalSource): boolean {
  return policy.activitySources === '*' ? true : policy.activitySources.includes(source)
}

/**
 * Whether a class's utilisation can be rolled up at all (ADR-0015).
 *
 * Derived, not hardcoded: a class is eligible when it has an activity source AND at least
 * one of those connectors is enabled. So instruments start rolling up automatically the day
 * the LIS connector is turned on — no code change, no forgotten flag — and turning a
 * connector off stops the rollups rather than silently converting them to zeroes.
 */
export function isRollupEligible(policy: ClassIdlePolicy, enabledSources: readonly SignalSource[]): boolean {
  if (policy.activitySources === '*') return enabledSources.length > 0
  if (policy.activitySources.length === 0) return false
  return policy.activitySources.some((source) => enabledSources.includes(source))
}
