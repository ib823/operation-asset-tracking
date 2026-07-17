import { sweepIdleAssets } from '@oat/core'
import { prisma } from '@oat/db'
import { NextResponse } from 'next/server'
import { requireServiceToken } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/sweep — re-project every live asset against the clock.
 *
 * Idleness accrues BECAUSE nothing is reported, so it cannot be discovered by waiting for a
 * signal. A scan's TTL also expires purely on the clock (ADR-0010), so this sweep is what
 * turns both kinds of silence into a status change.
 *
 * Guarded by the service token, not a session: the caller is the scheduler, not a person.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const denied = requireServiceToken(request)
  if (denied) return denied

  const result = await sweepIdleAssets(prisma)
  return NextResponse.json(result)
}
