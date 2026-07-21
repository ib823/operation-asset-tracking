import { expect, test } from '@playwright/test'
import { apiAs, reportIdle, resetOperational, signIn, USERS } from './helpers'

/**
 * UX: the /assets status filter applies on change, with no "Filter" click. The filter itself is
 * already correct (?status=IDLE returns exactly the idle assets) — this guards the interaction:
 * choosing a status must narrow the table on its own, while the GET form keeps its shareable
 * ?status=IDLE URL and the Filter button stays as a no-JS fallback.
 */

test.describe('assets status filter applies on change (ADR — no Filter click)', () => {
  test.beforeEach(resetOperational)

  test('choosing "Idle" narrows the table to the idle assets without clicking Filter', async ({ browser }) => {
    // Arrange a deterministic mix: LAB-0004 (IT class, 30-min threshold) goes idle after 200
    // quiet minutes; the other nine seeded assets stay IN_USE. Both an idle and a non-idle row
    // must exist, or "narrowing" would be unobservable — the precondition is asserted below.
    const it = await apiAs(browser, USERS.it)
    await reportIdle(it.request, 'LAB-0004', 200)
    await it.close()

    const { context, page } = await signIn(browser, USERS.labManager)
    await page.goto('/assets')

    // Precondition: unfiltered, exactly one row is idle and there is at least one non-idle row.
    const idleRow = page.locator('[data-testid="asset-row"][data-tag="LAB-0004"]')
    const inUseRow = page.locator('[data-testid="asset-row"][data-tag="LAB-0001"]')
    await expect(idleRow).toBeVisible()
    await expect(inUseRow).toBeVisible()
    await expect(idleRow.locator('[data-testid="status-badge"]')).toHaveAttribute('data-status', 'IDLE')

    // Act: pick "Idle" and DO NOT click Filter. selectOption fires a change event, which must
    // submit the enclosing GET form on its own.
    await page.getByLabel('Filter by status').selectOption('IDLE')

    // The GET form submitted → a shareable, filtered URL (the button was never clicked)…
    await page.waitForURL(/\/assets\?[^#]*status=IDLE/)

    // …and the table is now exactly the idle assets: LAB-0004 stays, the IN_USE LAB-0001 is gone.
    await expect(idleRow).toBeVisible()
    await expect(inUseRow).toHaveCount(0)

    // No other status leaked through: every remaining row is IDLE.
    const statuses = await page
      .locator('[data-testid="asset-row"] [data-testid="status-badge"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-status')))
    expect(statuses.length).toBeGreaterThan(0)
    expect(statuses.every((s) => s === 'IDLE')).toBe(true)

    await context.close()
  })
})
