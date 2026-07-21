import { defineConfig, devices } from '@playwright/test'

/**
 * Isolated config for the deployed-environment render check (tests-prod/). No local
 * webServer — it drives a real Chromium against a live URL and captures a trace + screenshots
 * so a failure shows exactly what the browser painted.
 */
export default defineConfig({
  testDir: 'tests-prod',
  timeout: 90_000,
  retries: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    trace: 'on',
    screenshot: 'on',
    video: 'retain-on-failure',
  },
})
