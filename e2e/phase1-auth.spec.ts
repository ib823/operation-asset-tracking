import { expect, test } from '@playwright/test'
import { apiAs, PASSWORD, signIn, SERVICE_AUTH, USERS } from './helpers'

/**
 * Phase 1 acceptance: authentication, RBAC per RFP Appendix F, and site scoping.
 *
 * Asserts the PROPERTY ("can this caller read another site's assets?") rather than the
 * mechanism ("is the middleware file present?"). Phase 1 shipped a middleware gate that was
 * correct, registered, and completely bypassed — see ADR-0012. The tests below are written
 * so that failure mode fails them.
 */

test.describe('authentication', () => {
  test('an anonymous caller cannot read the register', async ({ request }) => {
    const response = await request.get('/api/assets')
    expect(response.status()).toBe(401)
  })

  test('an anonymous visitor is sent to sign in, and the page leaks nothing', async ({ page }) => {
    await page.goto('/assets')
    await expect(page).toHaveURL(/\/signin/)

    // The exact bug ADR-0012 records: the gate failed open and rendered the whole register.
    await expect(page.locator('body')).not.toContainText('LAB-0001')
  })

  test('signing in with a wrong password fails without saying why', async ({ page }) => {
    await page.goto('/signin')
    await page.getByLabel('Email').fill(USERS.labManager)
    await page.getByLabel('Password').fill('wrong-password-entirely')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByTestId('signin-error')).toContainText('Incorrect email or password')
  })

  test('an unknown email gives the identical message, so accounts cannot be enumerated', async ({ page }) => {
    await page.goto('/signin')
    await page.getByLabel('Email').fill('does-not-exist@lablink.example')
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByTestId('signin-error')).toContainText('Incorrect email or password')
  })

  test('a signed-in user reaches the register and sees who they are', async ({ browser }) => {
    const { context, page } = await signIn(browser, USERS.labManager)

    await page.goto('/assets')
    await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible()
    await expect(page.getByTestId('current-user')).toHaveText(USERS.labManager)

    await context.close()
  })

  test('signing out ends access', async ({ browser }) => {
    const { context, page } = await signIn(browser, USERS.labManager)

    await page.goto('/assets')
    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.waitForURL(/\/signin/)

    await page.goto('/assets')
    await expect(page).toHaveURL(/\/signin/)

    await context.close()
  })
})

test.describe('RBAC per RFP Appendix F', () => {
  test('only IT and Developer may run the SAP sync', async ({ browser }) => {
    const cases: Array<[string, number]> = [
      [USERS.it, 200],
      [USERS.developer, 200],
      [USERS.labManager, 403],
      [USERS.finance, 403],
      [USERS.branchKl, 403],
    ]

    for (const [email, expected] of cases) {
      const api = await apiAs(browser, email)
      const response = await api.request.post('/api/sap/sync')
      expect(response.status(), `${email} -> POST /api/sap/sync`).toBe(expected)
      await api.close()
    }
  })

  test('Finance and HQ may read the reconciliation queue; IT and Branch may not', async ({ browser }) => {
    const cases: Array<[string, number]> = [
      [USERS.finance, 200],
      [USERS.labManager, 200],
      [USERS.it, 403],
      [USERS.branchKl, 403],
    ]

    for (const [email, expected] of cases) {
      const api = await apiAs(browser, email)
      const response = await api.request.get('/api/reconciliation')
      expect(response.status(), `${email} -> GET /api/reconciliation`).toBe(expected)
      await api.close()
    }
  })

  test('Branch and HQ may scan; Finance and IT may not', async ({ browser }) => {
    const cases: Array<[string, number]> = [
      [USERS.branchKl, 200],
      [USERS.labManager, 200],
      [USERS.finance, 403],
      [USERS.it, 403],
    ]

    for (const [email, expected] of cases) {
      const api = await apiAs(browser, email)
      const response = await api.request.post('/api/signals/scan', { data: { tag: 'LAB-0001' } })
      expect(response.status(), `${email} -> POST /api/signals/scan`).toBe(expected)
      await api.close()
    }
  })

  test('the nav offers only doors the user can open', async ({ browser }) => {
    const branch = await signIn(browser, USERS.branchKl)
    await expect(branch.page.getByRole('link', { name: 'Reconciliation' })).toHaveCount(0)
    await branch.context.close()

    const finance = await signIn(browser, USERS.finance)
    await expect(finance.page.getByRole('link', { name: 'Reconciliation' })).toBeVisible()
    await finance.context.close()
  })
})

