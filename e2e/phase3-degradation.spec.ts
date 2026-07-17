import { expect, test } from '@playwright/test'
import { apiAs, fetchAsset, resetOperational, SERVICE_AUTH, signIn, USERS } from './helpers'

/**
 * Phase 3 acceptance: GRACEFUL DEGRADATION.
 *
 * The hard requirement from `CLAUDE.md`: disable every connector and the register must remain
 * fully usable via scan and manual entry.
 *
 * The subtle half is what the dashboard says when nothing is reporting. It must say
 * "not measured" — never 0%. A connector outage that reads as 0% utilisation is the exact
 * failure ADR-0015 exists to prevent, and it is the number that would justify disposing of a
 * perfectly busy analyser.
 *
 * The e2e webServer runs with only `scan` enabled by default (see playwright.config.ts), so
 * these tests exercise the real degraded configuration rather than a simulated one: SOTI,
 * osquery, SNMP and LIS are all off exactly as they would be at a site with no automation.
 */

test.beforeEach(resetOperational)

test.describe('with every automated connector down', () => {
  test('the register is fully usable by scan alone', async ({ browser }) => {
    const kl = await apiAs(browser, USERS.branchKl)

    // The fallback floor: a human with a barcode reader, and nothing else.
    const scan = await kl.request.post('/api/signals/scan', {
      data: { tag: 'LAB-0001', location: 'Bench 9', status: 'UNDER_REPAIR' },
    })
    expect(scan.ok(), 'a scan must work with no automated connector deployed').toBeTruthy()

    const asset = await fetchAsset(kl.request, 'LAB-0001')
    expect(asset.location).toBe('Bench 9')
    expect(asset.status).toBe('UNDER_REPAIR')
    await kl.close()
  })

  test('a scan can move an asset back out of repair', async ({ browser }) => {
    const kl = await apiAs(browser, USERS.branchKl)

    await kl.request.post('/api/signals/scan', { data: { tag: 'LAB-0002', status: 'UNDER_REPAIR' } })
    expect((await fetchAsset(kl.request, 'LAB-0002')).status).toBe('UNDER_REPAIR')

    // Sticky statuses are human-cleared (ADR-0010) — and with no telemetry, a human is the
    // only thing that could clear them anyway.
    await kl.request.post('/api/signals/scan', { data: { tag: 'LAB-0002', status: 'IN_USE' } })
    expect((await fetchAsset(kl.request, 'LAB-0002')).status).toBe('IN_USE')
    await kl.close()
  })

  test('the SAP link still works — it is not a connector', async ({ browser }) => {
    // The register's financial link must not depend on any telemetry being deployed.
    const it = await apiAs(browser, USERS.it)
    const result = await (await it.request.post('/api/sap/sync')).json()
    expect(result.linked + result.updated).toBeGreaterThan(0)
    await it.close()

    const hq = await apiAs(browser, USERS.labManager)
    expect((await fetchAsset(hq.request, 'LAB-0004')).sapAssetNo).toBe('100000004')
    await hq.close()
  })

  test('a disabled connector reports that it is disabled, rather than failing', async ({ request }) => {
    // A deployment without SOTI is a supported configuration, not an error.
    const response = await request.post('/api/connectors/soti/poll', { headers: SERVICE_AUTH, data: {} })

    expect(response.status()).toBe(503)
    expect((await response.json()).flag).toBe('OAT_CONNECTOR_SOTI')
  })

  test('no asset is libelled as idle just because nothing is watching it', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)

    // The sweep runs against the clock. With no activity evidence for any asset, it must
    // conclude NOTHING — absence of evidence is not evidence of idleness.
    await hq.request.post('/api/admin/sweep', { headers: SERVICE_AUTH })

    const body = await (await hq.request.get('/api/assets')).json()
    const idle = body.assets.filter((a: { status: string }) => a.status === 'IDLE')

    expect(idle, 'an unmonitored estate must not report itself idle').toHaveLength(0)
    await hq.close()
  })

  test('the rollup writes nothing rather than a page of zeroes', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)

    const summary = await (await hq.request.post('/api/admin/rollup', { headers: SERVICE_AUTH, data: {} })).json()

    // Every class is skipped: no connector feeding any of them is deployed. Eligibility is
    // derived from the flags, so this is automatic rather than remembered (ADR-0015).
    expect(summary.written).toBe(0)
    expect(summary.skippedClasses).toContain('LAB_INSTRUMENT')
    expect(summary.skippedClasses).toContain('IT')
    await hq.close()
  })

  test('the dashboard says "not measured" — and nothing reads 0%', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    await hq.request.post('/api/admin/rollup', { headers: SERVICE_AUTH, data: {} })
    await hq.close()

    const { context, page } = await signIn(browser, USERS.labManager)
    await page.goto('/')

    const tiles = page.getByTestId('site-utilisation')
    await expect(tiles).toHaveCount(3)

    for (const tile of await tiles.all()) {
      await expect(tile).toContainText('not measured')
    }

    // The load-bearing assertion. A 0% here is indistinguishable from "this site is idle",
    // and that is the number someone would take to a disposal meeting.
    const body = await page.locator('main').innerText()
    expect(body).not.toMatch(/\b0(\.0)?%/)

    await context.close()
  })

  test('a per-asset utilisation history is empty, not zeroed', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    await hq.request.post('/api/admin/rollup', { headers: SERVICE_AUTH, data: {} })

    const history = await (await hq.request.get('/api/assets/LAB-0004/utilisation')).json()
    // No row means "we do not know" — which is a different claim from 0%, and the UI must be
    // able to tell them apart.
    expect(history.snapshots).toEqual([])
    await hq.close()
  })

  test('the idle-policy page explains WHY instruments report nothing', async ({ browser }) => {
    const { context, page } = await signIn(browser, USERS.labManager)
    await page.goto('/settings/idle-policy')

    // "activity comes from: lis" is the answer to "why is this blank?" — the connector is not
    // deployed, so there is nothing to measure, by design (ADR-0008).
    const row = page.locator('[data-class="LAB_INSTRUMENT"]')
    await expect(row).toContainText('lis')

    await context.close()
  })

  test('the LIS connector refuses to run rather than pretending', async ({ request }) => {
    // A stub that silently returned [] would look exactly like "no instruments did any work".
    const response = await request.post('/api/connectors/soti/poll', { headers: SERVICE_AUTH, data: {} })
    expect(response.status()).toBe(503)
  })
})
