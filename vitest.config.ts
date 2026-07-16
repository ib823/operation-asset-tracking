import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only unit/pure tests by default. Integration tests needing Postgres live in
    // *.integration.test.ts and run in the `integration` project below, so a contributor
    // without a database can still run the fast suite.
    include: ['packages/**/*.test.ts', 'app/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts', 'e2e/**'],
    environment: 'node',
  },
})
