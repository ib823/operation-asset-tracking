# 21. The on-LAN Collector — an outbound-only MID-Server-equivalent

Date: 2026-07-20
Status: Accepted

Relates to ADR-0002 (module boundaries), ADR-0004 (SAP boundary), ADR-0006 (signals are an
append-only log), ADR-0009 (never create an asset; reconciliation), ADR-0015 (observed time),
ADR-0016 (fail-closed auth), ADR-0020 (the scheduler is its own process). Introduces no new
rule about _what a signal means_ — it only changes _where_ collection runs.

> The brief filed this under `docs/adr/`. This repo's ADRs live in `docs/decisions/` (ADR-0001).
> Kept here to match the established convention; the number continues the sequence (0021).

## Context

OAT's connectors assume the thing they poll is reachable from wherever the connector runs.
Through Phase 3 that "wherever" was the cloud worker (`packages/jobs`), which has **direct
Prisma access** and sits inside the trust boundary. That is fine for SOTI and Fleet — SaaS
control planes reachable from the cloud — but it is wrong for the two sources that only exist
**inside a customer site's LAN**:

- **SNMP** printers/instruments answer UDP/161 on a private subnet. A cloud worker cannot reach
  `10.x` printers behind the customer firewall, and opening inbound holes to 32 sites so it
  could is exactly the network posture a hospital IT team will (correctly) refuse.
- **osquery via Fleet** and a **subnet sweep** are likewise LAN-local discovery.

ServiceNow solved this a long time ago with the **MID Server**: a small agent that runs _inside_
the customer network, reaches local devices, and talks **outbound-only** to the cloud instance.
This ADR adopts that shape for OAT. It is the piece that makes discovery real end-to-end: a real
device on a real LAN → a real signal → real utilisation on a known asset.

The hard constraint is that the collector must gain us reach **without** gaining us a second way
to violate any existing invariant. A component that runs on customer hardware, outside our
direct control, must be _less_ privileged than the cloud worker, not more.

## Decision

### 1. Deployment shape — `packages/collector`, container + laptop

A new workspace package `packages/collector` (the workspace globs `packages/*`; there is no
`apps/` dir — see `docs/collector/INSPECTION.md` §1). It builds two ways:

