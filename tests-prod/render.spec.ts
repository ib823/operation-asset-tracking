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
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`))

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

  // Dashboard — the numbers must be visible.
  await page.goto(`${BASE}/`, { waitUntil: 'load' })
  await expect(page.getByText(/33\.3/).first(), 'LAB-0005 utilisation 33.3% is visible').toBeVisible({
    timeout: 20000,
  })
  await expect(page.locator('.animate-pulse'), 'dashboard skeleton is gone').toHaveCount(0, { timeout: 20000 })
  await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true })

  expect(problems, `page/console errors:\n${problems.join('\n')}`).toEqual([])
})
