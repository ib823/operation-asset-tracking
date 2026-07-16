import { defineConfig } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 3100)
const BASE_URL = `http://127.0.0.1:${PORT}`

/**
 * E2E runs against a production build on a dedicated port, not the dev server: the Phase 0
 * acceptance criterion is that the *shipped* slice works, and dev-mode behaviour differs
 * enough (caching, error overlays) that passing there would not prove it.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  // The specs share one database and assert on asset state, so parallel workers would race.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm --filter @oat/app start --port ${PORT}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://oat:oat_dev_password@localhost:5432/oat',
      OAT_API_TOKEN: process.env.OAT_API_TOKEN ?? 'e2e_token',
      OAT_CONNECTOR_SCAN: '1',
      OAT_CONNECTOR_SOTI: '1',
      OAT_SAP_CLIENT: 'mock',
    },
  },
})
