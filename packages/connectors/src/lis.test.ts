import { describe, expect, it } from 'vitest'
import { LisConnector, LisNotConfiguredError, lisConfigured, OPEN_QUESTIONS } from './lis'

/**
 * The stub's contract is tested even though the transport is not built (C4). `normalise` is
 * the half that needs no LIS: what an activity record MEANS to the engine is already decided,
 * and it is the half worth reviewing now.
 */
describe('LisConnector.normalise', () => {
  const connector = new LisConnector()
  const observedAt = new Date('2026-07-16T10:00:00Z')

  function raw(payload: unknown) {
    return { externalRef: 'LAB-0001', observedAt, payload }
  }

  it('reports instrument work as activity', async () => {
    const signal = connector.normalise(raw({ assetRef: 'LAB-0001', observedAt, resultCount: 12 }), 'a1')

    expect(signal).toMatchObject({ source: 'lis', type: 'utilisation', value: { busy: true }, observedAt })
  })

  it('dates activity from when the work happened, not when the message arrived', async () => {
    // An integration engine may batch or replay hours late. Dating from receipt would report
    // a busy morning as a busy evening.
    const workDoneAt = new Date('2026-07-16T02:00:00Z')
    const signal = connector.normalise(raw({ assetRef: 'LAB-0001', observedAt: workDoneAt }), 'a1')

    expect(signal.observedAt).toEqual(workDoneAt)
  })

  it('dedupes on the LIS message id, so a corrected result does not double-count', async () => {
    const a = connector.normalise(raw({ assetRef: 'LAB-0001', observedAt, messageId: 'ORU-991' }), 'a1')
    const b = connector.normalise(raw({ assetRef: 'LAB-0001', observedAt, messageId: 'ORU-991' }), 'a1')

    expect(a.dedupeKey).toBe('lis:ORU-991')
    expect(b.dedupeKey).toBe(a.dedupeKey)
  })

  it('falls back to ref+instant when the LIS sends no message id', async () => {
    const signal = connector.normalise(raw({ assetRef: 'LAB-0001', observedAt }), 'a1')
    expect(signal.dedupeKey).toBe('lis:LAB-0001:2026-07-16T10:00:00.000Z')
  })

  it('rejects a record with no asset reference', () => {
    expect(() => connector.normalise(raw({ observedAt }), 'a1')).toThrow()
  })

  it('is a source instruments trust — the point of the whole connector', async () => {
    const { DEFAULT_IDLE_POLICY } = await import('@oat/core')
    expect(DEFAULT_IDLE_POLICY.LAB_INSTRUMENT.activitySources).toEqual(['lis'])
  })
})

describe('LisConnector transport', () => {
  it('refuses to run, loudly, rather than pretending', async () => {
    // A stub that silently returned [] would look exactly like "no instruments did any work"
    // — the fabrication ADR-0008 exists to prevent, dressed as a working connector.
    await expect(new LisConnector().poll()).rejects.toThrow(LisNotConfiguredError)
    await expect(new LisConnector().ingest()).rejects.toThrow(LisNotConfiguredError)
  })

  it('says why, and what unblocks it', async () => {
    await expect(new LisConnector().poll()).rejects.toThrow(/C4/)
    await expect(new LisConnector().poll()).rejects.toThrow(/not measured/)
  })

  it('is not configured, and says so', () => {
    expect(lisConfigured({})).toBe(false)
    expect(lisConfigured({ OAT_LIS_ENDPOINT: 'mllp://engine.lablink.example:2575' })).toBe(true)
  })

  it('records the questions C4 must answer', () => {
    // These are load-bearing: guessing any of them wrong produces a connector that runs and
    // lies. Keeping them in code rather than a doc means they are reviewed with the contract.
    expect(OPEN_QUESTIONS.length).toBeGreaterThanOrEqual(5)
    expect(OPEN_QUESTIONS.join(' ')).toMatch(/OBX-18|identified/)
  })
})
