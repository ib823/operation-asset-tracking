import type { PrismaClient } from '@oat/db'
import {
  assertApproved,
  type SapEventSink,
  type SapOutboundEvent,
  type SapWriteApproval,
  type SapWriteResult,
} from './contract'

/**
 * OAT → SAP write-back.
 *
 * The only path out of the OAT into SAP. It accepts `SapOutboundEvent` — a closed union of
 * three accounting-relevant event kinds — and nothing else. There is no generic `post`, so
 * telemetry has no way through here even if someone wants it to (ADR-0004).
 */
export async function emitToSap(
  prisma: PrismaClient,
  sink: SapEventSink,
  event: SapOutboundEvent,
  approval: SapWriteApproval,
): Promise<SapWriteResult> {
  // Belt and braces: the compiler already guarantees the event shape, but this path may be
  // driven by a queue payload one day, where types are long gone.
  assertApproved(event, approval)

  const result = await sink.send(event, approval)

  // Audit the attempt whatever the outcome. A failed write-back to the financial system of
  // record is precisely the thing an auditor will ask about later.
  await prisma.auditLog.create({
    data: {
      actor: approval.approvedBy,
      action: `SAP_WRITEBACK_${event.kind}`,
      entity: 'SapAsset',
      entityId: event.assetNo,
      // `before` is left unset rather than null: Prisma distinguishes JSON null from SQL
      // NULL on a Json? column, and a write-back has no prior state to record either way.
      after: {
        event: JSON.parse(JSON.stringify(event)),
        approvalReference: approval.reference,
        ok: result.ok,
        sapReference: result.sapReference ?? null,
        error: result.error ?? null,
      } as never,
    },
  })

  return result
}
