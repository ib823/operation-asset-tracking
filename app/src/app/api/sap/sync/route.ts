import { prisma } from '@oat/db'
import { syncAssetMaster } from '@oat/sap'
import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/api-auth'
import { sapMasterSource } from '@/lib/sap-client'

export const dynamic = 'force-dynamic'

/**
 * POST /api/sap/sync — pull the SAP asset master into the OAT.
 *
 * One-way by construction: this route holds a `SapMasterSource`, which has no write method
 * (ADR-0004). Never creates assets; unmatched records go to the reconciliation queue
 * (ADR-0009). Scheduled via pg-boss in Phase 2; manual trigger meanwhile.
 */
export async function POST(): Promise<NextResponse> {
  const guard = await requirePermission('sap:sync')
  if (!guard.ok) return guard.response

  const result = await syncAssetMaster(prisma, sapMasterSource(), { actor: guard.principal.email })
  return NextResponse.json(result)
}
