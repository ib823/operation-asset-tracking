import { audit } from '@oat/auth'
import { DEFAULT_IDLE_POLICY, resolveIdlePolicy, type IdleConfigOverride } from '@oat/core'
import { prisma } from '@oat/db'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

const CLASSES = ['LAB_INSTRUMENT', 'IT', 'PRINTER', 'SCANNER', 'REUSABLE_COMPONENT', 'OTHER'] as const

const UpsertBody = z.object({
  scope: z.enum(['CLASS', 'SUB_TYPE', 'ASSET']),
  /** CLASS → "IT" · SUB_TYPE → "LAB_INSTRUMENT:Analyser" · ASSET → the asset id. */
  key: z.string().min(1),
  thresholdMinutes: z
    .number()
    .int()
    .positive()
    .max(60 * 24 * 365),
  alertAfterMinutes: z
    .number()
    .int()
    .positive()
    .max(60 * 24 * 365)
    .nullable()
    .optional(),
})

/**
 * GET /api/idle-config — the resolved idle policy per class, with its provenance.
 *
 * Returns the RESOLVED value and where it came from (ADR-0014). A number whose origin you
 * cannot see is a number nobody trusts: "120 min (class default)" is a very different claim
 * from "120 min (set on this asset)".
 */
export async function GET(): Promise<NextResponse> {
  const guard = await requirePermission('utilisation:read')
  if (!guard.ok) return guard.response

  const overrides = (await prisma.idleConfig.findMany({
    select: { scope: true, key: true, thresholdMinutes: true, alertAfterMinutes: true },
  })) as IdleConfigOverride[]

  const classes = CLASSES.map((assetClass) => {
    const resolved = resolveIdlePolicy({ id: '', class: assetClass, subType: null }, overrides)
    return {
      class: assetClass,
      thresholdMinutes: resolved.thresholdMinutes,
      thresholdSource: resolved.thresholdSource,
      alertAfterMinutes: resolved.alertAfterMinutes,
      alertSource: resolved.alertSource,
      // Not overridable, and shown so it is obvious WHY an instrument reports no
      // utilisation: nothing feeds it yet (ADR-0008).
      activitySources: resolved.activitySources,
      defaultThresholdMinutes: DEFAULT_IDLE_POLICY[assetClass].thresholdMinutes,
    }
  })

  const subTypes = overrides.filter((o) => o.scope === 'SUB_TYPE')
  const assets = overrides.filter((o) => o.scope === 'ASSET')

  return NextResponse.json({ classes, subTypeOverrides: subTypes, assetOverrides: assets })
}

/** PUT /api/idle-config — set an override at any level of the chain. */
export async function PUT(request: Request): Promise<NextResponse> {
  const guard = await requirePermission('idle-policy:manage')
  if (!guard.ok) return guard.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const parsed = UpsertBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid config', details: parsed.error.flatten() }, { status: 400 })
  }

  const { scope, key, thresholdMinutes, alertAfterMinutes } = parsed.data

  // Validate the key against its scope, so a typo becomes an error rather than a config row
  // that silently never matches anything.
  const invalid = await validateKey(scope, key)
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })

  const before = await prisma.idleConfig.findUnique({ where: { scope_key: { scope, key } } })

  const saved = await prisma.idleConfig.upsert({
    where: { scope_key: { scope, key } },
    create: {
      scope,
      key,
      thresholdMinutes,
      alertAfterMinutes: alertAfterMinutes ?? null,
      updatedBy: guard.principal.email,
    },
    update: { thresholdMinutes, alertAfterMinutes: alertAfterMinutes ?? null, updatedBy: guard.principal.email },
  })

  await audit(prisma, guard.principal, {
    action: 'IDLE_CONFIG_SET',
    entity: 'IdleConfig',
    entityId: `${scope}:${key}`,
    before: before
      ? { thresholdMinutes: before.thresholdMinutes, alertAfterMinutes: before.alertAfterMinutes }
      : undefined,
    after: { thresholdMinutes, alertAfterMinutes: alertAfterMinutes ?? null },
  })

  return NextResponse.json(saved)
}

/** DELETE /api/idle-config?scope=&key= — remove an override, falling back down the chain. */
export async function DELETE(request: Request): Promise<NextResponse> {
  const guard = await requirePermission('idle-policy:manage')
  if (!guard.ok) return guard.response

  const params = new URL(request.url).searchParams
  const scope = params.get('scope')
  const key = params.get('key')

  if (!scope || !key || !['CLASS', 'SUB_TYPE', 'ASSET'].includes(scope)) {
    return NextResponse.json({ error: 'scope and key are required' }, { status: 400 })
  }

  const deleted = await prisma.idleConfig.deleteMany({ where: { scope: scope as never, key } })
  if (deleted.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await audit(prisma, guard.principal, {
    action: 'IDLE_CONFIG_CLEAR',
    entity: 'IdleConfig',
    entityId: `${scope}:${key}`,
    before: { existed: true },
    after: { existed: false },
  })

  return NextResponse.json({ cleared: deleted.count })
}

/**
 * Check a key actually refers to something.
 *
 * A sub-type typo resolving to "no config" is tolerable at read time (ADR-0014: the fallback
 * is the class default). But saving one is a silent no-op the user believes worked, so it is
 * caught here where they can still fix it.
 */
async function validateKey(scope: 'CLASS' | 'SUB_TYPE' | 'ASSET', key: string): Promise<string | null> {
  if (scope === 'CLASS') {
    return (CLASSES as readonly string[]).includes(key) ? null : `Unknown asset class "${key}"`
  }

  if (scope === 'ASSET') {
    const asset = await prisma.asset.findUnique({ where: { id: key }, select: { id: true } })
    return asset ? null : 'Unknown asset'
  }

  const [assetClass, subType] = key.split(':')
  if (!assetClass || !subType || !(CLASSES as readonly string[]).includes(assetClass)) {
    return 'Sub-type key must be "<CLASS>:<SubType>"'
  }

  const match = await prisma.asset.findFirst({
    where: { class: assetClass as never, subType },
    select: { id: true },
  })
  return match ? null : `No asset has class ${assetClass} and sub-type "${subType}"`
}
