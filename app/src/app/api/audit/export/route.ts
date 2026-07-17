import { prisma } from '@oat/db'
import { NextResponse, type NextRequest } from 'next/server'
import { requirePermission } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/audit/export — the audit and auth trail, for a SIEM (RFP 1.41, §8).
 *
 * NDJSON by default: one self-contained JSON object per line. That is what Splunk, Elastic
 * and friends ingest natively, and unlike a JSON array it streams and survives truncation —
 * a cut-off array is unparseable, whereas a cut-off NDJSON file is just shorter.
 *
 * Cursor-paginated on `at`+`id`, never OFFSET: the audit log only grows, and OFFSET over a
 * table with millions of rows degrades until the nightly export stops finishing.
 */

const MAX_PAGE = 5_000
const DEFAULT_PAGE = 1_000

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requirePermission('audit:read')
  if (!guard.ok) return guard.response

  const params = request.nextUrl.searchParams

  const since = parseDate(params.get('since'))
  const until = parseDate(params.get('until'))
  const limit = Math.min(Number(params.get('limit')) || DEFAULT_PAGE, MAX_PAGE)
  const cursor = params.get('cursor')
  const format = params.get('format') === 'json' ? 'json' : 'ndjson'

  const entries = await prisma.auditLog.findMany({
    where: {
      ...(since || until ? { at: { ...(since ? { gte: since } : {}), ...(until ? { lt: until } : {}) } } : {}),
    },
    // Ascending and stable: a SIEM resumes from where it stopped, so the order must not
    // depend on when you asked. `id` breaks ties within the same millisecond.
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
    take: limit,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  })

  const records = entries.map((entry) => ({
    // Field names a SIEM expects, not our column names — this is an integration surface, and
    // renaming a Prisma column must not break Lablink's ingest pipeline.
    timestamp: entry.at.toISOString(),
    event_id: entry.id,
    event_type: entry.action,
    actor: entry.actor,
    entity_type: entry.entity,
    entity_id: entry.entityId,
    ...(entry.before !== null ? { before: entry.before } : {}),
    ...(entry.after !== null ? { after: entry.after } : {}),
    source: 'lablink-oat',
  }))

  // The cursor to resume from. Null means the caller has caught up.
  const nextCursor = entries.length === limit ? entries[entries.length - 1]!.id : null

  if (format === 'json') {
    return NextResponse.json({ count: records.length, nextCursor, records })
  }

  const body = records.map((record) => JSON.stringify(record)).join('\n')

  return new NextResponse(body.length > 0 ? `${body}\n` : '', {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      // The cursor travels in a header so the body stays pure NDJSON — a pagination envelope
      // would defeat the point of a format you can `cat` straight into an ingester.
      ...(nextCursor ? { 'X-Next-Cursor': nextCursor } : {}),
      'X-Record-Count': String(records.length),
      // An audit export is not cacheable by anything, ever.
      'Cache-Control': 'no-store',
    },
  })
}

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}
