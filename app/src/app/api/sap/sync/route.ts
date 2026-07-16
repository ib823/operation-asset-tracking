import { prisma } from '@oat/db'
import { syncAssetMaster } from '@oat/sap'
import { NextResponse } from 'next/server'
import { requireApiToken } from '@/lib/api-auth'
import { sapMasterSource } from '@/lib/sap-client'

export const dynamic = 'force-dynamic'

/**
 * POST /api/sap/sync — pull the SAP asset master into the OAT.
 *
 * One-way by construction: this route holds a `SapMasterSource`, which has no write method
 * (ADR-0004). Scheduled via pg-boss in Phase 1; manual trigger for the Phase 0 demo.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const denied = requireApiToken(request)
  if (denied) return denied

  const result = await syncAssetMaster(prisma, sapMasterSource(), { actor: 'api:sap-sync' })
  return NextResponse.json(result)
}
