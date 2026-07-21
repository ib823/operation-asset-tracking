import { test, type APIRequestContext } from '@playwright/test'
import { apiAs, expect, resetOperational, USERS } from './helpers'

/**
 * Idle-policy Save re-derives history (5.3) — regression guard.
 *
 * The settings banner promises "changing a threshold re-derives history rather than losing it".
 * This proves it is real, not copy: raising the IT class threshold above an asset's current
 * idle duration flips it back to IN_USE and resolves its alert immediately (no scheduled sweep
 * needed); clearing the override re-derives it back to IDLE. Signals are untouched throughout —
 * only the derivation changes (ADR-0006).
 */

async function findAsset(request: APIRequestContext, tag: string) {
  const assets = (await (await request.get('/api/assets')).json()).assets as Array<{ tag: string; status: string }>
  return assets.find((a) => a.tag === tag)
}

test.beforeAll(async () => {
  const { prisma } = await import('@oat/db')
  const { seedDemoSignals } = await import('@oat/seed')
  await seedDemoSignals(prisma) // LAB-0004: IT, idle ~9 days, with an open alert
})

test.afterAll(async () => {
  // Clear any override we set, then reset operational state for the rest of the suite.
  const { prisma } = await import('@oat/db')
  await prisma.idleConfig.deleteMany({ where: { scope: 'CLASS', key: 'IT' } })
  await resetOperational()
})

test('saving a class threshold re-derives idle + alerts immediately, and clearing reverts it', async ({ browser }) => {
  const api = await apiAs(browser, USERS.labManager)

  // Baseline: LAB-0004 is idle with an open alert.
  expect((await findAsset(api.request, 'LAB-0004'))?.status).toBe('IDLE')
  const alertsBefore = (await (await api.request.get('/api/alerts')).json()).alerts as unknown[]
  expect(alertsBefore.length).toBeGreaterThanOrEqual(1)

  // Raise the IT idle threshold well above its ~9-day idle → it is no longer idle.
  const save = await api.request.put('/api/idle-config', {
    data: { scope: 'CLASS', key: 'IT', thresholdMinutes: 200_000 },
  })
  expect(save.ok(), `save -> ${save.status()}`).toBeTruthy()

  // Re-derived on save: LAB-0004 is IN_USE now and its alert has resolved.
  expect((await findAsset(api.request, 'LAB-0004'))?.status).toBe('IN_USE')
  const alertsAfter = (await (await api.request.get('/api/alerts')).json()).alerts as unknown[]
  expect(alertsAfter.length).toBe(0)

  // Clearing the override falls back to the default threshold and re-derives back to IDLE.
  const clear = await api.request.delete('/api/idle-config?scope=CLASS&key=IT')
  expect(clear.ok(), `clear -> ${clear.status()}`).toBeTruthy()
  expect((await findAsset(api.request, 'LAB-0004'))?.status).toBe('IDLE')

  await api.close()
})
