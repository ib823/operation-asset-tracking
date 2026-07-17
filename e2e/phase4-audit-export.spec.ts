import { expect, test } from '@playwright/test'
import { apiAs, resetOperational, signIn, USERS } from './helpers'

/**
 * The SIEM export and the auth trail (RFP 1.41, §8).
 *
 * The auth events matter most: the audit log covered "who changed this asset" but not "who
 * tried to get in" until Phase 4. A failed sign-in is the single most useful line in a
 * security log.
 */

test.beforeEach(resetOperational)

test.describe('audit export', () => {
  test('emits NDJSON a SIEM can ingest line by line', async ({ browser }) => {
    const kl = await apiAs(browser, USERS.branchKl)
    await kl.request.post('/api/signals/scan', { data: { tag: 'LAB-0001', location: 'Bench 4' } })
    await kl.close()

    const it = await apiAs(browser, USERS.it)
    const response = await it.request.get('/api/audit/export')
    expect(response.ok()).toBeTruthy()
    expect(response.headers()['content-type']).toContain('application/x-ndjson')
    // An audit export is not cacheable by anything, ever.
    expect(response.headers()['cache-control']).toContain('no-store')

    const lines = (await response.text()).trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)

    // Every line stands alone — unlike a JSON array, a truncated NDJSON file is just shorter.
    for (const line of lines) {
      const record = JSON.parse(line)
      expect(record.timestamp).toBeTruthy()
      expect(record.event_type).toBeTruthy()
      expect(record.actor).toBeTruthy()
      expect(record.source).toBe('lablink-oat')
    }
    await it.close()
  })

  test('records a SUCCESSFUL sign-in', async ({ browser }) => {
    const { context } = await signIn(browser, USERS.labManager)
    await context.close()

    const it = await apiAs(browser, USERS.it)
    const text = await (await it.request.get('/api/audit/export')).text()

    expect(text).toContain('AUTH_SIGN_IN_SUCCEEDED')
    expect(text).toContain(USERS.labManager)
    await it.close()
  })

  test('records a FAILED sign-in, with the email that was tried', async ({ browser, page }) => {
    await page.goto('/signin')
    await page.getByLabel('Email').fill(USERS.labManager)
    await page.getByLabel('Password').fill('wrong-password-entirely')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByTestId('signin-error')).toBeVisible()

    const it = await apiAs(browser, USERS.it)
    const lines = (await (await it.request.get('/api/audit/export')).text()).trim().split('\n')
    const failure = lines.map((l) => JSON.parse(l)).find((r) => r.event_type === 'AUTH_SIGN_IN_FAILED')

    expect(failure, 'a failed sign-in must be auditable').toBeTruthy()
    expect(failure.actor).toBe(USERS.labManager)
    await it.close()
  })

  test('records an attempt against an account that does not exist', async ({ browser, page }) => {
    // The point: "someone tried admin@lablink 40 times" IS the signal. Dropping it because
    // the account is fictional would discard the attack and log only the noise.
    await page.goto('/signin')
    await page.getByLabel('Email').fill('attacker-probe@lablink.example')
    await page.getByLabel('Password').fill('hunter2hunter2')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByTestId('signin-error')).toBeVisible()

    const it = await apiAs(browser, USERS.it)
    const text = await (await it.request.get('/api/audit/export')).text()

    expect(text).toContain('attacker-probe@lablink.example')
    await it.close()
  })

  test('never records a password, and never says which half was wrong', async ({ browser, page }) => {
    await page.goto('/signin')
    await page.getByLabel('Email').fill(USERS.labManager)
    await page.getByLabel('Password').fill('SuperSecret123!')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByTestId('signin-error')).toBeVisible()

    const it = await apiAs(browser, USERS.it)
    const text = await (await it.request.get('/api/audit/export')).text()

    expect(text, 'the password must never reach the log').not.toContain('SuperSecret123!')
    // The log must not become a way to discover which accounts are real.
    expect(text).not.toContain('no such user')
    expect(text).not.toContain('wrong password')
    await it.close()
  })

  test('filters by time, so a SIEM can pull an increment', async ({ browser }) => {
    const kl = await apiAs(browser, USERS.branchKl)
    await kl.request.post('/api/signals/scan', { data: { tag: 'LAB-0001' } })
    await kl.close()

    const it = await apiAs(browser, USERS.it)
    const future = new Date(Date.now() + 60_000).toISOString()
    const empty = await (await it.request.get(`/api/audit/export?since=${future}`)).text()

    expect(empty.trim()).toBe('')
    await it.close()
  })

  test('paginates by cursor, and says when there is more', async ({ browser }) => {
    const kl = await apiAs(browser, USERS.branchKl)
    for (let i = 0; i < 4; i++) {
      await kl.request.post('/api/signals/scan', { data: { tag: 'LAB-0001', location: `Bench ${i}` } })
    }
    await kl.close()

    const it = await apiAs(browser, USERS.it)
    const first = await it.request.get('/api/audit/export?limit=2')
    const cursor = first.headers()['x-next-cursor']

    expect(cursor, 'more records remain, so a cursor must be offered').toBeTruthy()

    const second = await it.request.get(`/api/audit/export?limit=2&cursor=${cursor}`)
    // Resumed, not repeated — a SIEM that re-ingests the same rows is worse than useless.
    expect(await second.text()).not.toBe(await first.text())
    await it.close()
  })

  test('is closed to roles without audit:read', async ({ browser }) => {
    for (const email of [USERS.branchKl, USERS.labManager, USERS.purchasing]) {
      const api = await apiAs(browser, email)
      expect((await api.request.get('/api/audit/export')).status(), email).toBe(403)
      await api.close()
    }
  })

  test('is open to Finance, IT and Developer', async ({ browser }) => {
    for (const email of [USERS.finance, USERS.it, USERS.developer]) {
      const api = await apiAs(browser, email)
      expect((await api.request.get('/api/audit/export')).status(), email).toBe(200)
      await api.close()
    }
  })
})

