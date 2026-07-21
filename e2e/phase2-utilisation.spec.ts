import { expect, test } from '@playwright/test'
import { apiAs, fetchAsset, resetOperational, SERVICE_AUTH, signIn, USERS } from './helpers'

/**
 * Phase 2 acceptance: utilisation rollups (ADR-0015), the resolvable idle config (ADR-0014),
 * the per-site scan TTL (ADR-0013), and threshold alerts.
 */

test.beforeEach(resetOperational)

// Asia/Kuala_Lumpur — the rollup's DEFAULT_TIMEZONE (ADR-0015) — is permanently UTC+8, no DST;
// the same invariant packages/core's localDayBounds relies on.
const KL_OFFSET_MS = 8 * 60 * 60_000

/** A day of 5-minute polls: busy for the first `busyHours`, quiet afterwards. */
function dayOfPolls(assetRef: string, opts: { hours: number; busyHours: number; dayOffset?: number }) {
  const { hours, busyHours, dayOffset = 1 } = opts

  // Anchor the polls at 10:00 KL of the rollup's target local day (default: yesterday) so the
  // whole window lands inside the rollup's KL-local-day period. The old `setUTCHours(2, …)` kept
  // the UTC calendar date of `now - dayOffset·24h`; whenever CI runs past 16:00 UTC (= KL
  // midnight) that UTC date is a day behind the KL day the rollup actually rolls up, so every
  // poll fell outside the window and the rollup wrote zero snapshots — green before 16:00 UTC,
  // red after. Deriving the KL day directly is stable at any wall-clock run time.
  const target = Date.now() - dayOffset * 24 * 60 * 60_000
  const klMidnightUtcMs = Math.floor((target + KL_OFFSET_MS) / 86_400_000) * 86_400_000 - KL_OFFSET_MS
  const start = new Date(klMidnightUtcMs + 10 * 60 * 60_000) // 10:00 KL — deep inside the day

  const reports = []
  for (let i = 0; i * 5 <= hours * 60; i++) {
    const minutes = i * 5
    reports.push({
      deviceId: `DEV-${assetRef}`,
      assetRef,
      // idleMinutes 0 while busy; afterwards it climbs, which dates the last activity.
      idleMinutes: minutes <= busyHours * 60 ? 0 : minutes - busyHours * 60,
      reportedAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
    })
  }
  return { reports }
}

