# Collector — Phase 0 Inspection & Reconciliation

**Purpose.** Before writing a line of collector code, confirm or correct every PART-B fact
against the actual source, with `file:line` evidence. Later phases are adapted to the
**confirmed** reality recorded here, not to the brief's assumptions. Nothing in the repo was
changed to produce this document (Phase 0 is read-only).

Date: 2026-07-20 · Branch: `feat/collector-phase0-inspect`

---

## Method

Read the source directly (not the compiled `dist/`), grepped for the named symbols, and
followed each call path end to end. Where the brief's description and the code disagree, the
code wins and the drift is called out under **Drift** below.

---

## Fact-by-fact confirmation

### 1. Packages layout — **CONFIRMED (with one correction)**

`pnpm-workspace.yaml:1-3` globs `app` and `packages/*`. Actual packages
(`ls packages/`): `auth, connectors, core, db, jobs, sap, seed`.

- **Correction to the brief's mental model:** there is **no `apps/` directory** — the Next.js
  app is a single top-level `app/` (`app/src/app/...`), not `apps/web`. CLAUDE.md's "Layout"
  section says `app/` and that is what exists. A collector placed at `apps/collector` would be
  outside the workspace globs; it must go under `packages/*` (or the globs must be widened).
  **Decision deferred to ADR (Phase 1):** `packages/collector`, matching the existing glob and
  the workspace's package-per-concern convention.

### 2. Connector adapters — **CONFIRMED**

`packages/connectors/src/`: `scan.ts`, `soti.ts` (+ `soti-mock.ts`), `osquery.ts`, `snmp.ts`,
`lis.ts`, plus `pipeline.ts`, `types.ts`, `coverage.ts`, `index.ts`. Five adapters as CLAUDE.md
states; `lis` is a documented stub (`PROGRESS.md`, C4).

The `Connector` contract (`packages/connectors/src/types.ts:12-31`):

```ts
readonly id: SignalSource
readonly pollIntervalMinutes: number
poll?(): Promise<RawSignal[]>
ingest?(payload: unknown): Promise<RawSignal[]>
normalise(raw: RawSignal, assetId: string): SignalInput
```

**Key finding for reuse:** `normalise(raw, assetId)` uses `assetId` **only to copy it into the
returned `SignalInput`** — every `type`/`value`/`observedAt`/`dedupeKey` field is derived from
`raw` alone. Verified in all adapters, e.g. `snmp.ts:110-146`, `osquery.ts:128-142`. This is the
seam the collector splits on: the collector can run `poll()` + `normalise()` locally (holding the
SNMP page-count baseline, `snmp.ts:78-82`) and push a **normalised-but-unresolved** signal; OAT
attaches the real `assetId` via `resolveAssetByRef` and ingests. No adapter needs a real
`assetId` to normalise, so this reuse requires **no change to the `Connector` interface**.

### 3. `pipeline.ts` — `resolveAssetByRef` + never-create invariant — **CONFIRMED (line corrected)**

- The never-create invariant is in `packages/connectors/src/pipeline.ts:40-47`, not "~line 40 of
  a `resolveAssetByRef`": an unmatched `externalRef` is pushed to `unmatched[]` and `continue`d —
  **no asset is created** (`pipeline.ts:41-46`). Comment: _"Report it rather than creating an
  asset … Reconciliation is a human decision."_
- `resolveAssetByRef` itself lives in **`packages/core/src/registry.ts:294-300`** (not in
  `pipeline.ts`). It matches `tag` OR `sapAssetNo` and returns `id | null`. `pipeline.ts` imports
  it from `@oat/core` (`pipeline.ts:1`).
- ADR-0009 is `docs/decisions/0009-sap-matching-precedence-and-reconciliation-queue.md`.

