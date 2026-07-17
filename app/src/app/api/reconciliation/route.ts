import { prisma } from '@oat/db'
import { NextResponse, type NextRequest } from 'next/server'
import { requirePermission } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/reconciliation — SAP records the sync could not place (ADR-0009).
 *
 * Ordered oldest-first: age is what matters. An item open for three weeks is a problem; a
 * long list of fresh ones is just last night's sync.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requirePermission('reconciliation:read')
  if (!guard.ok) return guard.response

  const status = request.nextUrl.searchParams.get('status') ?? 'OPEN'
  const valid = ['OPEN', 'RESOLVED', 'DISMISSED'] as const
  const filter = valid.find((s) => s === status) ?? 'OPEN'

  const items = await prisma.reconciliationItem.findMany({
    where: { status: filter },
    orderBy: { firstSeenAt: 'asc' },
    take: 200,
  })

  return NextResponse.json({ count: items.length, items })
}
