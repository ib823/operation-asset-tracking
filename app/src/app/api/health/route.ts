import { prisma } from '@oat/db'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/health — liveness plus database reachability.
 *
 * Unauthenticated on purpose: this is what compose, a load balancer, or a Malaysia-region
 * deployment's probe calls, and it leaks nothing beyond "the database answers".
 */
export async function GET(): Promise<NextResponse> {
  try {
    await prisma.$queryRaw`SELECT 1`
    return NextResponse.json({ status: 'ok', database: 'up' })
  } catch {
    // Deliberately no error detail — a health endpoint is a public surface and a driver
    // error string can carry a connection string.
    return NextResponse.json({ status: 'degraded', database: 'down' }, { status: 503 })
  }
}
