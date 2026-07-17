import { expect, test, type Browser } from '@playwright/test'
import { apiAs, resetOperational, signIn, USERS } from './helpers'
import { discoverApiRoutes, discoverPages, EXPECTATIONS, probeUrl } from './routes'

/**
 * The disclosure suite: every page, every role, asserting no data or route leak.
 *
 * Earned by two real bugs, both invisible in review:
 *
 *   - middleware failed OPEN and served the whole register unauthenticated (ADR-0012)
 *   - the dashboard was never site-scoped, so a branch user read every site's counts,
 *     names and idle figures while correctly being refused the rows (ADR-0017)
 *
 * Neither was in a route anyone would have thought to list, and neither was visible in the
 * code. Both were obvious the moment somebody signed in as a branch user and looked. So this
 * suite does exactly that, mechanically, for every route it can FIND — and fails when a new
 * route appears without a stated expectation.
 */

test.beforeEach(resetOperational)

/** Ids for probing dynamic segments. */
async function probeIds(browser: Browser) {
  const hq = await apiAs(browser, USERS.labManager)
  const body = await (await hq.request.get('/api/assets?q=LAB-0004')).json()
  await hq.close()

  return { assetId: body.assets[0].id as string, tag: 'LAB-0004' }
}

test.describe('route coverage', () => {
  test('every discovered route has a stated expectation', () => {
    // The mechanism that keeps this suite honest. A page added next year with no entry fails
    // here — you cannot ship a route without answering "who may see this?" in writing.
    const discovered = [...discoverPages(), ...discoverApiRoutes()]
    expect(discovered.length).toBeGreaterThan(10)

    const missing = discovered.filter((route) => !(route in EXPECTATIONS))
    expect(missing, 'routes with no disclosure expectation — add one to e2e/routes.ts').toEqual([])
  })

  test('no expectation names a route that no longer exists', () => {
    // Keeps the list from rotting in the other direction: a stale entry silently covers
    // nothing while looking like coverage.
    const discovered = new Set([...discoverPages(), ...discoverApiRoutes()])
    const stale = Object.keys(EXPECTATIONS).filter((route) => !discovered.has(route))

    expect(stale, 'expectations for routes that do not exist').toEqual([])
  })

  test('every public route states WHY it is public', () => {
    // "Public" should be a decision someone wrote down, not a default nobody noticed.
    for (const [route, expectation] of Object.entries(EXPECTATIONS)) {
      if (expectation.anonymous === 'public') {
        expect(expectation.why, `${route} is public with no stated reason`).toBeTruthy()
      }
    }
  })
})

test.describe('anonymous callers', () => {
  test('every page either signs you in or sends you to sign in — none render', async ({ browser, page }) => {
    const ids = await probeIds(browser)

    for (const route of discoverPages()) {
      const expectation = EXPECTATIONS[route]!
      const url = probeUrl(route, ids)

      await page.goto(url)

      if (expectation.anonymous === 'public') {
        await expect(page, `${route} should be reachable`).toHaveURL(new RegExp(url.replace(/[[\]]/g, '\\$&')))
        continue
      }

      await expect(page, `${route} must redirect an anonymous visitor`).toHaveURL(/\/signin/)
    }
  })

  test('no page leaks register data to an anonymous visitor', async ({ browser, page }) => {
    const ids = await probeIds(browser)

    for (const route of discoverPages()) {
      if (EXPECTATIONS[route]!.anonymous === 'public') continue

      await page.goto(probeUrl(route, ids))
      const body = await page.locator('body').innerText()

      // The exact shape of the ADR-0012 bug: the page rendered, with everything on it.
      expect(body, `${route} leaked an asset tag`).not.toContain('LAB-000')
      expect(body, `${route} leaked a site name`).not.toContain('Lablink Kuala Lumpur')
    }
  })

  test('every API route refuses an anonymous caller', async ({ browser, request }) => {
    const ids = await probeIds(browser)

    for (const route of discoverApiRoutes()) {
      const expectation = EXPECTATIONS[route]!
      if (expectation.anonymous === 'public') continue

      const url = probeUrl(route, ids)
      // Probe both verbs: a route may implement either, and a GET-only guard on a route with
      // a POST is exactly the gap worth catching.
      const responses = [await request.get(url), await request.post(url, { data: {} })]

      for (const response of responses) {
        // 401 refused · 405 wrong verb (still not disclosure) · 404 hidden. Never 2xx.
        expect(response.status(), `${route} answered an anonymous caller`).not.toBeLessThan(400)
      }
    }
  })

  test('the health probe stays public and reveals nothing else', async ({ request }) => {
    const response = await request.get('/api/health')

    expect(response.status()).toBe(200)
    const body = await response.json()
    // Deliberately not the driver's error text, which can carry a connection string.
    expect(Object.keys(body).sort()).toEqual(['database', 'status'])
  })
})

