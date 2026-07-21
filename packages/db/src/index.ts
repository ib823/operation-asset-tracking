import { PrismaClient } from '@prisma/client'

export * from '@prisma/client'

/**
 * Resolve the connection string, preferring Neon's POOLED (pgBouncer) endpoint on serverless.
 *
 * On Vercel the app runs as many short-lived function instances. Each plain Prisma client
 * opens its own TCP connection to Postgres; pointed at Neon's DIRECT (`-pooler`-less) host
 * those connections fan out until Neon's ceiling is hit, and a cold autosuspended compute is
 * woken on the first hit — which reads as a stalled request. Neon's Vercel integration also
 * publishes `POSTGRES_PRISMA_URL`: the same database via the `-pooler` (pgBouncer) host, which
 * multiplexes the fan-out and carries `connect_timeout=15` so a stuck connect FAILS FAST
 * rather than hanging forever.
 *
 * Through pgBouncer's transaction pooling, prepared statements must be disabled or Prisma hits
 * intermittent "prepared statement already exists" errors — `pgbouncer=true` does that. We add
 * it if Neon's URL did not already include it.
 *
 * Precedence: `POSTGRES_PRISMA_URL` (Vercel/Neon prod) → `DATABASE_URL` (local docker, direct
 * seed/job connections, CI). The pooled var is absent locally and in CI, so those paths are
 * untouched.
 */
function resolvePrismaUrl(): string | undefined {
  const pooled = process.env.POSTGRES_PRISMA_URL
  if (!pooled) return process.env.DATABASE_URL
  const url = new URL(pooled)
  if (!url.searchParams.has('pgbouncer')) url.searchParams.set('pgbouncer', 'true')
  return url.toString()
}

/**
 * A single PrismaClient per process.
 *
 * Next.js dev hot-reloads module state, which would otherwise open a new pool on every
 * edit until Postgres refuses connections. Stash the client on globalThis so reloads reuse
 * it. In production the module is evaluated once and the global is never read.
 */
const globalForPrisma = globalThis as unknown as { oatPrisma?: PrismaClient }

export const prisma: PrismaClient =
  globalForPrisma.oatPrisma ??
  new PrismaClient({
    datasourceUrl: resolvePrismaUrl(),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.oatPrisma = prisma
}
