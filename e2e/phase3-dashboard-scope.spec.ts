import { expect, test, type Page } from '@playwright/test'
import { apiAs, resetOperational, SERVICE_AUTH, signIn, USERS } from './helpers'

/**
 * ADR-0017: the dashboard obeys the same site scope as the register.
 *
 * These exist because the register was scoped and tested while the dashboard was not scoped
 * at all — a branch user could read every site's name, asset count and idle count from the
 * page, having been correctly refused the rows themselves. The leak was never in a route; it
 * was in what a page chose to render, so these tests assert what the PAGE discloses.
 */

test.beforeEach(resetOperational)

/** The counts a signed-in user's dashboard actually shows. */
async function dashboard(page: Page) {
  await page.goto('/')

  const text = async (testId: string) => Number(await page.getByTestId(testId).innerText())
  const siteRows = page.getByTestId('site-row')

  const codes: string[] = []
  for (const row of await siteRows.all()) {
    codes.push((await row.getAttribute('data-site-code')) ?? '?')
  }

  return {
    inUse: await text('total-in-use'),
    idle: await text('total-idle'),
    siteCodes: codes.sort(),
    subtitle: await page.locator('main p').first().innerText(),
  }
}

test.describe('dashboard site scoping', () => {
  test("a branch user's totals equal the sum of their OWN assets", async ({ browser }) => {
    // The exact bug: totals showed 10 (the whole estate) while the register showed 4.
    const api = await apiAs(browser, USERS.branchKl)
    const register = await (await api.request.get('/api/assets')).json()
    await api.close()

    const { context, page } = await signIn(browser, USERS.branchKl)
    const view = await dashboard(page)

    expect(view.inUse + view.idle).toBe(register.count)
    expect(register.count).toBeGreaterThan(0)
    await context.close()
  })

  test("a branch user's dashboard exposes no other site's counts", async ({ browser }) => {
    const { context, page } = await signIn(browser, USERS.branchKl)
    const view = await dashboard(page)

    expect(view.siteCodes).toEqual(['KL01'])

    // Not just the rows — the other sites' names and codes must not appear anywhere on the
    // page. Reading "Lablink Johor Bahru" off a dashboard is still a disclosure.
    const body = await page.locator('body').innerText()
    expect(body).not.toContain('PJ02')
    expect(body).not.toContain('JB03')
    expect(body).not.toContain('Johor Bahru')
    expect(body).not.toContain('Petaling Jaya')

    await context.close()
  })

  test('the subtitle counts AUTHORISED sites, not global ones', async ({ browser }) => {
    const branch = await signIn(browser, USERS.branchKl)
    expect((await dashboard(branch.page)).subtitle).toContain('across 1 site')
    await branch.context.close()

    const hq = await signIn(browser, USERS.labManager)
    expect((await dashboard(hq.page)).subtitle).toContain('across 3 sites')
    await hq.context.close()
  })

  test('each branch sees only its own site — the scope is per user, not a constant', async ({ browser }) => {
    const kl = await signIn(browser, USERS.branchKl)
    expect((await dashboard(kl.page)).siteCodes).toEqual(['KL01'])
    await kl.context.close()

    const pj = await signIn(browser, USERS.branchPj)
    expect((await dashboard(pj.page)).siteCodes).toEqual(['PJ02'])
    await pj.context.close()
  })

  test('an HQ user with site:read:all sees the whole estate', async ({ browser }) => {
    const api = await apiAs(browser, USERS.labManager)
    const register = await (await api.request.get('/api/assets')).json()
    await api.close()

    const { context, page } = await signIn(browser, USERS.labManager)
    const view = await dashboard(page)

    expect(view.siteCodes).toEqual(['JB03', 'KL01', 'PJ02'])
    expect(view.inUse + view.idle).toBe(register.count)
    await context.close()
  })

  test("a branch user's idle counts reflect only their own site's telemetry", async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    // LAB-0004 is at KL01; LAB-0007 is at PJ02. Idle both.
    for (const tag of ['LAB-0004', 'LAB-0007']) {
      await hq.request.post('/api/connectors/soti/poll', {
        headers: SERVICE_AUTH,
        data: {
          reports: [{ deviceId: `D-${tag}`, assetRef: tag, idleMinutes: 600, reportedAt: new Date().toISOString() }],
        },
      })
    }
    await hq.close()

    const kl = await signIn(browser, USERS.branchKl)
    const klView = await dashboard(kl.page)
    // One idle at KL01 — not the two across the estate.
    expect(klView.idle).toBe(1)
    await kl.context.close()

    const hqUi = await signIn(browser, USERS.labManager)
    expect((await dashboard(hqUi.page)).idle).toBe(2)
    await hqUi.context.close()
  })

  test('alert totals are scoped too', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    await hq.request.put('/api/idle-config', {
      data: { scope: 'CLASS', key: 'IT', thresholdMinutes: 30, alertAfterMinutes: 60 },
    })
    // LAB-0007 is at PJ02 — a branch KL user must not see its alert in their KPI.
    await hq.request.post('/api/connectors/soti/poll', {
      headers: SERVICE_AUTH,
      data: {
        reports: [{ deviceId: 'D-PJ', assetRef: 'LAB-0007', idleMinutes: 600, reportedAt: new Date().toISOString() }],
      },
    })
    await hq.close()

    const kl = await signIn(browser, USERS.branchKl)
    await kl.page.goto('/')
    expect(Number(await kl.page.getByTestId('total-alerts').innerText())).toBe(0)
    await kl.context.close()

    const hqUi = await signIn(browser, USERS.labManager)
    await hqUi.page.goto('/')
    expect(Number(await hqUi.page.getByTestId('total-alerts').innerText())).toBe(1)
    await hqUi.context.close()
  })
})
