import { pollConnector, resolveConnectorFlags, SotiDeviceReport } from '@oat/connectors'
import { prisma } from '@oat/db'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireServiceToken } from '@/lib/api-auth'
import { sotiConnector } from '@/lib/connectors'

export const dynamic = 'force-dynamic'

const PollBody = z.object({
  /**
   * Device reports for the MOCK adapter, so demos and tests are deterministic — a poll whose
   * result depends on wall-clock drift is not something you can assert on.
   *
   * Ignored by the real adapter, which fetches from the MDM. That asymmetry is deliberate:
   * a real tenant must never accept caller-supplied telemetry, or anyone with the service
   * token could fabricate the utilisation figures a disposal decision rests on.
   */
  reports: z.array(SotiDeviceReport).default([]),
})

/** POST /api/connectors/soti/poll — poll SOTI and ingest what it reports. */
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

  const { connector, mode } = sotiConnector(parsed.data.reports)

  try {
    const result = await pollConnector(prisma, connector)
    return NextResponse.json({ ...result, mode })
  } catch (error) {
    // An MDM outage is not our outage. Report it and let the scheduler retry; the register
    // stays usable via scan regardless (graceful degradation).
    return NextResponse.json(
      { error: 'SOTI poll failed', mode, detail: error instanceof Error ? error.message : 'unknown' },
      { status: 502 },
    )
  }
}
