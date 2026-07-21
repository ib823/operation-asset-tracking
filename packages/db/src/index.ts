import { PrismaClient } from '@prisma/client'

export * from '@prisma/client'

/**
 * Resolve the connection string, always using Neon's DIRECT (session-mode) endpoint.
 *
 * NEVER the `-pooler` (pgBouncer transaction-mode) endpoint. Under transaction pooling,
 * Prisma's normal queries — `findMany` and friends, which use the extended query protocol —
 * silently HANG (the render never resolves; the function runs to its timeout with no error
 * thrown), while a raw `SELECT 1` still succeeds. That asymmetry is why ADR-0023 / PR #17,
 * verified only with `/api/health` (a `SELECT 1`), read green while every real data page was
 * wedged on "Loading…". `pgbouncer=true` did not save it. See ADR-0024.
 *
 * `DATABASE_URL` is the direct host in prod and locally (docker). On Vercel preview/dev it is
 * unset — there Neon's `DATABASE_URL_UNPOOLED` / `POSTGRES_URL_NON_POOLING` name the same
 * direct host, so those environments connect too (and can be verified before promotion). The
 * modest serverless fan-out this reintroduces is the state that demonstrably rendered every
 * page before PR #17; the "connection hang" #17 chased was never reproduced.
 */
function resolvePrismaUrl(): string | undefined {
  return process.env.DATABASE_URL ?? process.env.DATABASE_URL_UNPOOLED ?? process.env.POSTGRES_URL_NON_POOLING
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
