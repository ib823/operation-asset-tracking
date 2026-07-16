import { PrismaClient } from '@prisma/client'

/**
 * Truncate operational data, leaving the schema alone.
 *
 * Used by the e2e global setup to get a known starting state. Deliberately NOT
 * `prisma migrate reset`: that drops and recreates the schema, which is a heavier and more
 * destructive act than the tests need, and it is not something a test harness should be in
 * the habit of doing to whatever database `DATABASE_URL` happens to point at.
 *
 * Guarded against production regardless — a data wipe triggered by a misaimed env var is
 * exactly the kind of accident worth spending ten lines to prevent.
 */
const prisma = new PrismaClient()

function assertNotProduction(): void {
  const url = process.env.DATABASE_URL ?? ''

  if (process.env.NODE_ENV === 'production' && !process.env.OAT_ALLOW_DATA_RESET) {
    throw new Error('Refusing to reset data with NODE_ENV=production. Set OAT_ALLOW_DATA_RESET=1 to override.')
  }

  const isLocal = /@(localhost|127\.0\.0\.1|postgres)[:/]/.test(url)
  if (!isLocal && !process.env.OAT_ALLOW_DATA_RESET) {
    throw new Error(
      `Refusing to reset data: DATABASE_URL does not look local (${url.replace(/:[^:@]*@/, ':***@')}).\n` +
        'Set OAT_ALLOW_DATA_RESET=1 if this really is a throwaway database.',
    )
  }
}

async function main(): Promise<void> {
  assertNotProduction()

  // Order matters: children before parents, since Asset.siteId is Restrict-on-delete.
  await prisma.signalEvent.deleteMany()
  await prisma.utilisationSnapshot.deleteMany()
  await prisma.locationHistory.deleteMany()
  await prisma.auditLog.deleteMany()
  await prisma.asset.deleteMany()
  await prisma.site.deleteMany()

  console.log('Operational data cleared.')
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
