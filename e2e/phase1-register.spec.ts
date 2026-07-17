import { expect, test } from '@playwright/test'
import { apiAs, resetOperational, fetchAsset, reportIdle, signIn, USERS } from './helpers'

/**
 * Phase 1 acceptance: the SAP matching precedence and reconciliation queue (ADR-0009), and
 * the scan/telemetry ownership rules (ADR-0010).
 */

// Each test starts from the seeded state, so none depends on the order of the others.
test.beforeEach(resetOperational)

test.describe('SAP matching and reconciliation (ADR-0009)', () => {
  test('the sync links assets and never creates them', async ({ browser }) => {
    const it = await apiAs(browser, USERS.it)
    const result = await (await it.request.post('/api/sap/sync')).json()

    // The demo master holds 11 records: 9 that match a tagged asset, and 2 that do not.
    expect(result.fetched).toBe(11)
    expect(result.linked + result.updated).toBe(9)
    expect(result.queued).toBe(2)

    // The result shape itself carries the decision: there is no `created` any more.
    expect(result).not.toHaveProperty('created')
    await it.close()
  })

  test('SAP records nobody tagged become queue items, not phantom assets', async ({ browser }) => {
    const it = await apiAs(browser, USERS.it)
    await it.request.post('/api/sap/sync')
    await it.close()

    const hq = await apiAs(browser, USERS.labManager)
    const body = await (await hq.request.get('/api/assets')).json()

    // Still exactly the 10 seeded assets. A sync that can invent rows can poison the
    // register unattended, and every phantom would look as legitimate as a real one.
    expect(body.count).toBe(10)
    expect(body.assets.filter((a: { tag: string }) => a.tag.startsWith('SAP-'))).toHaveLength(0)

    const queue = await (await hq.request.get('/api/reconciliation')).json()
    const reasons = Object.fromEntries(
      queue.items.map((i: { sapAssetNo: string; reason: string }) => [i.sapAssetNo, i.reason]),
    )
    expect(reasons['100000010']).toBe('NO_MATCH')
    expect(reasons['100000011']).toBe('UNKNOWN_COST_CENTRE')
    await hq.close()
  })

  test('the queue does not stack duplicates when the sync re-runs', async ({ browser }) => {
    const it = await apiAs(browser, USERS.it)
    await it.request.post('/api/sap/sync')
    await it.request.post('/api/sap/sync')
    await it.request.post('/api/sap/sync')
    await it.close()

    const hq = await apiAs(browser, USERS.labManager)
    const queue = await (await hq.request.get('/api/reconciliation')).json()

    // A nightly sync must not add an item every run for the same unresolved record.
    expect(queue.count).toBe(2)
    await hq.close()
  })

  test('matches by tag where SAP carries the inventory number', async ({ browser }) => {
    const it = await apiAs(browser, USERS.it)
    await it.request.post('/api/sap/sync')
    await it.close()

    const hq = await apiAs(browser, USERS.labManager)
    // LAB-0004 carries inventoryNumber in the master; LAB-0005 has only a serial.
    expect((await fetchAsset(hq.request, 'LAB-0004')).sapAssetNo).toBe('100000004')
    expect((await fetchAsset(hq.request, 'LAB-0005')).sapAssetNo).toBe('100000005')
    await hq.close()
  })

  test('a human can resolve a queue item by linking it to a real asset', async ({ browser }) => {
    const it = await apiAs(browser, USERS.it)
    await it.request.post('/api/sap/sync')
    await it.close()

    const dev = await apiAs(browser, USERS.developer)
    const queue = await (await dev.request.get('/api/reconciliation')).json()
    const item = queue.items.find((i: { sapAssetNo: string }) => i.sapAssetNo === '100000010')

    const response = await dev.request.post(`/api/reconciliation/${item.id}`, {
      data: { action: 'link', assetId: (await fetchAsset(dev.request, 'LAB-0010')).id },
    })
    expect(response.ok()).toBeTruthy()

    expect((await fetchAsset(dev.request, 'LAB-0010')).sapAssetNo).toBe('100000010')

    const after = await (await dev.request.get('/api/reconciliation')).json()
    expect(after.items.some((i: { sapAssetNo: string }) => i.sapAssetNo === '100000010')).toBe(false)
    await dev.close()
  })

  test('a dismissal requires a reason', async ({ browser }) => {
    const it = await apiAs(browser, USERS.it)
    await it.request.post('/api/sap/sync')
    await it.close()

    const dev = await apiAs(browser, USERS.developer)
    const queue = await (await dev.request.get('/api/reconciliation')).json()
    const item = queue.items[0]

    // A dismissal with no reason is indistinguishable from clearing a list you are tired of.
    const response = await dev.request.post(`/api/reconciliation/${item.id}`, {
      data: { action: 'dismiss', note: '' },
    })
    expect(response.status()).toBe(400)
    await dev.close()
  })

  test('the queue is visible in the UI to someone who may work it', async ({ browser }) => {
    const it = await apiAs(browser, USERS.it)
    await it.request.post('/api/sap/sync')
    await it.close()

    const { context, page } = await signIn(browser, USERS.developer)
    await page.goto('/reconciliation')

    await expect(page.getByRole('heading', { name: 'Reconciliation' })).toBeVisible()
    await expect(page.getByTestId('reconciliation-row')).toHaveCount(2)
    await expect(page.locator('[data-sap-asset-no="100000011"]')).toContainText('no known site')

    await context.close()
  })
})

