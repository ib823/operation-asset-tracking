# PROGRESS — Lablink OAT

Living log. Update after every milestone. Read with `CLAUDE.md` at session start.

## Current phase

**Phase 0 — PoC: COMPLETE.** All acceptance criteria met and verified (see below).
Awaiting the phase gate; Phase 1 is next.

## Task list

### Bootstrap — done

- [x] `CLAUDE.md` standing brief
- [x] `PROGRESS.md` living log
- [x] `docs/decisions/` + ADRs 0001–0007
- [x] Task list (this section)

### Phase 0 — PoC — done

- [x] pnpm monorepo + TypeScript project references
- [x] `packages/db`: Prisma schema, init migration, seed 3 sites + 10 assets
- [x] `packages/core`: signal vocabulary, per-class idle policy, idle engine, registry, dashboard
- [x] `packages/sap`: typed boundary contract + mock client + idempotent master sync + write-back
- [x] `packages/connectors`: `scan` adapter (fallback floor) + mock `soti` adapter + ingest pipeline
- [x] `app`: asset list, asset detail with status badge, idle-vs-in-use-by-site dashboard tile
- [x] REST API + OpenAPI document (`docs/openapi.yaml`)
- [x] Vitest unit tests (45)
- [x] Playwright e2e proving the end-to-end flow (10)
- [x] `infra/`: docker-compose (app + postgres), Dockerfile, entrypoint, `.env.example`
- [x] `.devcontainer` so a Codespace boots ready
- [x] CI: lint, format, typecheck, unit tests, licence gate, SBOM, e2e, docker build
- [x] Self-verify against Phase 0 acceptance criteria

### Phase 1 — Core register + SAP link — not started

- [ ] Full Asset model: RFP 2.6.3/2.6.7 attributes (OEM, serial, warranty, calibration/licence)
- [ ] `packages/auth`: Auth.js + RBAC, roles per RFP Appendix F (Finance, Purchasing, Branch,
      HQ Lab Manager, IT, Developer), with a clean seam to OIDC/SAML (SAP IAS)
- [ ] Replace the interim bearer token (`app/src/lib/api-auth.ts`) with session + role checks
- [ ] Scheduled master sync via pg-boss (currently a manual endpoint)
- [ ] SAP event write-back behind a real approval workflow (contract + sink exist; no UI yet)
- [ ] Barcode/manual location + assignment updates in the UI (API exists; no UI form yet)
- [ ] `LocationHistory` written on location change (model exists; not yet populated)
- [ ] Audit log surfaced in the UI
- [ ] UAT script

### Phases 2–4 — not started

Do not scaffold early — see `CLAUDE.md` phase plan.

## Done

- Bootstrap docs, ADRs 0001–0007.
- Phase 0 vertical slice, verified end to end (results below).
- Licence gate built and proven in both directions; it caught a real LGPL dependency on its
  first run (ADR-0007).

## Next

1. **Phase gate review** — see the summary posted at the end of the Phase 0 session.
2. Begin Phase 1 with `packages/auth`: Auth.js + RBAC per RFP Appendix F. This is the
   highest-value next step because the interim bearer token in `app/src/lib/api-auth.ts` is
   the one knowingly weak thing in the build, and every Phase 1 mutation needs an actor for
   the audit trail anyway.
3. Then: pg-boss scheduling for the sync and the idle sweep, both currently manual endpoints.

## Assumptions to confirm

| #   | Assumption                                                                                                                                                        | Made because                                                | How it's isolated                                                                                                                                                                                       | Confirm with           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A1  | Idle thresholds default to: LAB_INSTRUMENT 120 min, IT 30 min, PRINTER 240 min, SCANNER 240 min, REUSABLE_COMPONENT 480 min, OTHER 120 min.                       | Client has not defined "idle" per class.                    | Config-driven (`packages/core/src/idle-policy.ts`); overridable per class without code change. Because signals are an append-only log (ADR-0006), changing these later is a recompute, not a migration. | Lablink HQ Lab Manager |
| A2  | SAP asset master is exposed via a released OData service; field names and asset-class codes in the mock are placeholders.                                         | No tenant, endpoint, or credentials provided.               | Typed ports + mock (`packages/sap`); the real client is a config swap via `OAT_SAP_CLIENT`.                                                                                                             | Lablink SAP team       |
| A3  | 32 sites; Phase 0 seeds 3 representative ones (KL01, PJ02, JB03).                                                                                                 | Real site list not supplied.                                | Seed data only; `Site` is a first-class table keyed by `code`.                                                                                                                                          | Lablink ops            |
| A4  | Asset tags are barcode/QR encoding `tag` directly (no check-digit scheme).                                                                                        | No tagging standard supplied.                               | Scan connector normalises in one place (`packages/connectors/src/scan.ts`).                                                                                                                             | Lablink ops            |
| A5  | Data residency: deploy to a Malaysia region. Not yet chosen (AWS ap-southeast-5 / Azure Malaysia West).                                                           | No hosting decision yet.                                    | Docker-based; region is a deploy-time choice.                                                                                                                                                           | ABeam + Lablink IT     |
| A6  | Single tenant, single timezone (Asia/Kuala_Lumpur) for display and rollups.                                                                                       | One Malaysian entity.                                       | `TIMEZONE` in `app/src/lib/format.ts`.                                                                                                                                                                  | Lablink ops            |
| A7  | SAP cost centre maps 1:1 to an OAT site, matched on site `code`.                                                                                                  | Cost centre is the only site signal SAP offers.             | `syncAssetMaster` reports unmapped cost centres in `skipped` rather than guessing.                                                                                                                      | Lablink SAP team + ops |
| A8  | An asset may be tagged and operational before finance capitalises it, so the master sync falls back to matching on **serial number** when `sapAssetNo` is absent. | Otherwise assets tagged on arrival could never link to SAP. | `findMatch` in `packages/sap/src/master-sync.ts`; only ever adopts an unlinked asset.                                                                                                                   | Lablink finance + ops  |
| A9  | SAP deactivation is authoritative for RETIRED, but SAP must not otherwise dictate operational status.                                                             | SAP cannot know whether a machine is idle or under repair.  | `syncAssetMaster` only writes `status` when `deactivated`.                                                                                                                                              | Lablink finance        |

