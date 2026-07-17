import { requirePermission } from '@/lib/page-auth'
import { scopeToSite } from '@oat/auth'
import { getAsset, resolveIdlePolicy, type IdleConfigOverride } from '@oat/core'
import { prisma } from '@oat/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { StatusBadge } from '@/components/status-badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatAssetClass, formatDateTime, formatDuration, minutesSince } from '@/lib/format'

export const dynamic = 'force-dynamic'

export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const principal = await requirePermission('asset:read', `/assets/${id}`)

  const asset = await getAsset(prisma, id)
  if (!asset) notFound()

  // A scoped user must not read another site's asset by knowing its id. 404, not 403 —
  // confirming the id exists would leak that another site holds it.
  const scope = scopeToSite(principal)
  if (scope.kind === 'none' || (scope.kind === 'site' && scope.siteId !== asset.siteId)) notFound()

  const now = new Date()
  const idleFor = asset.status === 'IDLE' ? minutesSince(asset.idleSince, now) : null
  const attributes = (asset.attributes ?? {}) as Record<string, unknown>

  // Which level of the chain actually applied (ADR-0014/0019). Shown because a sub-type
  // typo's only symptom is a silent fall back to the class default — the number looks
  // perfectly reasonable, and nobody can tell it is not the one they configured.
  const overrides = (await prisma.idleConfig.findMany({
    select: { scope: true, key: true, thresholdMinutes: true, alertAfterMinutes: true },
  })) as IdleConfigOverride[]
  const policy = resolveIdlePolicy(asset, overrides)

  return (
    <div className="space-y-8">
      <div>
        <Link href="/assets" className="text-sm text-muted-foreground hover:underline">
          ← Assets
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{asset.name}</h1>
          <StatusBadge status={asset.status} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {asset.tag} · {asset.site.code} {asset.site.name}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Operational</CardTitle>
            <CardDescription>Derived from connector signals by the idle engine.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Field label="Status" value={<StatusBadge status={asset.status} />} />
              <Field label="Idle for" value={idleFor === null ? '—' : formatDuration(idleFor)} testId="idle-for" />
              <Field label="Idle since" value={formatDateTime(asset.idleSince)} />
              <Field label="Last seen" value={formatDateTime(asset.lastSeenAt)} />
              <Field label="Last active" value={formatDateTime(asset.lastActiveAt)} />
              <Field label="Location" value={asset.location ?? '—'} testId="location" />
              <Field label="Custodian" value={asset.custodianId ?? '—'} />
              <Field
                label="Class"
                value={
                  <>
                    {formatAssetClass(asset.class)}
                    {asset.subType ? (
                      <span data-testid="sub-type" className="text-muted-foreground">
                        {' · '}
                        {asset.subType}
                      </span>
                    ) : null}
                  </>
                }
              />
              <Field
                label="Idle after"
                testId="idle-threshold"
                value={
                  <>
                    <span className="tabular-nums">{formatDuration(policy.thresholdMinutes)}</span>{' '}
                    <span
                      data-testid="idle-threshold-source"
                      className={`text-xs ${
                        policy.thresholdSource === 'default'
                          ? 'italic text-amber-700 dark:text-amber-400'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {POLICY_SOURCE_LABEL[policy.thresholdSource]}
                    </span>
                  </>
                }
              />
              <Field
                label="Activity comes from"
                value={
                  <span className="text-muted-foreground">
                    {/* Why an instrument shows no utilisation: nothing feeds it yet. */}
                    {policy.activitySources === '*'
                      ? 'any connector'
                      : policy.activitySources.length === 0
                        ? 'scan only'
                        : policy.activitySources.join(', ')}
                  </span>
                }
              />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Financial</CardTitle>
            {/* The boundary, made visible in the product itself, not just in the code. */}
            <CardDescription>Held in SAP FI-AA. Shown for reference; the OAT never edits it.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-y-4">
              <Field
                label="SAP asset no."
                testId="sap-asset-no"
                value={asset.sapAssetNo ?? <span className="italic text-muted-foreground">not linked</span>}
              />
              <Field label="Serial" value={str(attributes.serial)} />
              <Field label="Manufacturer" value={str(attributes.manufacturer)} />
              <Field label="Capitalised on" value={str(attributes.capitalisedOn)} />
            </dl>
          </CardContent>
        </Card>
      </div>

      {/* FUNCTIONAL, NOT FINAL — presentation is provisional (ADR-0021). The data and the
          scoping are final; the markup will be restyled by the design system. */}
      <Card>
        <CardHeader>
          <CardTitle>Location history</CardTitle>
          <CardDescription>
            Where this asset has been, and who moved it. Append-only — a move is never edited, only added to.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Moved</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {asset.locations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                    No recorded moves. Location is captured when someone scans the asset somewhere new.
                  </TableCell>
                </TableRow>
              ) : (
                asset.locations.map((move) => (
                  <TableRow key={move.id} data-testid="location-row">
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(move.movedAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{move.from ?? '—'}</TableCell>
                    <TableCell className="font-medium">{move.to}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{move.source}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent signals</CardTitle>
          <CardDescription>
            The immutable observations behind the status above. Observed is when it happened; ingested is when we heard.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Observed</TableHead>
                <TableHead>Ingested</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {asset.signals.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    No signals yet. This asset is tracked by scan and manual update only.
                  </TableCell>
                </TableRow>
              ) : (
                asset.signals.map((signal) => (
                  <TableRow key={signal.id} data-testid="signal-row">
                    <TableCell className="font-medium">{signal.source}</TableCell>
                    <TableCell>{signal.type}</TableCell>
                    <TableCell className="max-w-64 truncate font-mono text-xs text-muted-foreground">
                      {JSON.stringify(signal.value)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(signal.observedAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(signal.ingestedAt)}
                    </TableCell>
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

/**
 * Where a resolved threshold came from.
 *
 * "from the class default" when the user expected "from this sub-type" is the ONLY visible
 * symptom of a mistyped sub-type — the number itself looks entirely reasonable.
 */
const POLICY_SOURCE_LABEL: Record<string, string> = {
  asset: 'set on this asset',
  'sub-type': `set for this sub-type`,
  class: 'set for this class',
  default: 'provisional default',
}

function str(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '—'
}

function Field({ label, value, testId }: { label: string; value: React.ReactNode; testId?: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="mt-1 text-sm">
        {value}
      </dd>
    </div>
  )
}
