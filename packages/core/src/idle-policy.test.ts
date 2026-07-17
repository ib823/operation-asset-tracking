import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IDLE_POLICY,
  DEFAULT_SCAN_TTL_MINUTES,
  isRollupEligible,
  normaliseSubType,
  resolveIdlePolicy,
  resolveScanTtlMinutes,
  subTypeKey,
  type IdleConfigOverride,
} from './idle-policy'

const analyser = { id: 'asset-1', class: 'LAB_INSTRUMENT' as const, subType: 'Analyser' }
const microscope = { id: 'asset-2', class: 'LAB_INSTRUMENT' as const, subType: 'Microscope' }
const untyped = { id: 'asset-3', class: 'LAB_INSTRUMENT' as const, subType: null }

/** ADR-0014: asset → sub-type → class → default. */
describe('resolveIdlePolicy', () => {
  it('falls back to the built-in default when nothing is configured', () => {
    const resolved = resolveIdlePolicy(analyser, [])

    expect(resolved.thresholdMinutes).toBe(DEFAULT_IDLE_POLICY.LAB_INSTRUMENT.thresholdMinutes)
    expect(resolved.thresholdSource).toBe('default')
  })

  it('applies a class override', () => {
    const overrides: IdleConfigOverride[] = [{ scope: 'CLASS', key: 'LAB_INSTRUMENT', thresholdMinutes: 90 }]

    const resolved = resolveIdlePolicy(analyser, overrides)
    expect(resolved.thresholdMinutes).toBe(90)
    expect(resolved.thresholdSource).toBe('class')
  })

  it('lets a sub-type beat the class', () => {
    // The A13 case: an analyser and a microscope are both LAB_INSTRUMENT and are not the
    // same question.
    const overrides: IdleConfigOverride[] = [
      { scope: 'CLASS', key: 'LAB_INSTRUMENT', thresholdMinutes: 90 },
      { scope: 'SUB_TYPE', key: subTypeKey('LAB_INSTRUMENT', 'Microscope'), thresholdMinutes: 480 },
    ]

    expect(resolveIdlePolicy(analyser, overrides).thresholdMinutes).toBe(90)
    expect(resolveIdlePolicy(microscope, overrides).thresholdMinutes).toBe(480)
    expect(resolveIdlePolicy(microscope, overrides).thresholdSource).toBe('sub-type')
  })

  it('lets a per-asset override beat everything', () => {
    const overrides: IdleConfigOverride[] = [
      { scope: 'CLASS', key: 'LAB_INSTRUMENT', thresholdMinutes: 90 },
      { scope: 'SUB_TYPE', key: subTypeKey('LAB_INSTRUMENT', 'Analyser'), thresholdMinutes: 240 },
      { scope: 'ASSET', key: 'asset-1', thresholdMinutes: 15 },
    ]

    const resolved = resolveIdlePolicy(analyser, overrides)
    expect(resolved.thresholdMinutes).toBe(15)
    expect(resolved.thresholdSource).toBe('asset')
  })

  it('ignores a sub-type override for an asset with no sub-type', () => {
    const overrides: IdleConfigOverride[] = [
      { scope: 'SUB_TYPE', key: subTypeKey('LAB_INSTRUMENT', 'Analyser'), thresholdMinutes: 240 },
    ]

    expect(resolveIdlePolicy(untyped, overrides).thresholdSource).toBe('default')
  })

  it('ignores an override aimed at a different class or asset', () => {
    const overrides: IdleConfigOverride[] = [
      { scope: 'CLASS', key: 'IT', thresholdMinutes: 5 },
      { scope: 'ASSET', key: 'someone-else', thresholdMinutes: 5 },
    ]

    expect(resolveIdlePolicy(analyser, overrides).thresholdSource).toBe('default')
  })

  it('resolves threshold and alert INDEPENDENTLY', () => {
    // A sub-type row setting only a threshold must not blank out the class's alert setting.
    const overrides: IdleConfigOverride[] = [
      { scope: 'CLASS', key: 'LAB_INSTRUMENT', thresholdMinutes: 90, alertAfterMinutes: 5000 },
      { scope: 'SUB_TYPE', key: subTypeKey('LAB_INSTRUMENT', 'Analyser'), thresholdMinutes: 30 },
    ]

    const resolved = resolveIdlePolicy(analyser, overrides)
    expect(resolved.thresholdMinutes).toBe(30)
    expect(resolved.thresholdSource).toBe('sub-type')
    expect(resolved.alertAfterMinutes).toBe(5000)
    expect(resolved.alertSource).toBe('class')
  })

  it('never lets an override change activitySources', () => {
    // ADR-0014: sources are not a tuning knob. An override re-admitting SNMP as "activity"
    // for one analyser would silently reintroduce fabricated utilisation for exactly the
    // asset someone cared enough to configure.
    const overrides = [
      { scope: 'ASSET' as const, key: 'asset-1', thresholdMinutes: 15, activitySources: ['snmp'] },
    ] as unknown as IdleConfigOverride[]

    expect(resolveIdlePolicy(analyser, overrides).activitySources).toEqual(['lis'])
  })

  it('skips an invalid override rather than throwing', () => {
    // A bad config row must not take the idle engine down across 32 sites.
    const overrides = [
      { scope: 'CLASS' as const, key: 'LAB_INSTRUMENT', thresholdMinutes: -5 },
      { scope: 'ASSET' as const, key: 'asset-1', thresholdMinutes: Number.NaN },
    ]

    const resolved = resolveIdlePolicy(analyser, overrides)
    expect(resolved.thresholdMinutes).toBe(DEFAULT_IDLE_POLICY.LAB_INSTRUMENT.thresholdMinutes)
    expect(resolved.thresholdSource).toBe('default')
  })
})

