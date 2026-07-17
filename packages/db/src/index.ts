import { PrismaClient } from '@prisma/client'

export * from '@prisma/client'

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
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.oatPrisma = prisma
}
