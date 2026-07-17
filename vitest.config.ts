import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only unit/pure tests by default. Integration tests needing Postgres live in
    // *.integration.test.ts and run in the `integration` project below, so a contributor
    // without a database can still run the fast suite.
    // *.integration.test.ts talks to real infrastructure (a live snmpd) and skips itself
    // when that is absent, so it is safe in the default suite — a contributor without
    // Docker still gets a green run, and CI starts the agent and gets the real coverage.
    include: ['packages/**/*.test.ts', 'app/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
    environment: 'node',
  },
})
