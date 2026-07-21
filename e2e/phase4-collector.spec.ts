import { test } from '@playwright/test'
import { apiAs, expect, fetchAsset, resetOperational, USERS } from './helpers'

/**
 * The on-LAN collector, end to end (ADR-0021 / Phase 4).
 *
 * Proves the whole point of the collector against a real app and a real database: a signal a
 * collector observed on the LAN, pushed outbound over HTTP, attaches to a KNOWN asset and moves
 * its utilisation — while an unknown reference is reported and never registered, and the door is
 * shut to anyone without the collector's bearer.
 */

const COLLECTOR_ID = 'collector-e2e'
// Mirrors playwright.config's OAT_COLLECTOR_TOKENS=`collector-e2e:<token>`.
const COLLECTOR_TOKEN = (process.env.OAT_COLLECTOR_TOKENS ?? 'collector-e2e:e2e_collector_token').split(/:(.*)/)[1]!
const COLLECTOR_AUTH = { Authorization: `Bearer ${COLLECTOR_TOKEN}`, 'X-Collector-Id': COLLECTOR_ID }

const INGEST = '/api/collector/ingest'
const PRINTER_TAG = 'LAB-0005' // a seeded PRINTER

function utilisation(externalRef: string) {
  return {
    externalRef,
    source: 'snmp',
    type: 'utilisation',
    value: { busy: true },
    observedAt: new Date().toISOString(),
    dedupeKey: `snmp:${externalRef}:${Date.now()}`,
  }
}

test.beforeEach(async () => {
  await resetOperational()
})

test.describe('collector ingest', () => {
  test('a pushed signal attaches to a known seeded asset and moves its utilisation', async ({ request, browser }) => {
    const before = await (async () => {
      const api = await apiAs(browser, USERS.labManager)
      const asset = await fetchAsset(api.request, PRINTER_TAG)
      await api.close()
      return asset
    })()
    // Freshly reset: no activity yet.
    expect(before.lastActiveAt ?? null).toBeNull()

    const response = await request.post(INGEST, {
      headers: COLLECTOR_AUTH,
      data: { signals: [utilisation(PRINTER_TAG)] },
    })
    expect(response.ok(), `ingest -> ${response.status()}`).toBeTruthy()

    const body = await response.json()
    // The signal was accepted and attached to the resolved asset — not to the raw ref.
    expect(body.accepted, 'the pushed signal must actually be ingested').toBe(1)
    expect(body.unmatched).toEqual([])
    expect(body.assetsUpdated.length).toBe(1)

    // And it is visible as real utilisation on the known asset.
    const api = await apiAs(browser, USERS.labManager)
    const after = await fetchAsset(api.request, PRINTER_TAG)
    await api.close()
    expect(after.lastActiveAt, 'a utilisation signal must set lastActiveAt').not.toBeNull()
    // Telemetry stayed in the operational lane — it never touched the SAP linkage (ADR-0004).
    expect(after.sapAssetNo ?? null).toBeNull()
  })

  test('an unknown reference is reported, never turned into an asset (ADR-0009)', async ({ request, browser }) => {
    const ghost = 'GHOST-9999'

    const response = await request.post(INGEST, { headers: COLLECTOR_AUTH, data: { signals: [utilisation(ghost)] } })
    expect(response.ok()).toBeTruthy()

    const body = await response.json()
    expect(body.unmatched, 'the unknown ref must be reported').toEqual([ghost])
    expect(body.accepted, 'nothing is written for an unknown ref').toBe(0)

    // The register must be unchanged: no asset was created from the signal.
    const api = await apiAs(browser, USERS.labManager)
    const search = await api.request.get(`/api/assets?q=${ghost}`)
    const assets = (await search.json()).assets as Array<{ tag: string }>
    await api.close()
    expect(
      assets.find((a) => a.tag === ghost),
      'the collector must never create an asset',
    ).toBeUndefined()
  })

  test('the endpoint is shut without a valid collector bearer (fails closed)', async ({ request }) => {
    const signals = { signals: [utilisation(PRINTER_TAG)] }

    // No credentials at all.
    expect((await request.post(INGEST, { data: signals })).status(), 'no token -> 401').toBe(401)

    // Wrong token.
    expect(
      (
        await request.post(INGEST, {
          headers: { Authorization: 'Bearer WRONG', 'X-Collector-Id': COLLECTOR_ID },
          data: signals,
        })
      ).status(),
      'wrong token -> 401',
    ).toBe(401)

    // Right token, unknown collector id — no id-enumeration oracle.
    expect(
      (
        await request.post(INGEST, {
          headers: { Authorization: `Bearer ${COLLECTOR_TOKEN}`, 'X-Collector-Id': 'collector-ghost' },
          data: signals,
        })
      ).status(),
      'unknown id -> 401',
    ).toBe(401)
  })

  test('a redelivered signal is deduplicated, not double-counted', async ({ request }) => {
    const signal = utilisation(PRINTER_TAG) // stable dedupeKey within this test

    const first = await (await request.post(INGEST, { headers: COLLECTOR_AUTH, data: { signals: [signal] } })).json()
    expect(first.accepted).toBe(1)

    const second = await (await request.post(INGEST, { headers: COLLECTOR_AUTH, data: { signals: [signal] } })).json()
    // At-least-once delivery is safe: the redelivery collapses onto the existing row.
    expect(second.accepted).toBe(0)
    expect(second.duplicates).toBe(1)
  })
})