- **Container** — an Alpine image (`packages/collector/Dockerfile`, non-root,
  `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, consistent with `infra/Dockerfile`) a site drops onto any
  Docker host on the LAN.
- **Laptop** — `pnpm --filter @oat/collector start`, for a technician on-site with a laptop and
  no container host. Same code, same env config.

It is a **long-running process** (like the scheduler, ADR-0020), not a Next route: it holds the
SNMP page-count baseline in memory across polls (`snmp.ts:78`), and it owns its own clock.

### 2. Channel — outbound-only HTTPS push, on a schedule (v1)

```
customer LAN                                   cloud
┌───────────────────────────┐                 ┌────────────────────────────┐
│ collector                 │   HTTPS POST     │ OAT app                    │
│  poll() SNMP/sweep/Fleet  │ ───────────────▶ │ /api/collector/ingest      │
│  normalise() locally      │   (outbound      │  auth → resolveAssetByRef  │
│  buffer + retry           │    only)         │  → ingestSignals           │
└───────────────────────────┘                 └────────────────────────────┘
        no inbound path to the collector          IRE / reconciliation here
```

- **v1 is push, not pull.** The collector initiates every connection; OAT never connects _to_
  the collector. There is no inbound listener on the collector at all (not even for control),
  so a site firewall needs exactly one rule: _allow outbound 443 to the OAT host._ This is the
  MID-Server property that makes it deployable in a hospital network.
- **Why not a poll-from-cloud or a bidirectional queue in v1:** both need the cloud to reach or
  address the collector, which reintroduces the inbound exposure we are eliminating. A future
  ADR may add an outbound long-poll for cloud→collector _commands_ (still collector-initiated),
  but v1 needs none: everything the collector does is self-scheduled.
- **Delivery is at-least-once.** The collector buffers a poll's signals and retries on failure;
  `ingestSignals` already dedupes on `(source, dedupeKey)` (`registry.ts:47-58`), so a retry
  cannot double-count. A signal whose observation is older than the reprojection window is
  simply late, not wrong.

### 3. What crosses the wire — normalised-but-unresolved signals (the split)

The collector runs `connector.poll()` **and** `connector.normalise()` locally, then pushes a
**normalised-but-unresolved** signal: everything in `SignalInput` **except `assetId`**, plus the
`externalRef` the device reported.

```ts
// shared type (packages/connectors)
interface UnresolvedSignal {
  externalRef: string // tag/serial the device reported — NOT an OAT asset id
  source: SignalSource
  type: SignalType
  value: unknown
  observedAt: string // ISO; re-hydrated to Date server-side
  dedupeKey?: string
}
```

Why the split lands here, and not elsewhere:

- **The collector cannot resolve identity — by design.** `resolveAssetByRef` is a DB query
  (`registry.ts:294`). The collector has no DB and no `@oat/db` import. So it _cannot_ know an
  asset id, which means it structurally _cannot_ create one. The most dangerous invariant
  (never create an asset) is enforced by the collector simply lacking the capability.
- **Normalisation is stateful and belongs with the poller.** SNMP activity is a _delta_ against
  the previous page count, held in the connector instance (`snmp.ts:78-82`). The long-lived
  collector is the natural owner of that baseline; a stateless cloud endpoint re-deriving deltas
  across separate HTTP requests would be fragile (restarts/replicas lose the baseline
  mid-stream). Keeping `normalise` on the collector matches ServiceNow's split imperfectly on
  paper (their sensors run instance-side) but correctly in substance: **the delta is computed
  once, where the consecutive readings actually arrive.**
- **`normalise(raw, assetId)` already ignores `assetId` except to copy it through** (verified in
  every adapter, INSPECTION §2). So the collector can call the _exact same_ `normalise` with a
  placeholder id and drop it — **no change to the `Connector` interface, no fork, no adapter
  edit.** The shared library exposes two thin helpers over the existing pipeline:
  - `collectUnresolved(connector, raws) → UnresolvedSignal[]` (collector side), and
  - `ingestUnresolved(prisma, unresolved) → RunResult` (cloud side: resolve each `externalRef`,
    attach `assetId`, `ingestSignals`; unmatched reported exactly as `pipeline.ts:40` does today).

  Both are the same resolve→ingest logic `runConnector` already runs, factored so the network
  boundary can pass through its middle. **One implementation, two callers** — the same principle
  `app/src/lib/connectors.ts` already documents for the scheduler vs the manual endpoints.

### 4. Enrollment & auth — per-collector bearer, fail-closed

- Each collector carries an `OAT_COLLECTOR_TOKEN` (env only, never git/logs). The OAT ingest
  endpoint authenticates it with the **same fail-closed discipline as `requireServiceToken`**
  (`api-auth.ts:51-69`): unset server-side secret → `503`; wrong/missing token → `401`; the
  compare is constant-time (`api-auth.ts:76-84`). A collector also sends a `collectorId` so the
  audit trail attributes signals to _which_ site's collector, and so a single compromised token
  can be revoked without disturbing the others.
- **Per-collector, not the shared `OAT_SERVICE_TOKEN`.** The service token authorises the cloud
  worker's privileged endpoints (sweep, rollup). A collector on customer hardware must not be
  able to trigger those. It gets a **narrower** credential that authorises exactly one action:
  _submit signals for resolution._ Least privilege by construction — the collector token cannot
  run a sweep, cannot read the register, cannot write SAP.
- v1 provisions the token out-of-band (an operator sets the env var), mirroring how
  `OAT_SERVICE_TOKEN` is provisioned today. A future self-enrollment handshake (collector
  presents a one-time code, receives a scoped token) is a clean extension; it is not needed to
  make the channel safe, because the manual token is already scoped and fail-closed.

### 5. Modules — reuse, never fork

| Module               | Reuses                                                                          | Activity rule (unchanged)                                       | Never-create                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SNMP**             | `SnmpConnector` (`snmp.ts`) verbatim                                            | Rising `prtMarkerLifeCount` = busy; reachable ≠ busy (ADR-0008) | `externalRef` only; resolution is cloud-side                                                                                                                                                         |
| **subnet/ARP sweep** | new, small; **emits identity hints, not `SignalEvent`s**                        | n/a — a sweep is discovery, not utilisation                     | Produces a _list of candidate refs_; each still goes through `resolveAssetByRef`. A ref that matches nothing is reported, **never** written. A sweep cannot create an asset — it has no path to one. |
| **osquery/Fleet**    | `OsqueryConnector` (`osquery.ts`) verbatim, behind `OAT_FLEET_*`; mock fallback | OS-level user idle, never uptime (ADR-0008)                     | as SNMP                                                                                                                                                                                              |

The **subnet sweep is the one genuinely new collector concern**, and it is deliberately the
weakest: it does a bounded TCP-connect / ARP-style presence check across a configured CIDR to
surface _"something answers at 10.1.2.7, and here is the identity hint it advertises."_ That hint
is matched against the register like any other `externalRef`. It **cannot** and **must not**
create an asset, and it emits **no utilisation** — presence is not use. Its value is operational:
it turns "we think there are printers on this subnet" into a reconciliation worklist, without
ever touching the register unattended.

## How each non-negotiable invariant holds

1. **OAT never creates an asset from a signal.** The collector has no `@oat/db` and cannot
   resolve or mint an id; the cloud side reuses `pipeline.ts:40`'s never-create branch verbatim
   via `ingestUnresolved`. Unmatched refs are reported, not written. Enforced by _capability_,
   not just by check. A Phase-4 test asserts an unknown ref lands in reconciliation-reporting and
   the `Asset` table row-count is unchanged.
2. **SAP boundary sacred.** The collector imports `@oat/connectors` (+ its transitive `@oat/core`,
   `@oat/db` _types only_ for the shared helper — but the collector build must not pull the SAP
   package or a Prisma client). Telemetry flows collector → OAT operational layer only; there is
   no code path from the collector to `packages/sap`. The typed SAP contract (ADR-0004) is
   untouched, so the `@ts-expect-error` guards still fail the build if telemetry ever tries to
   reach a SAP write.
3. **Honesty model preserved.** The collector emits the _same_ signals the worker does — SNMP
   heartbeat vs utilisation by the _same_ delta rule; osquery idle never uptime. "Not measured"
   still means no snapshot (ADR-0015); a collector **outage** is _silence_, which the per-source
   coverage gap (ADR-0018) already reads as UNOBSERVED, never as idle. `activitySources` stays
   non-overridable (ADR-0014) — the collector cannot widen what counts as activity; it only
   _transports_ signals from sources that already qualify.
4. **Permissive licences only.** The collector adds **no new runtime dependency** (REFERENCES.md).
   It reuses `net-snmp` (MIT), `zod` (MIT), and Node built-ins. The licence gate stays green
   because there is nothing new to scan.
5. **Secrets from env only; outbound-only; least privilege.** `OAT_COLLECTOR_TOKEN` and target
   config come from env (never git/logs — the collector logs counts and refs, never the token or
   raw credentials). The channel is outbound-only (no inbound listener). The collector's
   credential authorises exactly one narrow action and nothing the worker can do.

## Security model (summary)

- **Blast radius of a stolen collector token:** the attacker can submit _signals_ for existing
  assets (at worst, noisy/false utilisation on assets they can already name) and can enumerate
  which refs resolve (a matched-vs-unmatched oracle). They **cannot** read the register, create
  assets, run sweeps/rollups, or touch SAP. Mitigations: per-collector token (revoke one, not
  all); `collectorId` in the audit trail; rate/lint on the endpoint; and — because a real tenant
  must never accept caller-supplied _raw device state as truth_ — the same asymmetry the SOTI
  poll endpoint already documents (`soti/poll/route.ts:12-19`) applies: the endpoint trusts the
  _transport_, and the honesty rules (delta detection, coverage gaps) still gate what a signal is
  allowed to _mean_.
- **Blast radius of a compromised collector host:** it sees the customer LAN it was placed on
  (that is its job) and one outbound credential. It holds no register data and no DB access.
- **Fail-closed everywhere:** unset server secret → `503`; bad token → `401`; unreachable OAT →
  the collector buffers and retries, it does not drop to some "open" mode.

## Consequences

- The collector is the deployable that makes SNMP/sweep/Fleet real on a customer LAN, at the cost
  of one new long-running process to operate (like the scheduler).
- The `collectUnresolved` / `ingestUnresolved` split is a small, reviewable factoring of the
  existing `runConnector`; the worker path is unchanged, so Phase 2's gate (zero test regression)
  is achievable.
- **Open question deferred to Phase 4 (recorded, not decided here):** whether an unmatched
  _signal_ ref should also create a lightweight reconciliation _artefact_ (today the connector
  pipeline only _reports_ unmatched; the `ReconciliationItem` table is SAP-keyed — INSPECTION §3,
  drift D). The safe invariant ("never create an asset") holds regardless; surfacing unmatched
  signal refs to operators is an enhancement, not a correctness fix, and will get its own note.
