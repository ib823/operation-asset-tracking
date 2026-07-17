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
  // The specs share one database and assert on asset state and counts, so parallel workers
  // would race. Each spec file also resets data (see the beforeEach in helpers usage), but
  // serial execution is what makes those resets meaningful.
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
      AUTH_SECRET: process.env.AUTH_SECRET ?? 'e2e_only_auth_secret_not_used_anywhere_else',
      // Required, or Auth.js throws UntrustedHost inside middleware — which Next swallows,
      // silently disabling the gate (ADR-0012).
      AUTH_TRUST_HOST: 'true',
      OAT_SERVICE_TOKEN: process.env.OAT_SERVICE_TOKEN ?? 'e2e_service_token',
      OAT_SEED_PASSWORD: process.env.OAT_SEED_PASSWORD ?? 'devpassword123',
      OAT_CONNECTOR_SCAN: '1',
      OAT_CONNECTOR_SOTI: '1',
      OAT_SAP_CLIENT: 'mock',
    },
  },
})
