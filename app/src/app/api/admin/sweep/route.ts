import { sweepIdleAssets } from '@oat/core'
import { prisma } from '@oat/db'
import { NextResponse } from 'next/server'
import { requireApiToken } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/sweep — re-project every live asset against the clock.
 *
 * Idleness accrues *because* nothing is being reported, so it cannot be discovered by
 * waiting for a signal to arrive. This sweep is what turns silence into an IDLE status.
 * Scheduled via pg-boss in Phase 1; manual trigger for the Phase 0 demo.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const denied = requireApiToken(request)
  if (denied) return denied

  const result = await sweepIdleAssets(prisma)
  return NextResponse.json(result)
}
