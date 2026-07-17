import { scopeToSite } from '@oat/auth'
import { prisma } from '@oat/db'
import { NextResponse, type NextRequest } from 'next/server'
import { requirePermission } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/alerts — assets idle past their configured alert threshold (ADR-0015).
 *
 * Site-scoped like the register: a Branch user sees their own site's alerts and no others.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requirePermission('utilisation:read')
  if (!guard.ok) return guard.response

  const scope = scopeToSite(guard.principal)
  if (scope.kind === 'none') return NextResponse.json({ count: 0, alerts: [] })

  const status = request.nextUrl.searchParams.get('status') ?? 'OPEN'
  const valid = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const
  const filter = valid.find((s) => s === status) ?? 'OPEN'

  const alerts = await prisma.idleAlert.findMany({
    where: {
      status: filter,
      ...(scope.kind === 'site' ? { asset: { siteId: scope.siteId } } : {}),
    },
    // Longest-idle first: that is the disposal conversation, and the reason this list exists.
    orderBy: { idleMinutes: 'desc' },
    take: 200,
    include: { asset: { select: { id: true, tag: true, name: true, class: true, site: { select: { code: true } } } } },
  })

  return NextResponse.json({ count: alerts.length, alerts })
}
