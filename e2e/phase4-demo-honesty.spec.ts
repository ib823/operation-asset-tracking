import { test } from '@playwright/test'
import { apiAs, expect, resetOperational, USERS } from './helpers'

/**
 * Demo honesty (P0 + P1.1) — regression guard.
 *
 * The demo's whole credibility rests on: (1) no asset shows a definitive status it has never
 * observed, and (2) idle, an alert, and a real utilisation % are all present AND engine-derived
 * from seeded signals — never hardcoded. This spec re-seeds the demo signals through the real
 * pipeline and asserts the derived state, so a future change that reintroduces a literal status
 * or a fabricated number fails here.
 */

test.beforeAll(async () => {
  // Re-derive the demo state from signals via the SAME engine the live system uses. Idempotent.
  const { prisma } = await import('@oat/db')
  const { seedDemoSignals } = await import('@oat/seed')
  await seedDemoSignals(prisma)
})

test.afterAll(async () => {
  // Leave a clean operational baseline for the rest of the suite.
  await resetOperational()
})

test.describe('demo honesty', () => {
  test('every asset status is observation-backed (P0)', async ({ browser }) => {
    const api = await apiAs(browser, USERS.labManager)
    const assets = (await (await api.request.get('/api/assets')).json()).assets as Array<{
      tag: string
      status: string
      lastSeenAt: string | null
    }>
    await api.close()

    expect(assets.length).toBe(10)
    // No asset may present a definitive operational status without a backing observation.
    const unobserved = assets.filter((a) => a.lastSeenAt === null)
    expect(
      unobserved,
      `assets showing a status with no observation: ${unobserved.map((a) => a.tag).join(', ')}`,
    ).toEqual([])
  })

  test('idle + open alert are present and engine-derived (P1)', async ({ browser }) => {
    const api = await apiAs(browser, USERS.labManager)
    const assets = (await (await api.request.get('/api/assets')).json()).assets as Array<{ status: string }>
    const idle = assets.filter((a) => a.status === 'IDLE')
    expect(idle.length, 'the demo must show at least one idle asset').toBeGreaterThanOrEqual(1)

    const alerts = (await (await api.request.get('/api/alerts')).json()).alerts as Array<{
      status: string
      idleMinutes: number
      thresholdMinutes: number
    }>
    await api.close()

    const open = alerts.filter((a) => a.status === 'OPEN')
    expect(open.length, 'the demo must show at least one open idle alert').toBeGreaterThanOrEqual(1)
    // The alert is real: idle duration actually exceeds the alert threshold (not a literal).
    expect(open[0]!.idleMinutes).toBeGreaterThan(open[0]!.thresholdMinutes)
  })

  test('a real utilisation % is computed for the printer (P1)', async ({ browser }) => {
    const api = await apiAs(browser, USERS.labManager)
    const util = await (await api.request.get('/api/assets/LAB-0005/utilisation')).json()
    await api.close()

    const snap = util.snapshots?.[0]
    expect(snap, 'LAB-0005 must have a utilisation snapshot, not "not measured"').toBeTruthy()
    // Engine-derived from observed vs busy time — a genuine, sub-100% figure.
    expect(snap.observedMinutes).toBeGreaterThan(0)
    expect(snap.utilisationPct).toBeGreaterThan(0)
    expect(snap.utilisationPct).toBeLessThan(100)
    // And it equals busy/observed, proving it was computed, not stored as a number.
    expect(Math.round((snap.busyMinutes / snap.observedMinutes) * 1000) / 10).toBe(snap.utilisationPct)
  })
})
