import { ingestToConnector, resolveConnectorFlags, ScanConnector, ScanPayload } from '@oat/connectors'
import { prisma } from '@oat/db'
import { NextResponse } from 'next/server'
import { requireApiToken } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/signals/scan — submit a barcode/QR scan.
 *
 * The fallback floor (CLAUDE.md → Connectors): with every automated connector disabled,
 * this endpoint plus manual entry keeps the register fully usable.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const denied = requireApiToken(request)
  if (denied) return denied

  const flags = resolveConnectorFlags()
  if (!flags.scan) {
    return NextResponse.json({ error: 'Scan connector is disabled' }, { status: 503 })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const parsed = ScanPayload.safeParse(payload)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid scan', details: parsed.error.flatten() }, { status: 400 })
  }

  const result = await ingestToConnector(prisma, new ScanConnector(), parsed.data)

  // A scan of an unknown tag is the operator's most likely mistake, and a silent 200 would
  // leave them believing it registered. Say so, with the tag they scanned.
  if (result.unmatched.length > 0) {
    return NextResponse.json(
      { error: 'Unknown asset tag', tag: parsed.data.tag, hint: 'Tag is not in the register' },
      { status: 404 },
    )
  }

  return NextResponse.json({
    accepted: result.accepted,
    duplicates: result.duplicates,
    assetsUpdated: result.assetsUpdated,
  })
}
