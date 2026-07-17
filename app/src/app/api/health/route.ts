import { workerHealth } from '@oat/core'
import { prisma } from '@oat/db'
import { NextResponse, type NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/health — liveness plus database reachability.
 *
 * Unauthenticated on purpose: this is what compose, a load balancer, or a Malaysia-region
 * deployment's probe calls, and it leaks nothing beyond "the database answers".
 *
 * `?deep=1` adds the SCHEDULER's health. Deliberately opt-in and not part of the default
 * probe: a stopped worker means the operational picture is frozen, but the app is still
 * serving and still useful via scan (graceful degradation). Failing the liveness probe would
 * make a load balancer kill a healthy web tier over a background job.
 *
 * Still public, and still leaks nothing: it reports states and ages, never detail.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch {
    // Deliberately no error detail — a health endpoint is a public surface and a driver
    // error string can carry a connection string.
    return NextResponse.json({ status: 'degraded', database: 'down' }, { status: 503 })
  }

  if (request.nextUrl.searchParams.get('deep') !== '1') {
    return NextResponse.json({ status: 'ok', database: 'up' })
  }

  const worker = await workerHealth(prisma)

  return NextResponse.json({
    status: 'ok',
    database: 'up',
    worker: {
      state: worker.state,
      // `detail` is withheld: it can carry an error message from a connector, and this
      // endpoint is unauthenticated.
      jobs: worker.jobs.map((job) => ({ queue: job.queue, state: job.state, minutesAgo: job.minutesAgo })),
    },
  })
}
