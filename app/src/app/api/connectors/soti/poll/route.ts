import { MockSotiConnector, pollConnector, resolveConnectorFlags, SotiDeviceReport } from '@oat/connectors'
import { prisma } from '@oat/db'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireServiceToken } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

const PollBody = z.object({
  /**
   * Device reports to feed the mock MDM.
   *
   * Supplied by the caller so the demo and the e2e test are deterministic — a poll whose
   * result depends on wall-clock drift is not something you can assert on. The real SOTI
   * adapter (Phase 2) fetches from the MDM and ignores any body.
   */
  reports: z.array(SotiDeviceReport).default([]),
})

/**
 * POST /api/connectors/soti/poll — poll the (mock) SOTI MDM and ingest what it reports.
 *
 * A machine caller (the scheduler), so it takes the service token rather than a session.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const denied = requireServiceToken(request)
  if (denied) return denied

  const flags = resolveConnectorFlags()
  if (!flags.soti) {
    // Not an error: a deployment without SOTI is a supported configuration and the register
    // works without it. Say so plainly rather than failing.
    return NextResponse.json({ error: 'SOTI connector is disabled', flag: 'OAT_CONNECTOR_SOTI' }, { status: 503 })
  }

  let body: unknown = {}
  try {
    body = await request.json()
  } catch {
    // An empty body is a legitimate "poll with nothing to report".
  }

  const parsed = PollBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid reports', details: parsed.error.flatten() }, { status: 400 })
  }

  const result = await pollConnector(prisma, new MockSotiConnector(parsed.data.reports))
  return NextResponse.json(result)
}