test.describe('site scoping', () => {
  test('a Branch user sees only their own site', async ({ browser }) => {
    const kl = await apiAs(browser, USERS.branchKl)
    const body = await (await kl.request.get('/api/assets')).json()

    const sites = [...new Set(body.assets.map((a: { site: { code: string } }) => a.site.code))]
    expect(sites).toEqual(['KL01'])
    await kl.close()
  })

  test('an HQ user sees every site', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    const body = await (await hq.request.get('/api/assets')).json()

    const sites = [...new Set(body.assets.map((a: { site: { code: string } }) => a.site.code))].sort()
    expect(sites).toEqual(['JB03', 'KL01', 'PJ02'])
    await hq.close()
  })

  test('a Branch user cannot widen their scope by asking for another site', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    const pjAsset = await (await hq.request.get('/api/assets?q=LAB-0005')).json()
    const pjSiteId = pjAsset.assets[0].site.id
    await hq.close()

    // Scoping narrows the query rather than filtering afterwards, so a hand-crafted siteId
    // cannot widen it.
    const kl = await apiAs(browser, USERS.branchKl)
    const body = await (await kl.request.get(`/api/assets?siteId=${pjSiteId}`)).json()

    const sites = [...new Set(body.assets.map((a: { site: { code: string } }) => a.site.code))]
    expect(sites).toEqual(['KL01'])
    await kl.close()
  })

  test('a Branch user cannot scan an asset at another site', async ({ browser }) => {
    const kl = await apiAs(browser, USERS.branchKl)
    const response = await kl.request.post('/api/signals/scan', {
      data: { tag: 'LAB-0005', location: 'Somewhere else entirely' },
    })

    expect(response.status()).toBe(403)
    await kl.close()
  })

  test("a Branch user cannot open another site's asset by id", async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    const pjAsset = (await (await hq.request.get('/api/assets?q=LAB-0005')).json()).assets[0]
    await hq.close()

    const kl = await signIn(browser, USERS.branchKl)
    await kl.page.goto(`/assets/${pjAsset.id}`)

    // 404, not 403: confirming the id exists would itself leak that another site holds it.
    await expect(kl.page.locator('body')).toContainText(/could not be found/i)
    await kl.context.close()
  })
})

test.describe('service endpoints', () => {
  test('a machine caller reaches its own guard rather than the session gate', async ({ request }) => {
    // Middleware once required a session for all /api/*, making these permanently
    // unreachable — and the failure looked like a 401, which reads as "working".
    const response = await request.post('/api/admin/sweep', { headers: SERVICE_AUTH })
    expect(response.status()).toBe(200)
  })

  test('service endpoints reject a wrong or missing token', async ({ request }) => {
    expect((await request.post('/api/admin/sweep', { headers: { Authorization: 'Bearer wrong' } })).status()).toBe(401)
    expect((await request.post('/api/admin/sweep')).status()).toBe(401)
  })

  test('a human session does not authorise a service endpoint', async ({ browser }) => {
    const dev = await apiAs(browser, USERS.developer)
    const response = await dev.request.post('/api/admin/sweep')

    // Even a Developer session is not a service token: these are different callers, and the
    // route deliberately grants nothing to a person.
    expect(response.status()).toBe(401)
    await dev.close()
  })
})