test.describe('utilisation rollups (ADR-0015)', () => {
  test('measures busy against observed time, and reports the denominator', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)

    // 8 hours of coverage; busy for the first 2.
    const poll = await hq.request.post('/api/connectors/soti/poll', {
      headers: SERVICE_AUTH,
      data: dayOfPolls('LAB-0004', { hours: 8, busyHours: 2 }),
    })
    expect((await poll.json()).accepted).toBeGreaterThan(0)

    const rollup = await hq.request.post('/api/admin/rollup', { headers: SERVICE_AUTH, data: {} })
    expect(rollup.ok()).toBeTruthy()
    expect((await rollup.json()).written).toBeGreaterThan(0)

    const history = await (await hq.request.get('/api/assets/LAB-0004/utilisation')).json()
    const snapshot = history.snapshots[0]

    expect(snapshot.observedMinutes).toBe(480)
    // Last activity at +120 min, IT threshold 30 → busy window ends at 150.
    expect(snapshot.busyMinutes).toBe(150)
    expect(snapshot.utilisationPct).toBeCloseTo(31.3, 0)
    await hq.close()
  })

  test('writes NO snapshot for an eligible asset nobody watched — unknown is not 0%', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)

    await hq.request.post('/api/connectors/soti/poll', {
      headers: SERVICE_AUTH,
      data: dayOfPolls('LAB-0004', { hours: 8, busyHours: 2 }),
    })
    const summary = await (await hq.request.post('/api/admin/rollup', { headers: SERVICE_AUTH, data: {} })).json()

    // LAB-0007 (IT) and LAB-0008 (SCANNER) are eligible but had no telemetry.
    expect(summary.unobserved).toBeGreaterThan(0)

    const history = await (await hq.request.get('/api/assets/LAB-0007/utilisation')).json()
    expect(history.snapshots).toHaveLength(0)
    await hq.close()
  })

  test('skips classes whose connector is not deployed — instruments wait for the LIS', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)

    const summary = await (await hq.request.post('/api/admin/rollup', { headers: SERVICE_AUTH, data: {} })).json()

    // Derived from the flags, never hardcoded: instruments start rolling up the day the LIS
    // connector is enabled.
    expect(summary.skippedClasses).toContain('LAB_INSTRUMENT')
    expect(summary.skippedClasses).toContain('REUSABLE_COMPONENT')
    await hq.close()
  })

  test('is idempotent — re-running overwrites rather than duplicating', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)

    await hq.request.post('/api/connectors/soti/poll', {
      headers: SERVICE_AUTH,
      data: dayOfPolls('LAB-0004', { hours: 8, busyHours: 2 }),
    })
    await hq.request.post('/api/admin/rollup', { headers: SERVICE_AUTH, data: {} })
    await hq.request.post('/api/admin/rollup', { headers: SERVICE_AUTH, data: {} })

    const history = await (await hq.request.get('/api/assets/LAB-0004/utilisation')).json()
    expect(history.snapshots).toHaveLength(1)
    await hq.close()
  })

  test('the dashboard says "not measured", never 0%, for an unmeasured site', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    await hq.request.post('/api/connectors/soti/poll', {
      headers: SERVICE_AUTH,
      data: dayOfPolls('LAB-0004', { hours: 8, busyHours: 2 }),
    })
    await hq.request.post('/api/admin/rollup', { headers: SERVICE_AUTH, data: {} })
    await hq.close()

    const { context, page } = await signIn(browser, USERS.labManager)
    await page.goto('/')

    // KL01 holds LAB-0004 and was measured; the other sites have no connector data at all.
    const kl01 = page.locator('[data-site-code="KL01"]').getByTestId('site-utilisation')
    await expect(kl01).toContainText('%')

    const jb03 = page.locator('[data-site-code="JB03"]').getByTestId('site-utilisation')
    await expect(jb03).toContainText('not measured')
    await expect(jb03).not.toContainText('0%')

    await context.close()
  })

  test('only the scheduler may trigger a rollup', async ({ browser, request }) => {
    expect((await request.post('/api/admin/rollup', { data: {} })).status()).toBe(401)

    const hq = await apiAs(browser, USERS.labManager)
    // A human session is not a service token: different callers.
    expect((await hq.request.post('/api/admin/rollup', { data: {} })).status()).toBe(401)
    await hq.close()
  })
})

