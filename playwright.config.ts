import { defineConfig } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 3100)
/** A second app, with every automated connector off, for the graceful-degradation suite. */
const DEGRADED_PORT = Number(process.env.E2E_DEGRADED_PORT ?? 3101)

const BASE_URL = `http://127.0.0.1:${PORT}`
const DEGRADED_URL = `http://127.0.0.1:${DEGRADED_PORT}`

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://oat:oat_dev_password@localhost:5432/oat'

/** Shared by both servers. */
const env = {
  DATABASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET ?? 'e2e_only_auth_secret_not_used_anywhere_else',
  // Required, or Auth.js throws UntrustedHost inside middleware — which Next swallows,
  // silently disabling the gate (ADR-0012).
  AUTH_TRUST_HOST: 'true',
  OAT_SERVICE_TOKEN: process.env.OAT_SERVICE_TOKEN ?? 'e2e_service_token',
  OAT_SEED_PASSWORD: process.env.OAT_SEED_PASSWORD ?? 'devpassword123',
  OAT_SAP_CLIENT: 'mock',
  // The scheduler runs as its own process (ADR-0020) and is deliberately NOT started here: a
  // cron mutating asset state under a suite that asserts exact counts would turn real
  // failures into apparent flakes.
}

/**
 * E2E runs against a production build, not the dev server: the acceptance criterion is that
 * the SHIPPED slice works, and dev-mode behaviour differs enough (caching, error overlays)
 * that passing there would not prove it.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  // The specs share one database and assert on exact counts, so parallel workers would race.
  // Each spec also resets operational state per test; serial execution is what makes those
  // resets meaningful.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: { trace: 'retain-on-failure' },

  projects: [
    {
      name: 'main',
      testIgnore: /degradation/,
      use: { baseURL: BASE_URL },
    },
    {
      name: 'degraded',
      // Graceful degradation is tested against a REAL degraded deployment — every automated
      // connector off — rather than a simulated one. A site with no automation is a supported
      // configuration, and this is what it actually looks like.
      testMatch: /degradation/,
      use: { baseURL: DEGRADED_URL },
    },
  ],

  webServer: [
    {
      command: `pnpm --filter @oat/app start --port ${PORT}`,
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...env, OAT_CONNECTOR_SCAN: '1', OAT_CONNECTOR_SOTI: '1' },
    },
    {
      command: `pnpm --filter @oat/app start --port ${DEGRADED_PORT}`,
      url: `${DEGRADED_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...env,
        // Scan stays on: it is the fallback floor, and the whole point is that the register
        // remains usable through it when everything else is gone.
        OAT_CONNECTOR_SCAN: '1',
        OAT_CONNECTOR_SOTI: '0',
        OAT_CONNECTOR_OSQUERY: '0',
        OAT_CONNECTOR_SNMP: '0',
        OAT_CONNECTOR_LIS: '0',
      },
    },
  ],
})
