import type { APIRequestContext, Browser } from '@playwright/test'
import { expect } from '@playwright/test'

/** Seeded demo password. Development only — see `packages/seed`. */
export const PASSWORD = process.env.OAT_SEED_PASSWORD ?? 'devpassword123'

/** Service token for MACHINE callers (scheduler sweep, connector polls). */
export const SERVICE_TOKEN = process.env.OAT_SERVICE_TOKEN ?? 'e2e_service_token'
export const SERVICE_AUTH = { Authorization: `Bearer ${SERVICE_TOKEN}` }

/** One seeded user per RFP Appendix F role. */
export const USERS = {
  finance: 'finance@lablink.example',
  purchasing: 'purchasing@lablink.example',
  branchKl: 'branch.kl@lablink.example',
  branchPj: 'branch.pj@lablink.example',
  labManager: 'labmanager@lablink.example',
  it: 'it@lablink.example',
  developer: 'developer@lablink.example',
} as const

/**
 * Sign in through the real Auth.js credentials flow and return a browser context holding the
 * session cookie.
 *
 * Drives the actual sign-in rather than forging a cookie: a forged cookie would test our
 * fixture, not the login path an operator uses.
 */
export async function signIn(browser: Browser, email: string) {
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto('/signin')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'))

  return { context, page }
}

/** An API context carrying a signed-in session, for asserting on route responses. */
export async function apiAs(
  browser: Browser,
  email: string,
): Promise<{ request: APIRequestContext; close: () => Promise<void> }> {
  const { context } = await signIn(browser, email)
  return { request: context.request, close: () => context.close() }
}

export async function fetchAsset(request: APIRequestContext, tag: string) {
  const response = await request.get(`/api/assets?q=${tag}`)
  expect(response.ok(), `GET /api/assets?q=${tag} -> ${response.status()}`).toBeTruthy()

  const body = await response.json()
  const asset = body.assets.find((a: { tag: string }) => a.tag === tag)
  expect(asset, `asset ${tag} should be visible`).toBeTruthy()
  return asset
}

/** Report a device as idle for `idleMinutes` via the mock SOTI connector. */
export async function reportIdle(
  request: APIRequestContext,
  assetRef: string,
  idleMinutes: number,
  deviceId = `DEV-${assetRef}`,
) {
  const response = await request.post('/api/connectors/soti/poll', {
    headers: SERVICE_AUTH,
    data: { reports: [{ deviceId, assetRef, idleMinutes, reportedAt: new Date().toISOString() }] },
  })
  expect(response.ok(), `soti poll -> ${response.status()}`).toBeTruthy()

  // A poll that silently accepts nothing would make every downstream assertion vacuous —
  // which is exactly how a broken guard once passed as a green test.
  const body = await response.json()
  expect(body.accepted, 'the report must actually be ingested').toBe(1)
  return body
}

export { expect }

/**
 * Reset operational state between tests, keeping sites and users.
 *
 * Tests share one database and assert on counts, so without this they depend on execution
 * order — the "link an item" test consumes a queue item the next test expects to find. Order
 * dependence is a maintenance trap: it fails months later when someone adds a test in the
 * middle, and the failure blames the wrong code.
 *
 * Deliberately does NOT re-seed users: hashing seven passwords at OWASP scrypt parameters
 * costs ~3s per call, which would dominate the suite. Users are immutable during tests, so
 * only the mutable operational state is cleared.
 */
export async function resetOperational(): Promise<void> {
  const { prisma } = await import('@oat/db')

  await prisma.signalEvent.deleteMany()
  await prisma.conflictAlert.deleteMany()
  await prisma.locationHistory.deleteMany()
  await prisma.utilisationSnapshot.deleteMany()
  await prisma.reconciliationItem.deleteMany()
  await prisma.auditLog.deleteMany()

  // Return every asset to its seeded state: unlinked from SAP, in use, no observations.
  await prisma.asset.updateMany({
    data: {
      sapAssetNo: null,
      status: 'IN_USE',
      idleSince: null,
      lastSeenAt: null,
      lastActiveAt: null,
      scanAssertedStatus: null,
      scanAssertedAt: null,
      custodianId: null,
    },
  })
}