## Blocked / needed from the client

Nothing is blocking. Every unknown above is behind a mock or a config value.

To move beyond mocks we will eventually need: an SAP tenant + released OData endpoint and
credentials (A2); a SOTI tenant (Phase 2); the real site and asset lists (A3); and the
client's definition of "idle" per asset class (A1).

## How to resume

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d postgres
cp .env.example .env            # then set OAT_API_TOKEN
pnpm db:deploy && pnpm db:seed
pnpm dev                        # http://localhost:3000
```

Or the whole stack, seeded, in one command: `docker compose -f infra/docker-compose.yml up`.

| Command                                              |                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm test`                                          | Unit tests — no database needed                                     |
| `pnpm e2e`                                           | End-to-end, against a production build (resets and re-seeds the DB) |
| `pnpm lint` · `pnpm typecheck` · `pnpm format:check` | Static checks                                                       |
| `pnpm licences`                                      | Licence gate                                                        |
| `pnpm sbom`                                          | Generate `sbom.json`                                                |

Then: read `CLAUDE.md` → this file → continue at **Next**.

## Verification results

Run 2026-07-16, Node 22, Postgres 16, on the Codespace.

| Check                                  | Result                                                         |
| -------------------------------------- | -------------------------------------------------------------- |
| `pnpm lint`                            | Pass — clean                                                   |
| `pnpm format:check`                    | Pass                                                           |
| `pnpm typecheck`                       | Pass                                                           |
| `pnpm test`                            | **45 passed** / 45 (4 files)                                   |
| `pnpm e2e`                             | **10 passed** / 10, against a production build + real Postgres |
| `pnpm licences`                        | Pass — 58 production packages, all permissive                  |
| `pnpm build`                           | Pass                                                           |
| `docker compose build app`             | Pass                                                           |
| `docker compose up` from empty volumes | Pass — healthy in ~7s, migrations applied, 10 assets seeded    |

### Phase 0 acceptance criteria

| Criterion                     | Evidence                                                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose up` works     | Verified from empty volumes: Postgres healthy → migrations applied → seeded → `/api/health` 200 in ~7s.                                                                                         |
| CI green                      | Every CI step run locally and passing. **Not yet observed on GitHub Actions** — see caveat below.                                                                                               |
| Slice demonstrated end-to-end | 10 Playwright tests: seed → SAP sync links `sapAssetNo` → SOTI idle signal → engine flips IN_USE→IDLE with correct `idleSince` → dashboard tile. Also driven by hand against the compose stack. |
| ADRs + PROGRESS.md written    | ADRs 0001–0007; this file.                                                                                                                                                                      |

### Verified by deliberate falsification, not just green ticks

- **The licence gate rejects, it does not merely pass.** Fed a synthetic tree, it correctly
  failed LGPL-3.0, GPL-3.0, `MIT AND GPL-3.0`, and an undeclared licence, while correctly
  allowing `MIT OR GPL-2.0` (we may elect MIT). It also aborts rather than reporting a pass
  if it scans an implausibly small tree — the first draft silently "passed" over **0**
  packages, because a generic node_modules walker cannot see pnpm's layout. A gate that
  passes while inspecting nothing is worse than no gate.
- **The SAP boundary guard is load-bearing.** Widening `SapOutboundEvent` to admit a
  `UTILISATION` member makes `packages/sap/src/contract.test.ts` fail typecheck
  (`TS2578: Unused '@ts-expect-error' directive`). Confirmed by doing it and reverting.
- **The idle engine holds under adversarial input.** Out-of-order and late signals, replayed
  batches, malformed payloads, telemetry fighting an administrative status, and the
  no-connector case are each covered by a test.

### Known caveats

1. **CI has never actually run on GitHub Actions.** Every step passes locally, but the
   workflow file itself is unexercised. First push may need a fix.
2. **`app/src/lib/api-auth.ts` is a shared bearer token, not authentication.** It fails
   closed (503 when unset, 401 on mismatch) and is a deliberate seam, but it is the one
   knowingly weak thing in the build. Phase 1 replaces it.
3. **The sync and idle sweep are manual endpoints.** pg-boss is chosen (ADR-0005) but not
   yet wired; scheduling is Phase 1.
4. **`UtilisationSnapshot` and `LocationHistory` are modelled but not yet populated.**
   Rollups are Phase 2; location history is Phase 1.
5. **`REPROJECTION_WINDOW_MS` is a 7-day window.** A signal older than that arriving late
   would be persisted but not affect the projection. Fine at current volumes; revisit with
   the retention policy in Phase 4.
6. **A shared-`docker-compose.yml` devcontainer.** The `.devcontainer` attaches to the
   `postgres` service; verified by config review, not by a Codespace rebuild.
