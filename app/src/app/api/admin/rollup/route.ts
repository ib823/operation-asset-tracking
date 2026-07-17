import { rollUpDay } from '@oat/core'
import { prisma } from '@oat/db'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireServiceToken } from '@/lib/api-auth'
import { enabledActivitySources } from '@/lib/connectors'

export const dynamic = 'force-dynamic'

const Body = z.object({
  /** The local day to roll up. Defaults to yesterday — today is not over yet. */
  day: z.coerce.date().optional(),
})

/**
 * POST /api/admin/rollup — roll a local day of signals into utilisation snapshots.
 *
 * Idempotent: upserts on (asset, period), so re-running after a config change overwrites
 * rather than duplicating. Scheduled via pg-boss; a service token guards it because the
 * caller is the scheduler, not a person.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const denied = requireServiceToken(request)
  if (denied) return denied

  let body: unknown = {}
  try {
    body = await request.json()
  } catch {
    // An empty body means "roll up yesterday", which is the scheduled case.
  }

  const parsed = Body.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const summary = await rollUpDay(prisma, {
    ...(parsed.data.day ? { day: parsed.data.day } : {}),
    enabledSources: enabledActivitySources(),
  })

  return NextResponse.json(summary)
}