test.describe('scan and telemetry precedence (ADR-0010)', () => {
  test('telemetry drives idle for an IT asset', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)

    // 200 minutes quiet, against a 30-minute IT threshold.
    await reportIdle(hq.request, 'LAB-0004', 200)

    const asset = await fetchAsset(hq.request, 'LAB-0004')
    expect(asset.status).toBe('IDLE')
    expect(asset.lastActiveAt).not.toBeNull()
    await hq.close()
  })

  test('a scan of IN_USE beats telemetry, and holds', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    await reportIdle(hq.request, 'LAB-0004', 200)
    expect((await fetchAsset(hq.request, 'LAB-0004')).status).toBe('IDLE')

    // A human at the asset says otherwise.
    await hq.request.post('/api/signals/scan', { data: { tag: 'LAB-0004', status: 'IN_USE' } })
    expect((await fetchAsset(hq.request, 'LAB-0004')).status).toBe('IN_USE')

    // Telemetry keeps insisting; the scan wins for its TTL.
    await reportIdle(hq.request, 'LAB-0004', 400, 'DEV-again')
    const after = await fetchAsset(hq.request, 'LAB-0004')
    expect(after.status).toBe('IN_USE')
    expect(after.scanAssertedStatus).toBe('IN_USE')
    await hq.close()
  })

  test('SOTI cannot evidence activity for a lab instrument — only the LIS can', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)

    // An analyser idle overnight still answers its MDM. If that counted as use, every
    // instrument would report ~100% utilisation forever (ADR-0008).
    await reportIdle(hq.request, 'LAB-0001', 0, 'DEV-instrument')

    const asset = await fetchAsset(hq.request, 'LAB-0001')
    expect(asset.lastActiveAt).toBeNull()
    // Presence is still recorded — we did hear from it.
    expect(asset.lastSeenAt).not.toBeNull()
    await hq.close()
  })

  test('telemetry cannot resurrect an asset a human put under repair', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)

    await hq.request.post('/api/signals/scan', { data: { tag: 'LAB-0003', status: 'UNDER_REPAIR' } })
    await reportIdle(hq.request, 'LAB-0003', 0, 'DEV-repair')

    expect((await fetchAsset(hq.request, 'LAB-0003')).status).toBe('UNDER_REPAIR')
    await hq.close()
  })

  test('a scan records location and writes location history', async ({ browser }) => {
    const kl = await apiAs(browser, USERS.branchKl)

    await kl.request.post('/api/signals/scan', { data: { tag: 'LAB-0002', location: 'Bench 7' } })

    expect((await fetchAsset(kl.request, 'LAB-0002')).location).toBe('Bench 7')
    await kl.close()
  })

  test('a scan of an unknown tag is reported, not silently accepted', async ({ browser }) => {
    const kl = await apiAs(browser, USERS.branchKl)
    const response = await kl.request.post('/api/signals/scan', { data: { tag: 'NOT-A-REAL-TAG' } })

    expect(response.status()).toBe(404)
    await kl.close()
  })
})
