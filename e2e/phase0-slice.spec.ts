import { expect, test } from '@playwright/test'
import { apiAs, resetOperational, fetchAsset, reportIdle, signIn, USERS } from './helpers'

/**
 * Phase 0 acceptance, still enforced: the vertical slice, end to end.
 *
 *   seed → mock SAP sync links sapAssetNo → mock SOTI connector emits an idle signal
 *        → idle engine flips IN_USE to IDLE with the right idleSince → dashboard tile
 *
 * Kept green through Phase 1, which replaced the bearer token with sessions and RBAC, and
 * replaced the sync's auto-create with a reconciliation queue.
 */

// Each test starts from the seeded state, so none depends on the order of the others.
test.beforeEach(resetOperational)

test.describe('Phase 0 — the vertical slice', () => {
  test('the register lists the seeded assets', async ({ browser }) => {
    const { context, page } = await signIn(browser, USERS.labManager)

    await page.goto('/assets')
    await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible()
    await expect(page.getByTestId('asset-row')).toHaveCount(10)
    await expect(page.locator('[data-tag="LAB-0004"]')).toBeVisible()

    await context.close()
  })

  test('the mock SAP sync links assets on the shared key', async ({ browser }) => {
    // Assets are seeded unlinked: tagged and operational before finance capitalises them.
    const hq = await apiAs(browser, USERS.labManager)
    expect((await fetchAsset(hq.request, 'LAB-0004')).sapAssetNo).toBeNull()
    await hq.close()

    const it = await apiAs(browser, USERS.it)
    const result = await (await it.request.post('/api/sap/sync')).json()
    expect(result.linked).toBeGreaterThan(0)
    await it.close()

    const after = await apiAs(browser, USERS.labManager)
    const asset = await fetchAsset(after.request, 'LAB-0004')
    expect(asset.sapAssetNo).toBe('100000004')
    await after.close()

    // The shared key is visible in the UI, under a heading that says SAP owns it.
    const { context, page } = await signIn(browser, USERS.labManager)
    await page.goto(`/assets/${asset.id}`)
    await expect(page.getByTestId('sap-asset-no')).toHaveText('100000004')
    await expect(page.getByText('Held in SAP FI-AA')).toBeVisible()
    await context.close()
  })

  test('the sync is idempotent — re-running links nothing new', async ({ browser }) => {
    const it = await apiAs(browser, USERS.it)
    await it.request.post('/api/sap/sync')
    const second = await (await it.request.post('/api/sap/sync')).json()

    expect(second.linked).toBe(0)
    await it.close()
  })

  test('a connector idle signal flips the asset IDLE and dates the run correctly', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    expect((await fetchAsset(hq.request, 'LAB-0004')).status).toBe('IN_USE')

    // SOTI reports the workstation idle for 45 minutes — past the 30-minute IT threshold.
    await reportIdle(hq.request, 'LAB-0004', 45)

    const idled = await fetchAsset(hq.request, 'LAB-0004')
    expect(idled.status).toBe('IDLE')

    // idleSince is when the asset went quiet (~45 min ago), not when we were told.
    const drift = Math.abs(new Date(idled.idleSince).getTime() - (Date.now() - 45 * 60_000))
    expect(drift).toBeLessThan(5 * 60_000)
    await hq.close()

    const { context, page } = await signIn(browser, USERS.labManager)
    await page.goto(`/assets/${idled.id}`)
    await expect(page.getByTestId('status-badge').first()).toHaveAttribute('data-status', 'IDLE')
    await expect(page.getByTestId('idle-for')).toContainText('45m')

    // The signal behind the status is visible — the audit trail the derivation rests on.
    await expect(page.getByTestId('signal-row').first()).toContainText('soti')
    await context.close()
  })

  test('a device below its class threshold stays IN_USE', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)

    // 10 minutes idle, under the 30-minute IT threshold.
    await reportIdle(hq.request, 'LAB-0007', 10)

    expect((await fetchAsset(hq.request, 'LAB-0007')).status).toBe('IN_USE')
    await hq.close()
  })

  test('the dashboard tile reports idle vs in use, by site', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    await reportIdle(hq.request, 'LAB-0004', 45)
    await hq.close()

    const { context, page } = await signIn(browser, USERS.labManager)
    await page.goto('/')

    const tile = page.getByTestId('idle-by-site-tile')
    await expect(tile).toBeVisible()
    await expect(tile.getByTestId('site-row')).toHaveCount(3)

    // LAB-0004 sits at KL01, so that site must show exactly the one idle asset.
    await expect(tile.locator('[data-site-code="KL01"]').getByTestId('site-idle-count')).toHaveText('1')
    await expect(page.getByTestId('total-idle')).toHaveText('1')

    await context.close()
  })

  test('a scan updates location and status with no automated connector involved', async ({ browser }) => {
    // The fallback floor: this is how the register works when nothing else is deployed.
    const kl = await apiAs(browser, USERS.branchKl)
    const response = await kl.request.post('/api/signals/scan', {
      data: { tag: 'LAB-0003', location: 'Repair bench', status: 'UNDER_REPAIR' },
    })
    expect(response.ok()).toBeTruthy()

    const asset = await fetchAsset(kl.request, 'LAB-0003')
    expect(asset.status).toBe('UNDER_REPAIR')
    expect(asset.location).toBe('Repair bench')
    await kl.close()

    const { context, page } = await signIn(browser, USERS.branchKl)
    await page.goto(`/assets/${asset.id}`)
    await expect(page.getByTestId('status-badge').first()).toHaveAttribute('data-status', 'UNDER_REPAIR')
    await context.close()
  })
})
