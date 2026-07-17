import { ingestToConnector, resolveConnectorFlags, ScanConnector, ScanPayload } from '@oat/connectors'
import { audit, scopeToSite } from '@oat/auth'
import { prisma } from '@oat/db'
import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/signals/scan — submit a barcode/QR scan.
 *
 * The fallback floor: with every automated connector disabled, this endpoint plus manual
 * entry keeps the register fully usable.
 *
 * A scan is the human side of ADR-0010 — it owns location, custodian, and administrative
 * status, and wins IN_USE/IDLE for the scan TTL.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requirePermission('scan:submit')
  if (!guard.ok) return guard.response

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

  const asset = await prisma.asset.findUnique({
    where: { tag: parsed.data.tag },
    select: { id: true, siteId: true, status: true, location: true },
  })

  // A scan of an unknown tag is the operator's most likely mistake, and a silent 200 would
  // leave them believing it registered.
  if (!asset) {
    return NextResponse.json(
      { error: 'Unknown asset tag', tag: parsed.data.tag, hint: 'Tag is not in the register' },
      { status: 404 },
    )
  }

  // Site scoping, enforced before the write: a Branch user must not be able to move or
  // re-status an asset at another site just because they know its tag.
  const scope = scopeToSite(guard.principal)
  if (scope.kind === 'none' || (scope.kind === 'site' && scope.siteId !== asset.siteId)) {
    return NextResponse.json({ error: 'Forbidden', reason: 'Asset is not at your site' }, { status: 403 })
  }

  const result = await ingestToConnector(prisma, new ScanConnector(), {
    ...parsed.data,
    // The authenticated user is the scanner, whatever the body claims. Trusting a
    // client-supplied identity would make the audit trail worthless.
    scannedBy: guard.principal.email,
  })

  // Location is scan-owned (ADR-0010): write it and its history here, where the human is.
  if (parsed.data.location && parsed.data.location !== asset.location) {
    await prisma.$transaction([
      prisma.asset.update({ where: { id: asset.id }, data: { location: parsed.data.location } }),
      prisma.locationHistory.create({
        data: {
          assetId: asset.id,
          from: asset.location,
          to: parsed.data.location,
          movedAt: parsed.data.observedAt ?? new Date(),
          source: 'scan',
        },
      }),
    ])
  }

  if (parsed.data.custodianId) {
    await prisma.asset.update({ where: { id: asset.id }, data: { custodianId: parsed.data.custodianId } })
  }

  await audit(prisma, guard.principal, {
    action: 'SCAN',
    entity: 'Asset',
    entityId: asset.id,
    before: { status: asset.status, location: asset.location },
    after: { status: parsed.data.status ?? asset.status, location: parsed.data.location ?? asset.location },
  })

  return NextResponse.json({
    accepted: result.accepted,
    duplicates: result.duplicates,
    assetsUpdated: result.assetsUpdated,
  })
}
