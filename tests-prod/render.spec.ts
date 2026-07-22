import { test, expect, request as pwRequest } from '@playwright/test'

/**
 * Real-browser render check against a DEPLOYED environment.
 *
 * A scripted `fetch` of the page HTML is not proof the app renders: React streams the data
 * page's content into a `<div hidden>` and reveals it with an inline `$RC(...)` script, so a
 * fetch "sees" the rows in the bytes even when a real browser never promotes them out of the
 * hidden container and stays on the "Loading…" skeleton. This test asserts the rows are
 * actually VISIBLE in a Chromium DOM within a bounded time — the property that matters.
 *
 * Kept out of the main e2e suite (its own dir, its own config) because it targets a live URL
 * and has no local webServer.
 */

const BASE = process.env.RENDER_CHECK_BASE_URL ?? 'https://lablink-oat.vercel.app'
const EMAIL = process.env.RENDER_CHECK_EMAIL ?? 'labmanager@lablink.example'
const PASSWORD = process.env.RENDER_CHECK_PASSWORD ?? 'devpassword123'

test('data pages paint real, VISIBLE rows in a real browser', async ({ page, context }) => {
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`)
  })
  page.on('requestfailed', (r) => {
    // Next.js <Link> prefetches the RSC payload of in-viewport links, then aborts those it no
    // longer needs — `net::ERR_ABORTED` on a `?_rsc=` URL is expected and does not affect the
    // page that actually rendered. Only genuine failures are problems.
    const err = r.failure()?.errorText ?? ''
    if (err === 'net::ERR_ABORTED') return
    problems.push(`requestfailed: ${r.url()} ${err}`)
  })

  // Programmatic Auth.js v5 credentials login → carry the session cookie into the browser.
  const api = await pwRequest.newContext({ baseURL: BASE })
  const { csrfToken } = await (await api.get('/api/auth/csrf')).json()
  await api.post('/api/auth/callback/credentials', {
    form: { csrfToken, email: EMAIL, password: PASSWORD, callbackUrl: `${BASE}/`, redirect: 'false' },
    maxRedirects: 0,
  })
  const { cookies } = await api.storageState()
  await context.addCookies(cookies)
  await api.dispose()
  expect(
    cookies.some((c) => c.name.includes('session-token')),
    'login set a session cookie',
  ).toBeTruthy()

  // /assets — rows must be VISIBLE, and the skeleton gone.
  await page.goto(`${BASE}/assets`, { waitUntil: 'load' })
  const rows = page.getByTestId('asset-row')
  await expect(rows.first(), 'first asset row is visible (reveal happened)').toBeVisible({ timeout: 20000 })
  await expect(rows, 'all 10 asset rows present').toHaveCount(10)
  await expect(page.locator('.animate-pulse'), 'loading skeleton is gone').toHaveCount(0, { timeout: 20000 })
  await expect(page.getByText('LAB-0005'), 'a known tag is visible').toBeVisible()
  await page.screenshot({ path: 'test-results/assets.png', fullPage: true })

  // Dashboard — a real utilisation figure must be visible. Assert the PROPERTY, not a hardcoded
  // number: PJ02 (LAB-0005, the printer) shows a measured %, and sites with no connector data
  // honestly read "not measured". Utilisation is engine-derived from ALL signals in the window,
  // so the exact figure legitimately rises as the live SNMP collector reports (33.3% seed-only,
  // 66.7% once a real reading lands) — a magic constant here goes stale the moment prod collects
  // data. What must always hold is that the measured/not-measured distinction renders.
  await page.goto(`${BASE}/`, { waitUntil: 'load' })
  const pj02Utilisation = page.locator('[data-site-code="PJ02"]').getByTestId('site-utilisation')
  await expect(pj02Utilisation, 'PJ02 (LAB-0005) utilisation is visible').toBeVisible({ timeout: 20000 })
  await expect(pj02Utilisation, 'PJ02 shows a real % figure, not "not measured"').toContainText('%')
  await expect(
    page.getByText(/not measured/i).first(),
    'a site with no connector data honestly reads "not measured"',
  ).toBeVisible()
  await expect(page.locator('.animate-pulse'), 'dashboard skeleton is gone').toHaveCount(0, { timeout: 20000 })
  await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true })

  expect(problems, `page/console errors:\n${problems.join('\n')}`).toEqual([])
})