test.describe('idle config (ADR-0014)', () => {
  test('resolves class → default, and shows where the value came from', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    const config = await (await hq.request.get('/api/idle-config')).json()

    const it = config.classes.find((c: { class: string }) => c.class === 'IT')
    expect(it.thresholdMinutes).toBe(30)
    expect(it.thresholdSource).toBe('default')
    // Not overridable, and surfaced so it is obvious why an instrument reports nothing.
    expect(it.activitySources).toEqual(['osquery', 'soti'])
    await hq.close()
  })

  test('a sub-type override beats the class', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)

    await hq.request.put('/api/idle-config', { data: { scope: 'CLASS', key: 'LAB_INSTRUMENT', thresholdMinutes: 90 } })
    await hq.request.put('/api/idle-config', {
      data: { scope: 'SUB_TYPE', key: 'LAB_INSTRUMENT:Microscope', thresholdMinutes: 480 },
    })

    const config = await (await hq.request.get('/api/idle-config')).json()
    const instrument = config.classes.find((c: { class: string }) => c.class === 'LAB_INSTRUMENT')

    expect(instrument.thresholdMinutes).toBe(90)
    expect(instrument.thresholdSource).toBe('class')
    expect(config.subTypeOverrides).toContainEqual(
      expect.objectContaining({ key: 'LAB_INSTRUMENT:Microscope', thresholdMinutes: 480 }),
    )
    await hq.close()
  })

  test('rejects a sub-type no asset has, rather than saving a row that never matches', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)

    const response = await hq.request.put('/api/idle-config', {
      data: { scope: 'SUB_TYPE', key: 'LAB_INSTRUMENT:Micrscope', thresholdMinutes: 480 },
    })

    expect(response.status()).toBe(400)
    await hq.close()
  })

  test('a threshold change takes effect on the next projection', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)

    // 45 minutes idle: over IT's 30-minute default.
    await hq.request.post('/api/connectors/soti/poll', {
      headers: SERVICE_AUTH,
      data: {
        reports: [{ deviceId: 'D1', assetRef: 'LAB-0004', idleMinutes: 45, reportedAt: new Date().toISOString() }],
      },
    })
    expect((await fetchAsset(hq.request, 'LAB-0004')).status).toBe('IDLE')

    // Relax the class to 90 minutes and re-project. Because signals are an append-only log,
    // this is a recompute — not a migration, and nothing is lost.
    await hq.request.put('/api/idle-config', { data: { scope: 'CLASS', key: 'IT', thresholdMinutes: 90 } })
    await hq.request.post('/api/admin/sweep', { headers: SERVICE_AUTH })

    expect((await fetchAsset(hq.request, 'LAB-0004')).status).toBe('IN_USE')
    await hq.close()
  })

  test('only a manager may change the policy; others may read it', async ({ browser }) => {
    const branch = await apiAs(browser, USERS.branchKl)
    // Branch has no utilisation:read at all.
    expect((await branch.request.get('/api/idle-config')).status()).toBe(403)
    await branch.close()

    const finance = await apiAs(browser, USERS.finance)
    expect((await finance.request.get('/api/idle-config')).status()).toBe(200)
    // Finance reads utilisation but does not decide what idle means.
    expect(
      (
        await finance.request.put('/api/idle-config', { data: { scope: 'CLASS', key: 'IT', thresholdMinutes: 90 } })
      ).status(),
    ).toBe(403)
    await finance.close()
  })

  test('the policy page shows the resolved value and flags provisional defaults', async ({ browser }) => {
    const { context, page } = await signIn(browser, USERS.labManager)
    await page.goto('/settings/idle-policy')

    await expect(page.getByRole('heading', { name: 'Idle policy' })).toBeVisible()

    const row = page.locator('[data-class="IT"]')
    await expect(row.getByTestId('threshold')).toContainText('30m')
    // A placeholder nobody flags becomes a client-approved figure by accident.
    await expect(row.getByTestId('threshold-source')).toContainText('provisional default')

    await context.close()
  })
})