test.describe('site-scoped roles disclose only their own site', () => {
  test('no page shows a branch user another site, anywhere', async ({ browser }) => {
    const ids = await probeIds(browser)
    const { context, page } = await signIn(browser, USERS.branchKl)

    for (const route of discoverPages()) {
      if (route === '/signin') continue

      await page.goto(probeUrl(route, ids))
      const body = await page.locator('body').innerText()

      // The ADR-0017 bug: the dashboard rendered every site's name and counts to a branch
      // user who was correctly refused the rows themselves.
      for (const foreign of ['PJ02', 'JB03', 'Petaling Jaya', 'Johor Bahru']) {
        expect(body, `${route} disclosed ${foreign} to a KL01 branch user`).not.toContain(foreign)
      }
    }

    await context.close()
  })

  test('no API route returns another site to a branch user', async ({ browser }) => {
    const kl = await apiAs(browser, USERS.branchKl)
    const ids = await probeIds(browser)

    for (const route of discoverApiRoutes()) {
      if (EXPECTATIONS[route]!.anonymous === 'public') continue

      const response = await kl.request.get(probeUrl(route, ids))
      if (!response.ok()) continue

      const text = await response.text()
      for (const foreign of ['PJ02', 'JB03']) {
        expect(text, `${route} returned ${foreign} to a KL01 branch user`).not.toContain(foreign)
      }
    }

    await kl.close()
  })
})

test.describe('permission boundaries hold per role', () => {
  /**
   * The RBAC matrix, asserted at the edge rather than in a unit test.
   *
   * `packages/auth` tests the matrix; this tests that the ROUTES actually consult it. Those
   * are different claims, and the gap between them is where a forgotten guard lives.
   */
  const CASES: Array<{ route: string; method: 'GET' | 'POST'; allowed: string[]; denied: string[] }> = [
    {
      route: '/api/sap/sync',
      method: 'POST',
      allowed: [USERS.it, USERS.developer],
      denied: [USERS.labManager, USERS.finance, USERS.branchKl, USERS.purchasing],
    },
    {
      route: '/api/reconciliation',
      method: 'GET',
      allowed: [USERS.finance, USERS.labManager, USERS.developer],
      denied: [USERS.it, USERS.branchKl, USERS.purchasing],
    },
    {
      route: '/api/signals/scan',
      method: 'POST',
      allowed: [USERS.branchKl, USERS.labManager, USERS.developer],
      denied: [USERS.finance, USERS.it, USERS.purchasing],
    },
    {
      route: '/api/idle-config',
      method: 'GET',
      allowed: [USERS.finance, USERS.labManager, USERS.it, USERS.developer],
      denied: [USERS.branchKl, USERS.purchasing],
    },
  ]

  for (const { route, method, allowed, denied } of CASES) {
    test(`${method} ${route} admits only the roles the matrix says`, async ({ browser }) => {
      for (const email of allowed) {
        const api = await apiAs(browser, email)
        const response =
          method === 'GET' ? await api.request.get(route) : await api.request.post(route, { data: { tag: 'LAB-0001' } })
        expect(response.status(), `${email} should be allowed ${method} ${route}`).not.toBe(403)
        await api.close()
      }

      for (const email of denied) {
        const api = await apiAs(browser, email)
        const response =
          method === 'GET' ? await api.request.get(route) : await api.request.post(route, { data: { tag: 'LAB-0001' } })
        expect(response.status(), `${email} must be denied ${method} ${route}`).toBe(403)
        await api.close()
      }
    })
  }

  test('a service-token route is not opened by ANY human session', async ({ browser }) => {
    // Different callers entirely. A Developer session is not a scheduler.
    for (const email of [USERS.developer, USERS.it, USERS.labManager]) {
      const api = await apiAs(browser, email)

      for (const route of ['/api/admin/sweep', '/api/admin/rollup', '/api/connectors/soti/poll']) {
        expect((await api.request.post(route, { data: {} })).status(), `${email} on ${route}`).toBe(401)
      }
      await api.close()
    }
  })
})