**Drift — important for Phase 4:** the connector pipeline's `unmatched` list is **reported in the
return value only; it is NOT written to the `ReconciliationItem` table.** That table
(`packages/db/prisma/schema.prisma:197-221`) is keyed `sapAssetNo @unique` and is populated by
**SAP sync**, with reasons `NO_MATCH | UNKNOWN_COST_CENTRE | CONFLICTING_LINK`
(`schema.prisma:223-230`) — all SAP-origin. So "unmatched → reconciliation" is today true for
**SAP records** but, for **signals**, means "returned as `unmatched`, never written to the
register." Phase 4 must decide (in the ADR) whether a collector's unmatched _signal_ ref should
also surface a reconciliation artefact; the safe invariant ("never creates an asset") already
holds either way. See Phase 1 ADR.

### 4. Scheduler in `packages/jobs` — **CONFIRMED**

`packages/jobs/src/scheduler.ts` wires pg-boss once (ADR-0020) for connector polls, the idle
sweep, and the nightly rollup (`scheduler.ts:15-49`). It calls `pollConnector(prisma, connector)`
(`scheduler.ts:1`) with connectors resolved by `packages/jobs/src/connectors.ts`
(`snmpConnector()`, `osqueryConnector()`, `sotiConnector()`). The worker has **direct Prisma
access** — it is _inside_ the trust boundary. The collector will **not**; that is the whole point.

`packages/jobs/src/demo-poll-snmp.ts` already exists (`pnpm demo:poll-snmp`): a one-shot double
poll of a real SNMP agent proving a page-count delta → `utilisation busy:true`. It reuses
`snmpConnector()` + `pollConnector()` — the production path, not a fake. This is a strong
template for the collector's SNMP module.

### 5. Ingest endpoints + `requireServiceToken` — **CONFIRMED**

- `requireServiceToken(request)` — `app/src/lib/api-auth.ts:51-69`. **Fails closed:** unset
  `OAT_SERVICE_TOKEN` → `503` (`api-auth.ts:52-58`); wrong token → `401`
  (`api-auth.ts:64-66`) via a constant-time compare (`api-auth.ts:76-84`). This is the machine-
  caller guard; the human guard is `requirePermission` (`api-auth.ts:26-39`, session + RBAC).
- Existing machine endpoints using it: `api/admin/rollup`, `api/admin/sweep`,
  `api/connectors/soti/poll` (all `route.ts`). `api/signals/scan` uses `requirePermission`
  (human scan). Full API tree confirmed under `app/src/app/api/` (13 route files).
- **Template for the collector ingest endpoint:** `app/src/app/api/connectors/soti/poll/route.ts`
  — service-token guard → parse body with zod → run the shared pipeline → JSON result. The
  collector endpoint follows this shape but authenticates a **per-collector bearer** (Phase 1/4)
  rather than the single shared `OAT_SERVICE_TOKEN`.

### 6. Env flags — **CONFIRMED**

`resolveConnectorFlags()` (`types.ts:60-71`) reads `OAT_CONNECTOR_{SCAN,SOTI,OSQUERY,SNMP,LIS}`;
defaults all off except `scan` (`types.ts:44-52`). SNMP targets:
`OAT_SNMP_TARGETS="TAG@host[:port],..."` + `OAT_SNMP_COMMUNITY` (`snmp.ts:224-254`,
`.env.example:65-70`). Fleet: `OAT_FLEET_BASE_URL` + `OAT_FLEET_API_TOKEN` +
`OAT_FLEET_QUERY_NAME` (`osquery.ts:186-199`, `.env.example:61-63`). `OAT_SERVICE_TOKEN`
(`.env.example:34`). All config is env-only; no secrets in git (`.env` is gitignored; `.env.example`
holds only placeholders).

### 7. CI checks incl. licence gate — **CONFIRMED**

`.github/workflows/ci.yml`: job `static` runs lint → format:check → typecheck → **`pnpm licences`**
(`scripts/check-licences.mjs`, ADR-0003) → sbom; job `test` runs `pnpm test` **with a real
`polinux/snmpd` service** on UDP 1161 (`ci.yml:64-89`); job `e2e` builds + runs Playwright against
real Postgres; job `docker` builds `infra/Dockerfile`. The licence gate uses `pnpm licenses`,
allows permissive SPDX only, and **asserts a non-zero package count** so a mis-scoped scan cannot
pass vacuously (`check-licences.mjs:14-19`). Anything the collector ships must stay inside the
`ALLOWED` set (`check-licences.mjs:24-41`).

