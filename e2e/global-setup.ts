import { execFileSync } from 'node:child_process'

/**
 * Reset the database to a known state before the e2e run.
 *
 * The specs assert exact statuses and counts, so they must start from the seed rather than
 * from whatever a previous run or a manual demo left behind. A run that fails on leftover
 * state teaches nothing.
 *
 * Clears data and re-seeds; it does not drop the schema. Migrations are applied separately
 * (by CI, or by the developer) — a test harness should not be recreating the schema of
 * whatever database DATABASE_URL points at.
 */
export default function globalSetup(): void {
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://oat:oat_dev_password@localhost:5432/oat',
    OAT_SEED_PASSWORD: process.env.OAT_SEED_PASSWORD ?? 'devpassword123',
  }

  const run = (args: string[]) => execFileSync('pnpm', args, { env, stdio: 'inherit' })

  run(['--filter', '@oat/db', 'migrate:deploy'])
  run(['--filter', '@oat/seed', 'reset:data'])
  run(['--filter', '@oat/seed', 'seed'])
}