test.describe('security headers', () => {
  test('every response carries them, including the 404', async ({ request }) => {
    for (const path of ['/signin', '/api/health', '/no-such-page']) {
      const response = await request.get(path)
      const headers = response.headers()

      expect(headers['content-security-policy'], path).toContain("default-src 'self'")
      expect(headers['x-frame-options'], path).toBe('DENY')
      expect(headers['x-content-type-options'], path).toBe('nosniff')
      expect(headers['referrer-policy'], path).toBe('same-origin')
      expect(headers['strict-transport-security'], path).toContain('max-age=')
    }
  })

  test('the CSP forbids eval and any third-party origin', async ({ request }) => {
    const csp = (await request.get('/signin')).headers()['content-security-policy']!

    expect(csp).not.toContain('unsafe-eval')
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("form-action 'self'")
  })
})

test.describe('worker health', () => {
  test('deep health reports the scheduler without leaking detail', async ({ request }) => {
    const response = await request.get('/api/health?deep=1')
    expect(response.ok()).toBeTruthy()

    const body = await response.json()
    expect(['healthy', 'failing', 'stale', 'never-run']).toContain(body.worker.state)

    // Unauthenticated: it may report states and ages, never a connector's error text.
    expect(JSON.stringify(body)).not.toContain('detail')
  })

  test('the shallow probe stays shallow, so a stopped worker cannot fail liveness', async ({ request }) => {
    // A load balancer must not kill a healthy web tier over a background job.
    const body = await (await request.get('/api/health')).json()

    expect(body.status).toBe('ok')
    expect(body.worker).toBeUndefined()
  })

  test('the header warns when the scheduler is not running', async ({ browser }) => {
    // The e2e servers run no worker (ADR-0020), which is exactly the silent-failure case.
    const { context, page } = await signIn(browser, USERS.labManager)
    await page.goto('/')

    const badge = page.getByTestId('worker-status')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('data-state', 'never-run')
    // It must say what is wrong, not just glow.
    await expect(badge).toContainText(/never run|stopped|failing/i)

    await context.close()
  })
})