### 8. Existing SNMP demo infra — **CONFIRMED (a major head-start)**

`infra/docker-compose.yml` already runs `postgres + app + worker + snmpsim`. `snmpsim`
(`infra/snmpsim/Dockerfile`, BSD-2-Clause `snmpsim-lextudio==1.1.1`) serves a Printer-MIB page
counter that **rises with time** (`infra/snmpsim/data/public.snmprec:20-23`, `rate=10`). The
`worker` polls it as `LAB-0005@snmpsim:161`, a **seeded `PRINTER` asset**
(`packages/seed/src/seed.ts:81-83`). `docs/DEMO.md` documents the current SNMP live-signal demo.
The collector demo (Phase 5) will **reuse `snmpsim` unchanged** and replace the DB-attached
`worker` poll with a **collector that pushes outbound to the app**, proving the on-LAN topology.

---

## Signal & type facts (for the outbound payload design)

- `SignalInput` (`packages/core/src/signals.ts:49-58`): `{ assetId, source, type, value,
observedAt, dedupeKey? }`. `RawSignal` (`signals.ts:60-64`): `{ externalRef, observedAt,
payload }`.
- `SignalSource` is a **zod enum**, not a DB enum: `scan|soti|osquery|ocs|snmp|lis`
  (`signals.ts:11`). Adding a source needs no migration. The collector emits only existing
  sources (`snmp`, `osquery`); the **subnet sweep produces identity hints, not `SignalEvent`s**,
  so it needs no new source.
- `ingestSignals` (`registry.ts:39-74`) dedupes on `(source, dedupeKey)` via
  `createMany({ skipDuplicates: true })` — at-least-once delivery is safe, which the outbound
  channel relies on for retries.

---

## Confirmed drift / corrections summary

| #   | Brief said                                    | Reality                                                                                            | Adaptation                                                                                                  |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A   | `apps/collector` an option                    | No `apps/`; workspace globs `packages/*` + `app`                                                   | Use `packages/collector` (ADR Phase 1)                                                                      |
| B   | ADRs in `docs/adr/`                           | Repo uses **`docs/decisions/NNNN-*.md`**, next # = **0021**                                        | Put the new ADR in `docs/decisions/` to match convention; note the brief's `docs/adr/` path                 |
| C   | `resolveAssetByRef` ~line 40 of `pipeline.ts` | It's in `core/registry.ts:294`; `pipeline.ts:40` is the never-create branch                        | Cite both correctly                                                                                         |
| D   | "unmatched → reconciliation"                  | Connector unmatched is **reported, not written** to `ReconciliationItem` (that table is SAP-keyed) | Phase 4/ADR decides whether to persist a signal-side reconciliation artefact; never-create holds regardless |

## Confirmed assumptions (carried into later phases)

1. The collector reuses `@oat/connectors` adapters (`poll` + `normalise`) with **no interface
   change**, splitting at the resolve seam; it never imports `@oat/db`.
2. Outbound-only = collector **POSTs** normalised-but-unresolved signals to a new OAT endpoint;
   no inbound path to the collector.
3. Auth starts from the `requireServiceToken` fail-closed model, extended to a per-collector
   bearer (Phase 1 ADR).
4. The demo reuses `infra/snmpsim` and seeded `LAB-0005`, changing only the topology
   (collector-pushes vs worker-writes).

---

## GATE 0

- [x] Inspection written against real source with `file:line` evidence.
- [x] Every PART-B fact confirmed or corrected; drift listed explicitly (A–D).
- [x] Later phases adapted to confirmed reality (package location, ADR dir, reuse seam,
      reconciliation nuance).
- [x] **No repository files changed** other than this new document.
