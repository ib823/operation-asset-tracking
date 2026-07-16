import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * Phase 0 acceptance: the vertical slice, end to end.
 *
 *   seed → mock SAP sync populates sapAssetNo → mock SOTI connector emits an idle signal
 *        → idle engine flips IN_USE to IDLE and sets idleSince → dashboard tile reflects it
 *
 * Asserted through the UI and the API, against a production build and a real Postgres —
 * the point is to prove the shipped slice works, not that the units do.
 */

const TOKEN = process.env.OAT_API_TOKEN ?? 'e2e_token'
const AUTH = { Authorization: `Bearer ${TOKEN}` }

/** LAB-0004 is IT class: idle threshold 30 minutes (DEFAULT_IDLE_POLICY). */
const IT_ASSET = 'LAB-0004'

async function fetchAsset(request: APIRequestContext, tag: string) {
  const response = await request.get(`/api/assets?q=${tag}`)
  expect(response.ok()).toBeTruthy()
  const body = await response.json()
  const asset = body.assets.find((a: { tag: string }) => a.tag === tag)
  expect(asset, `asset ${tag} should exist in the register`).toBeTruthy()
  return asset
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

test.describe('Phase 0 — operational asset tracking, end to end', () => {
  test('the register lists seeded assets', async ({ page }) => {
    await page.goto('/assets')

    await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible()
    await expect(page.getByTestId('asset-row')).toHaveCount(10)
    await expect(page.locator(`[data-tag="${IT_ASSET}"]`)).toBeVisible()
  })

  test('mock SAP sync links assets to SAP asset numbers on the shared key', async ({ page, request }) => {
    // Assets are seeded unlinked: tagged and operational before finance capitalises them.
    const before = await fetchAsset(request, IT_ASSET)
    expect(before.sapAssetNo).toBeNull()

    const sync = await request.post('/api/sap/sync', { headers: AUTH })
    expect(sync.ok()).toBeTruthy()
    const result = await sync.json()
    expect(result.linked).toBeGreaterThan(0)

    const after = await fetchAsset(request, IT_ASSET)
    expect(after.sapAssetNo).toBe('100000004')

    // The shared key is visible in the UI, under a heading that says SAP owns it.
    await page.goto(`/assets/${after.id}`)
    await expect(page.getByTestId('sap-asset-no')).toHaveText('100000004')
    await expect(page.getByText('Held in SAP FI-AA')).toBeVisible()
  })

  test('sync is idempotent — re-running links nothing new', async ({ request }) => {
    await request.post('/api/sap/sync', { headers: AUTH })
    const second = await request.post('/api/sap/sync', { headers: AUTH })

    const result = await second.json()
    expect(result.linked).toBe(0)
    expect(result.created).toBe(0)
  })

  test('a connector idle signal flips the asset IDLE and dates the idle run correctly', async ({ page, request }) => {
    const asset = await fetchAsset(request, IT_ASSET)
    expect(asset.status).toBe('IN_USE')

    // SOTI reports the workstation idle for 45 minutes — past the 30-minute IT threshold.
    const poll = await request.post('/api/connectors/soti/poll', {
      headers: AUTH,
      data: {
        reports: [{ deviceId: 'DEV-77', assetRef: IT_ASSET, idleMinutes: 45, reportedAt: new Date().toISOString() }],
      },
    })
    expect(poll.ok()).toBeTruthy()
    expect((await poll.json()).accepted).toBe(1)

    const idled = await fetchAsset(request, IT_ASSET)
    expect(idled.status).toBe('IDLE')

    // idleSince is when the asset went quiet (~45 min ago), not when we were told.
    const idleSince = new Date(idled.idleSince).getTime()
    const expected = Date.now() - 45 * 60_000
    expect(Math.abs(idleSince - expected)).toBeLessThan(5 * 60_000)

    await page.goto(`/assets/${idled.id}`)
    await expect(page.getByTestId('status-badge').first()).toHaveAttribute('data-status', 'IDLE')
    await expect(page.getByTestId('idle-for')).toContainText('45m')

    // The signal behind the status is visible — the audit trail the derivation rests on.
    await expect(page.getByTestId('signal-row').first()).toContainText('soti')
  })

  test('a device below its class threshold stays IN_USE', async ({ request }) => {
    // The same connector, 10 minutes idle: under the 30-minute IT threshold.
    await request.post('/api/connectors/soti/poll', {
      headers: AUTH,
      data: {
        reports: [{ deviceId: 'DEV-88', assetRef: 'LAB-0007', idleMinutes: 10, reportedAt: new Date().toISOString() }],
      },
    })

    expect((await fetchAsset(request, 'LAB-0007')).status).toBe('IN_USE')
  })

  test('the dashboard tile reports idle vs in use, by site', async ({ page, request }) => {
    await request.post('/api/connectors/soti/poll', {
      headers: AUTH,
      data: {
        reports: [{ deviceId: 'DEV-77', assetRef: IT_ASSET, idleMinutes: 45, reportedAt: minutesAgo(1) }],
      },
    })

    await page.goto('/')

    const tile = page.getByTestId('idle-by-site-tile')
    await expect(tile).toBeVisible()
    await expect(tile.getByTestId('site-row')).toHaveCount(3)

    // LAB-0004 sits at KL01, so that site must show exactly the one idle asset.
    const kl01 = tile.locator('[data-site-code="KL01"]')
    await expect(kl01.getByTestId('site-idle-count')).toHaveText('1')

    await expect(page.getByTestId('total-idle')).toHaveText('1')
  })

  test('a scan updates location and status without any automated connector', async ({ page, request }) => {
    // The fallback floor: this is how the register works when nothing else is deployed.
    const scan = await request.post('/api/signals/scan', {
      headers: AUTH,
      data: { tag: 'LAB-0003', location: 'Repair bench', status: 'UNDER_REPAIR', scannedBy: 'tech@lablink.example' },
    })
    expect(scan.ok()).toBeTruthy()

    const asset = await fetchAsset(request, 'LAB-0003')
    expect(asset.status).toBe('UNDER_REPAIR')

    await page.goto(`/assets/${asset.id}`)
    await expect(page.getByTestId('status-badge').first()).toHaveAttribute('data-status', 'UNDER_REPAIR')
  })

  test('an operator scan overrides live telemetry claiming the asset is fine', async ({ request }) => {
    await request.post('/api/signals/scan', {
      headers: AUTH,
      data: { tag: 'LAB-0006', status: 'UNDER_REPAIR' },
    })

    // The instrument is on the bench but still reporting. Telemetry must not resurrect it.
    await request.post('/api/connectors/soti/poll', {
      headers: AUTH,
      data: {
        reports: [{ deviceId: 'DEV-99', assetRef: 'LAB-0006', idleMinutes: 0, reportedAt: new Date().toISOString() }],
      },
    })

    expect((await fetchAsset(request, 'LAB-0006')).status).toBe('UNDER_REPAIR')
  })

  test('mutating endpoints reject an unauthenticated caller', async ({ request }) => {
    for (const path of ['/api/sap/sync', '/api/signals/scan', '/api/admin/sweep']) {
      const response = await request.post(path, { data: {} })
      expect(response.status(), `${path} must not be open`).toBe(401)
    }
  })

  test('a scan of an unknown tag is reported, not silently accepted', async ({ request }) => {
    const response = await request.post('/api/signals/scan', { headers: AUTH, data: { tag: 'NOT-A-REAL-TAG' } })
    expect(response.status()).toBe(404)
  })
})