test.describe('threshold alerts', () => {
  test('raises an alert once an asset is idle past its threshold', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)

    await hq.request.put('/api/idle-config', {
      data: { scope: 'CLASS', key: 'IT', thresholdMinutes: 30, alertAfterMinutes: 60 },
    })
    await hq.request.post('/api/connectors/soti/poll', {
      headers: SERVICE_AUTH,
      data: {
        reports: [{ deviceId: 'D1', assetRef: 'LAB-0004', idleMinutes: 600, reportedAt: new Date().toISOString() }],
      },
    })

    const alerts = await (await hq.request.get('/api/alerts')).json()
    expect(alerts.count).toBe(1)
    expect(alerts.alerts[0].asset.tag).toBe('LAB-0004')
    // The threshold as it was when the alert fired, so it stays explicable after a config change.
    expect(alerts.alerts[0].thresholdMinutes).toBe(60)
    await hq.close()
  })

  test('does not stack duplicate alerts for the same asset', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    await hq.request.put('/api/idle-config', {
      data: { scope: 'CLASS', key: 'IT', thresholdMinutes: 30, alertAfterMinutes: 60 },
    })

    for (let i = 0; i < 3; i++) {
      await hq.request.post('/api/connectors/soti/poll', {
        headers: SERVICE_AUTH,
        data: {
          reports: [
            {
              deviceId: `D${i}`,
              assetRef: 'LAB-0004',
              idleMinutes: 600 + i,
              reportedAt: new Date(Date.now() + i * 1000).toISOString(),
            },
          ],
        },
      })
    }

    // An alert per sweep for the same fact would train everyone to ignore them.
    expect((await (await hq.request.get('/api/alerts')).json()).count).toBe(1)
    await hq.close()
  })

  test('resolves the alert when the asset is used again', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    await hq.request.put('/api/idle-config', {
      data: { scope: 'CLASS', key: 'IT', thresholdMinutes: 30, alertAfterMinutes: 60 },
    })
    await hq.request.post('/api/connectors/soti/poll', {
      headers: SERVICE_AUTH,
      data: {
        reports: [{ deviceId: 'D1', assetRef: 'LAB-0004', idleMinutes: 600, reportedAt: new Date().toISOString() }],
      },
    })
    expect((await (await hq.request.get('/api/alerts')).json()).count).toBe(1)

    await hq.request.post('/api/connectors/soti/poll', {
      headers: SERVICE_AUTH,
      data: {
        reports: [
          {
            deviceId: 'D2',
            assetRef: 'LAB-0004',
            idleMinutes: 0,
            reportedAt: new Date(Date.now() + 1000).toISOString(),
          },
        ],
      },
    })

    expect((await (await hq.request.get('/api/alerts')).json()).count).toBe(0)
    await hq.close()
  })

  test('acknowledging stops the noise but does not declare the asset busy', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    await hq.request.put('/api/idle-config', {
      data: { scope: 'CLASS', key: 'IT', thresholdMinutes: 30, alertAfterMinutes: 60 },
    })
    await hq.request.post('/api/connectors/soti/poll', {
      headers: SERVICE_AUTH,
      data: {
        reports: [{ deviceId: 'D1', assetRef: 'LAB-0004', idleMinutes: 600, reportedAt: new Date().toISOString() }],
      },
    })

    const alert = (await (await hq.request.get('/api/alerts')).json()).alerts[0]
    expect((await hq.request.post(`/api/alerts/${alert.id}`)).ok()).toBeTruthy()

    // Gone from the open list...
    expect((await (await hq.request.get('/api/alerts')).json()).count).toBe(0)
    // ...but the asset is still idle. Nobody gets to declare a machine busy by clicking.
    expect((await fetchAsset(hq.request, 'LAB-0004')).status).toBe('IDLE')
    expect((await (await hq.request.get('/api/alerts?status=ACKNOWLEDGED')).json()).count).toBe(1)
    await hq.close()
  })

  test('alerts are site-scoped like the register', async ({ browser }) => {
    const hq = await apiAs(browser, USERS.labManager)
    await hq.request.put('/api/idle-config', {
      data: { scope: 'CLASS', key: 'IT', thresholdMinutes: 30, alertAfterMinutes: 60 },
    })
    // LAB-0004 is at KL01.
    await hq.request.post('/api/connectors/soti/poll', {
      headers: SERVICE_AUTH,
      data: {
        reports: [{ deviceId: 'D1', assetRef: 'LAB-0004', idleMinutes: 600, reportedAt: new Date().toISOString() }],
      },
    })
    await hq.close()

    const pj = await apiAs(browser, USERS.branchPj)
    // Branch has no utilisation:read; the endpoint is closed to them entirely.
    expect((await pj.request.get('/api/alerts')).status()).toBe(403)
    await pj.close()
  })
})
