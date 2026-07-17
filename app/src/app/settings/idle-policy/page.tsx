import { can } from '@oat/auth'
import { DEFAULT_IDLE_POLICY, resolveIdlePolicy, type IdleConfigOverride } from '@oat/core'
import { prisma } from '@oat/db'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatAssetClass, formatDuration } from '@/lib/format'
import { requirePermission } from '@/lib/page-auth'
import { ThresholdForm } from './threshold-form'

export const dynamic = 'force-dynamic'

const CLASSES = ['LAB_INSTRUMENT', 'IT', 'PRINTER', 'SCANNER', 'REUSABLE_COMPONENT', 'OTHER'] as const

const SOURCE_LABEL: Record<string, string> = {
  default: 'built-in default',
  class: 'set for this class',
  'sub-type': 'set for a sub-type',
  asset: 'set on the asset',
}

export default async function IdlePolicyPage() {
  const principal = await requirePermission('utilisation:read', '/settings/idle-policy')
  const canManage = can(principal, 'idle-policy:manage')

  const overrides = (await prisma.idleConfig.findMany({
    orderBy: [{ scope: 'asc' }, { key: 'asc' }],
  })) as unknown as IdleConfigOverride[]

  const rows = CLASSES.map((assetClass) => {
    const resolved = resolveIdlePolicy({ id: '', class: assetClass, subType: null }, overrides)
    return { assetClass, resolved, isDefault: resolved.thresholdSource === 'default' }
  })

  const subTypeRows = overrides.filter((o) => o.scope === 'SUB_TYPE')

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Idle policy</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          What counts as idle, per asset class. Values resolve most-specific-first: an asset override beats a sub-type,
          which beats the class, which falls back to the built-in default.
        </p>
      </div>

      {/* The provisional-numbers warning, stated where the numbers are — not buried in a doc.
          A placeholder nobody flags becomes a client-approved figure by accident. */}
      <div
        role="note"
        className="rounded-lg border border-amber-500/30 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      >
        <strong className="font-medium">The built-in defaults are provisional.</strong> They are ABeam&rsquo;s
        engineering judgement, not Lablink&rsquo;s operational answer, and no test can validate them. Confirm them with
        the HQ Lab Manager and set them here. Changing a threshold re-derives history rather than losing it.
      </div>

      <Card>
        <CardHeader>
          <CardTitle>By asset class</CardTitle>
          <CardDescription>
            Every value shows where it came from — a number whose origin you cannot see is a number nobody trusts.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Class</TableHead>
                <TableHead>Idle after</TableHead>
                <TableHead>Alert after</TableHead>
                <TableHead>Activity comes from</TableHead>
                {canManage ? <TableHead className="w-72">Set</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ assetClass, resolved, isDefault }) => (
                <TableRow key={assetClass} data-testid="idle-policy-row" data-class={assetClass}>
                  <TableCell className="font-medium">{formatAssetClass(assetClass)}</TableCell>

                  <TableCell>
                    <span data-testid="threshold" className="tabular-nums">
                      {formatDuration(resolved.thresholdMinutes)}
                    </span>
                    <span
                      data-testid="threshold-source"
                      className={`ml-2 text-xs ${isDefault ? 'italic text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
                    >
                      {isDefault ? 'provisional default' : SOURCE_LABEL[resolved.thresholdSource]}
                    </span>
                  </TableCell>

                  <TableCell className="tabular-nums text-muted-foreground">
                    {formatDuration(resolved.alertAfterMinutes)}
                  </TableCell>

                  <TableCell className="text-sm text-muted-foreground">
                    {/* Why an instrument reports no utilisation: nothing feeds it yet. Not
                        overridable — it is the rule that keeps utilisation honest. */}
                    {resolved.activitySources === '*'
                      ? 'any connector'
                      : resolved.activitySources.length === 0
                        ? 'scan only — never auto-idles'
                        : resolved.activitySources.join(', ')}
                  </TableCell>

                  {canManage ? (
                    <TableCell>
                      <ThresholdForm
                        scope="CLASS"
                        configKey={assetClass}
                        current={resolved.thresholdMinutes}
                        isDefault={isDefault}
                        defaultMinutes={DEFAULT_IDLE_POLICY[assetClass].thresholdMinutes}
                      />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sub-type and asset overrides</CardTitle>
          <CardDescription>
            For where a class is too coarse — an analyser and a microscope are both lab instruments and are not the same
            question. Set from an asset&rsquo;s own page.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scope</TableHead>
                <TableHead>Applies to</TableHead>
                <TableHead>Idle after</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subTypeRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                    No overrides. Every asset follows its class — which is the right place to start.
                  </TableCell>
                </TableRow>
              ) : (
                subTypeRows.map((row) => (
                  <TableRow key={`${row.scope}:${row.key}`} data-testid="subtype-override-row">
                    <TableCell className="text-sm">Sub-type</TableCell>
                    <TableCell className="font-medium">{row.key.replace(':', ' · ')}</TableCell>
                    <TableCell className="tabular-nums">{formatDuration(row.thresholdMinutes)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