/** ADR-0013: the scan TTL is per-site. */
describe('resolveScanTtlMinutes', () => {
  it('uses the site override when set', () => {
    expect(resolveScanTtlMinutes({ scanTtlMinutes: 24 * 60 })).toBe(24 * 60)
  })

  it('falls back to the default when the site has none', () => {
    // Null means "follow the default", not zero — and not a frozen copy of whatever the
    // default was the day the site was created.
    expect(resolveScanTtlMinutes({ scanTtlMinutes: null })).toBe(DEFAULT_SCAN_TTL_MINUTES)
    expect(resolveScanTtlMinutes(null)).toBe(DEFAULT_SCAN_TTL_MINUTES)
    expect(resolveScanTtlMinutes(undefined)).toBe(DEFAULT_SCAN_TTL_MINUTES)
  })

  it('ignores a nonsensical site value rather than disabling the TTL', () => {
    expect(resolveScanTtlMinutes({ scanTtlMinutes: 0 })).toBe(DEFAULT_SCAN_TTL_MINUTES)
    expect(resolveScanTtlMinutes({ scanTtlMinutes: -60 })).toBe(DEFAULT_SCAN_TTL_MINUTES)
  })
})

/** ADR-0015: rollup eligibility is derived from deployed connectors, never hardcoded. */
describe('isRollupEligible', () => {
  it('excludes instruments until the LIS connector is enabled', () => {
    expect(isRollupEligible(DEFAULT_IDLE_POLICY.LAB_INSTRUMENT, ['soti', 'osquery', 'snmp'])).toBe(false)
  })

  it('includes instruments the moment the LIS is enabled — no code change', () => {
    expect(isRollupEligible(DEFAULT_IDLE_POLICY.LAB_INSTRUMENT, ['lis'])).toBe(true)
  })

  it('includes IT when an endpoint connector is deployed', () => {
    expect(isRollupEligible(DEFAULT_IDLE_POLICY.IT, ['soti'])).toBe(true)
    expect(isRollupEligible(DEFAULT_IDLE_POLICY.IT, ['osquery'])).toBe(true)
  })

  it('excludes IT when no endpoint connector is deployed', () => {
    // Turning a connector off must stop the rollups, not silently convert them to zeroes.
    expect(isRollupEligible(DEFAULT_IDLE_POLICY.IT, ['scan'])).toBe(false)
    expect(isRollupEligible(DEFAULT_IDLE_POLICY.IT, [])).toBe(false)
  })

  it('never rolls up a class with no automated activity source', () => {
    expect(isRollupEligible(DEFAULT_IDLE_POLICY.REUSABLE_COMPONENT, ['scan', 'soti', 'lis'])).toBe(false)
  })
})

/** ADR-0019: sub-types are normalised on write and matched case-insensitively. */
describe('normaliseSubType', () => {
  it('trims and collapses whitespace', () => {
    expect(normaliseSubType('  Analyser  ')).toBe('Analyser')
    expect(normaliseSubType('Blood   Gas  Analyser')).toBe('Blood Gas Analyser')
  })

  it('case-folds to a canonical display form', () => {
    // Free text is what makes sub-types usable without a migration; it is also what makes
    // "analyser", "Analyser" and "ANALYSER" three sub-types by accident.
    for (const input of ['analyser', 'ANALYSER', 'aNaLySeR']) {
      expect(normaliseSubType(input), input).toBe('Analyser')
    }
  })

  it('treats blank and absent as no sub-type', () => {
    expect(normaliseSubType('   ')).toBeNull()
    expect(normaliseSubType('')).toBeNull()
    expect(normaliseSubType(null)).toBeNull()
    expect(normaliseSubType(undefined)).toBeNull()
  })

  it('builds a stable key regardless of how the sub-type was typed', () => {
    expect(subTypeKey('LAB_INSTRUMENT', ' analyser ')).toBe('LAB_INSTRUMENT:Analyser')
    expect(subTypeKey('LAB_INSTRUMENT', 'Analyser')).toBe('LAB_INSTRUMENT:Analyser')
  })

  it('resolves an override whatever the case of the stored key', () => {
    // An override written before normalisation existed must still match.
    const overrides: IdleConfigOverride[] = [
      { scope: 'SUB_TYPE', key: 'LAB_INSTRUMENT:analyser', thresholdMinutes: 42 },
    ]
    const asset = { id: 'a', class: 'LAB_INSTRUMENT' as const, subType: 'Analyser' }

    expect(resolveIdlePolicy(asset, overrides).thresholdMinutes).toBe(42)
    expect(resolveIdlePolicy(asset, overrides).thresholdSource).toBe('sub-type')
  })
})
