import { test } from '@playwright/test'
import { expect, resetOperational, signIn, USERS } from './helpers'

/**
 * UI polish (P2) — regression guards for the things a live review caught: the whole asset row
 * must be clickable, signal values must read as human labels (not raw JSON), and an unknown
 * asset must land on a branded not-found with a way back.
 */

test.beforeAll(async () => {
  // Ensure LAB-0005 has real signals so the humanised-value check has something to render.
  const { prisma } = await import('@oat/db')
  const { seedDemoSignals } = await import('@oat/seed')
  await seedDemoSignals(prisma)
})

test.afterAll(async () => {
  await resetOperational()
})

test.describe('UI polish', () => {
  test('clicking anywhere on an asset row opens its detail (P2.2)', async ({ browser }) => {
    const { context, page } = await signIn(browser, USERS.labManager)

    await page.goto('/assets')
    const row = page.locator('[data-testid="asset-row"][data-tag="LAB-0005"]')
    await expect(row).toBeVisible()

    // Click the NAME cell, not the tag link. `force` is deliberate: the stretched link's
    // pseudo-element deliberately COVERS the cell (that is what makes the whole row clickable),
    // so Playwright's obscured-element check would otherwise reject the click — the real click
    // still lands on the link and navigates, which is exactly the behaviour under test.
    await row.getByText('Label Printer TD-4550').click({ force: true })
    await page.waitForURL(/\/assets\/[a-z0-9]+$/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('LAB-0005')

    await context.close()
  })

  test('the asset row link is keyboard-focusable and Enter-activatable (P2.2)', async ({ browser }) => {
    const { context, page } = await signIn(browser, USERS.labManager)
    await page.goto('/assets')

    const link = page.locator('[data-testid="asset-row"][data-tag="LAB-0005"] a')
    await link.focus()
    await expect(link).toBeFocused()
    await page.keyboard.press('Enter')
    await page.waitForURL(/\/assets\/[a-z0-9]+$/)

    await context.close()
  })

  test('signal values render as human labels, not raw JSON (P2.1)', async ({ browser }) => {
    const { context, page } = await signIn(browser, USERS.labManager)

    await page.goto('/assets')
    await page
      .locator('[data-testid="asset-row"][data-tag="LAB-0005"]')
      .getByText('Label Printer TD-4550')
      .click({ force: true })
    await page.waitForURL(/\/assets\/[a-z0-9]+$/)

    const signals = page.locator('[data-testid="signal-row"]').first()
    await expect(signals).toBeVisible()
    // Human label present, and no bare JSON braces in the signal rows.
    const signalsText = await page.locator('[data-testid="signal-row"]').allInnerTexts()
    const joined = signalsText.join(' ')
    expect(joined).toMatch(/Busy|Reachable/)
    expect(joined).not.toContain('{"')

    await context.close()
  })

  test('an unknown asset shows a branded not-found with a way back (P2.4)', async ({ browser }) => {
    const { context, page } = await signIn(browser, USERS.labManager)

    await page.goto('/assets/this-id-does-not-exist')
    await expect(page.getByText('404 — not found')).toBeVisible()
    await expect(page.getByRole('link', { name: /Back to assets/ })).toBeVisible()

    await context.close()
  })

  test('the dashboard bar chart has a legend, not colour alone (P2.5)', async ({ browser }) => {
    const { context, page } = await signIn(browser, USERS.labManager)
    await page.goto('/')
    const legend = page.locator('ul[aria-label="Legend"]')
    await expect(legend).toBeVisible()
    await expect(legend).toContainText('In use')
    await expect(legend).toContainText('Idle')
    await context.close()
  })
})
