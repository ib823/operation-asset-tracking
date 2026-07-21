# PROGRESS — Lablink OAT

Living log. Update after every milestone. Read with `CLAUDE.md` at session start.

## Current phase

**Phase 3 — Additional connectors: COMPLETE.** Awaiting the phase gate. Phase 4 next.

> **On-LAN Collector (add-on, ADR-0021).** A MID-Server-equivalent that runs inside a customer
> LAN, collects via SNMP/subnet-sweep/osquery(Fleet), and pushes **outbound-only** to OAT, where
> signals attach to known assets via the existing pipeline (never creating one). Built across its
> own phases 0–7 — see `docs/collector/PROGRESS.md`, `docs/collector/INSPECTION.md`,
> `docs/collector/DEMO.md`, `docs/decisions/0021-onlan-collector.md`, and `docs/PROD_READINESS.md`.
> Delivered in PR #7 (**merged** to `main`, CI green). It is an independent add-on and does not change the
> Phase 3 → 4 plan above.

> **Demo honesty (ADR-0022).** A live review found the seed wrote `status: IN_USE` as a literal,
> so never-observed assets showed a confident "In use" — a crack in the never-claim-what-we-
> haven't-measured ethos. Fixed: the seed now seeds real signals (scan / SOTI / SNMP) and the
> **engine** derives status, idle, alerts and the utilisation % — nothing hardcoded. Every asset
> is observation-backed (`lastSeenAt` never null); the demo shows idle + an open alert + a
> computed printer utilisation %, guarded by `e2e/phase4-demo-honesty.spec.ts`. Explicit
> `UNOBSERVED` status is logged as the rigorous next step (ADR-0022 §b).

> **Dev-container tools persist (ADR-0025).** `claude: not found` kept recurring after a
> Codespace Stop→Start resume (not only full rebuilds). Two gaps: the CLI installs ran in
> `postCreateCommand` (create/rebuild only, never resume), and `~/.npm-global/bin` was on PATH
> only via `remoteEnv` (VS Code terminals only — not `/bin/sh -l` or `gh cs ssh`). Fixed:
> installs moved to `.devcontainer/ensure-tools.sh` (idempotent, non-fatal), run from a new
> `postStartCommand` so they self-heal on **every** start, and the script writes the PATH export
> into `~/.profile` and `~/.bashrc` so every shell resolves the CLIs. Verified: after a rebuild,
> a resume, and a fresh `/bin/sh -l`, `command -v claude` and `command -v gh` both resolve with
> zero manual steps. `post-create.sh` keeps only create-only work and calls `ensure-tools.sh`.

## Task list

### Phases 0–2 — done

See git history and ADRs 0001–0016. CI green on GitHub Actions throughout.

### Carry-overs cleared before the Phase 3 build

- [x] **RBAC dashboard scoping** (ADR-0017) — a real leak found in live review. `site:read:all`
      is now an explicit grant in the RBAC matrix; aggregates take a `SiteScope`.
- [x] **A14 → per-connector coverage gaps** (ADR-0018), derived from each adapter's declared
      poll interval. One global 60m constant laundered SOTI outages into observed idleness.
- [x] **subType hygiene** (ADR-0019) — normalise on write, match case-insensitively, and
      surface the applied resolution level on the asset view.

### Phase 3 — Additional connectors — done

- [x] **SNMP adapter**, exercised against a **real snmpd** (16 tests), not only a mock.
      Activity = the page counter moving; answering a walk is presence, not use.
- [x] **osquery/Fleet adapter** (15 tests), written to Fleet's REST API, mock fallback.
      Activity = OS-level user idle, never uptime.
- [x] **LIS adapter as a documented interface stub** pending C4 — `normalise` implemented and
      tested; transport throws loudly rather than returning `[]`.
- [x] **pg-boss wired once** (ADR-0020) as its own worker process: connector polls, the idle
      sweep, the nightly rollup. Verified firing in compose.
- [x] **Graceful-degradation suite** (10 tests) against a **real degraded deployment** — a
      second app with every automated connector off.
- [x] 192 unit · 72 e2e · lint · typecheck · licences · docker build — all green

### Phase 3 — deferred (with reasons)

- [ ] **A real Fleet instance.** The adapter is built and tested against a stubbed fetch; a
      Fleet tenant is a client dependency (C6), not a build task.
- [ ] **The LIS transport.** Blocked on C4 — and unbuildable before it: HL7/ASTM is a family
      of local dialects, and a parser written against the spec rather than Lablink's actual
      message stream would look finished and fail on contact. The open questions are recorded
      in `packages/connectors/src/lis.ts`.

### Phase 4 — not started

32-site heatmap, idle list, location history, alerting, SIEM export, hardening, handover docs,
AMS runbook, SBOM. Do not scaffold early.

## Done

- ADRs 0001–0020.
- Phases 0–3 complete and verified; CI green throughout.
- **Six real defects found by verification** this phase, none visible in review — see below.

## Next

1. **Phase 3 gate review.**
2. Phase 4: the 32-site heatmap, location history, alerting UI (`ConflictAlert` is written but
   not surfaced), SIEM/audit export, security hardening, handover docs + AMS runbook + SBOM.
3. Two Phase 4 items already earned by earlier bugs:
   - **A route/page disclosure test**: sign in as each role and assert what every page reveals.
     Both scope leaks were invisible in review and obvious the moment someone signed in and
     looked (ADR-0012, ADR-0017).
   - **Surface scheduler last-run times.** A deployment with no worker looks healthy and
     silently never sweeps — the dashboard just freezes in the past (ADR-0020).

## Client dependencies (not build tasks)

| #      | Dependency                                                                 | Why it matters                                                                                                                                                                                                                                                                                                                              | Status                                         |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **C1** | Lablink populates SAP FI-AA's inventory-number field with the barcode tag. | Enables tag matching, the strongest step in the SAP precedence chain (ADR-0009). Without it, precedence degrades to serial → manual: more reconciliation, permanently.                                                                                                                                                                      | Requested                                      |
| **C2** | SAP tenant + released OData endpoint and credentials.                      | Replaces the mock. A config swap.                                                                                                                                                                                                                                                                                                           | Outstanding                                    |
| **C3** | SOTI MobiControl tenant + API credentials.                                 | Adapter **built and tested**; falls back to the mock until `OAT_SOTI_*` is set.                                                                                                                                                                                                                                                             | Outstanding                                    |
| **C4** | **LIS / integration-engine feed (HL7/ASTM).**                              | **Instrument utilisation reports nothing until this exists** — by design (ADR-0008). Only the LIS knows specimens were processed. The adapter is a stub _because_ the protocol is a family of local dialects: it must be built against Lablink's real message stream, not the spec. Open questions are in `packages/connectors/src/lis.ts`. | **Outstanding — the highest-value dependency** |
| **C5** | Real site and asset lists.                                                 | We seed 3 of 32 sites.                                                                                                                                                                                                                                                                                                                      | Outstanding                                    |
| **C6** | A Fleet (osquery) instance + API token.                                    | Adapter built and tested; mock until `OAT_FLEET_*` is set.                                                                                                                                                                                                                                                                                  | Outstanding                                    |
| **C7** | SNMP device addresses + community string.                                  | Adapter built and tested against a real agent. No mock: with no targets it polls nothing, which is already the correct "not deployed" behaviour.                                                                                                                                                                                            | Outstanding                                    |

## Assumptions to confirm

Resolved: **A1** (ADR-0008), **A8** (ADR-0009), **A11** (ADR-0013), **A13** (ADR-0014),
**A14** (ADR-0018). **A12** → client dependency **C1**.

| #       | Assumption                                                                                                                 | Made because                                                                                             | How it's isolated                                                                                                                                                                                                                                                         | Confirm with                |
| ------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| A2      | SAP asset master is exposed via a released OData service; field names in the mock are placeholders.                        | No tenant or credentials.                                                                                | Typed ports + mock; a config swap.                                                                                                                                                                                                                                        | Lablink SAP team            |
| A3      | 32 sites; we seed 3.                                                                                                       | Real site list not supplied.                                                                             | Seed data only.                                                                                                                                                                                                                                                           | Lablink ops                 |
| A4      | Asset tags are barcode/QR encoding `tag` directly.                                                                         | No tagging standard supplied.                                                                            | Scan connector normalises in one place.                                                                                                                                                                                                                                   | Lablink ops                 |
| A5      | Data residency: a Malaysia region, not yet chosen.                                                                         | No hosting decision.                                                                                     | Docker-based; a deploy-time choice.                                                                                                                                                                                                                                       | ABeam + Lablink IT          |
| A6      | Single tenant, timezone Asia/Kuala_Lumpur — including rollup day boundaries and the rollup cron (16:30 UTC = 00:30 local). | One Malaysian entity.                                                                                    | `DEFAULT_TIMEZONE` in core; `ROLLUP_CRON` in `packages/jobs`.                                                                                                                                                                                                             | Lablink ops                 |
| A7      | SAP cost centre maps 1:1 to an OAT site, matched on site `code`.                                                           | The only site signal SAP offers.                                                                         | Unmapped cost centres go to the reconciliation queue, never guessed.                                                                                                                                                                                                      | Lablink SAP team + ops      |
| A9      | SAP deactivation is authoritative for RETIRED; SAP must not otherwise dictate operational status.                          | SAP cannot know whether a machine is idle or under repair.                                               | Sync only writes `status` when `deactivated`.                                                                                                                                                                                                                             | Lablink finance             |
| **A10** | **The threshold NUMBERS remain PROVISIONAL.**                                                                              | The _policy_ is decided (ADR-0008/0014); the _numbers_ are our judgement. **No test can validate them.** | Config at four levels, editable in the UI, **flagged as provisional in the UI itself**. Changing one is a recompute (ADR-0006). **Explore empirically:** once rollups have run over real telemetry, propose numbers from the observed distribution rather than judgement. | Lablink HQ Lab Manager      |
| A15     | Rollups run per local day, once the day is over.                                                                           | Simplest defensible period.                                                                              | The period is a parameter to `rollUpDay`.                                                                                                                                                                                                                                 | Lablink HQ Lab Manager      |
| **A16** | **The declared poll intervals** — SOTI 5m, osquery 15m, SNMP 15m — and the ×3 outage multiplier (ADR-0018).                | These are what we _intend_ to poll at, not what a real tenant reports at.                                | Declared on each adapter; correcting one is a one-line change, no migration.                                                                                                                                                                                              | Lablink IT (after C3/C6/C7) |
| A17     | Fleet exposes a saved query returning `asset_tag` and `idle_seconds`, run via `POST /api/v1/fleet/queries/run`.            | No Fleet instance.                                                                                       | The query NAME is config; Lablink's Fleet admin owns the SQL, we own the interpretation.                                                                                                                                                                                  | Lablink IT (C6)             |
| A18     | Printers expose `prtMarkerLifeCount` (RFC 3805).                                                                           | Standard, but vendor coverage varies.                                                                    | A device without it reports presence only — never fabricated activity.                                                                                                                                                                                                    | Lablink IT (C7)             |

## How to resume

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d postgres
cp .env.example .env            # then set AUTH_SECRET and OAT_SERVICE_TOKEN
pnpm db:deploy && pnpm db:seed
pnpm dev                                  # app on http://localhost:3000
pnpm --filter @oat/jobs start             # the scheduler, in a second terminal
```

Or the whole stack — app + worker + postgres, seeded:
`docker compose -f infra/docker-compose.yml up`.

Sign in as any seeded user (password `devpassword123`): `labmanager@` (HQ) · `branch.kl@` /
`branch.pj@` (site-scoped) · `finance@` · `it@` · `purchasing@` · `developer@` — all
`@lablink.example`.

| Command                                              |                                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                          | Unit tests. SNMP integration tests skip unless an agent is up: `docker run --rm -d -p 1161:161/udp polinux/snmpd` |
| `pnpm e2e`                                           | End-to-end, against production builds. Two servers: normal, and a fully degraded one.                             |
| `pnpm lint` · `pnpm typecheck` · `pnpm format:check` | Static checks                                                                                                     |
| `pnpm licences` · `pnpm sbom`                        | Licence gate · SBOM                                                                                               |

Then: read `CLAUDE.md` → this file → continue at **Next**.

## Verification results

Run 2026-07-17, Node 22, Postgres 16.

| Check                                                | Result                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm lint` · `pnpm format:check` · `pnpm typecheck` | Pass                                                         |
| `pnpm test`                                          | **192 passed** / 192                                         |
| `pnpm e2e`                                           | **72 passed** / 72 across both projects (`main`, `degraded`) |
| `pnpm licences`                                      | Pass — 95 production packages, all permissive                |
| `docker compose up`                                  | Pass — postgres + app + worker; scheduler observed firing    |

### Phase 3 acceptance criteria

| Criterion                   | Evidence                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-connector tests         | SNMP 16 (against a real agent) · osquery 15 · LIS 11 · SOTI 15 · scan 9                                                                                                                        |
| Each feature-flagged        | Verified: a disabled connector returns 503 naming its flag, and the scheduler does not schedule it at all.                                                                                     |
| **Degradation test passes** | 10 tests against a **real** degraded deployment (a second server with every automated connector off): register fully usable by scan, SAP link works, nothing reads 0%, no asset libelled idle. |
| pg-boss wired once          | Verified in compose: `[scheduler] soti (mock): 0 accepted`, `[scheduler] idle sweep: 1 assets re-projected`, and three crons registered in `pgboss.schedule`.                                  |

### Real defects found by verification this phase

1. **The dashboard leaked every site to a branch user** (ADR-0017). The register was scoped
   and tested; the dashboard was never scoped at all. Found by signing in and looking.
2. **A scan could not clear UNDER_REPAIR** — a genuine workflow bug, live for two phases. The
   engine tracked the latest _administrative_ and latest _contested_ assertion separately and
   let administrative win unconditionally, so a re-projection replayed January's "under
   repair" over today's "it's back in use". An operator could put an asset into repair and
   never take it out. The unit test passed because it fed **one** signal; `reprojectAsset`
   replays the whole log. Fixed: latest human word wins, whichever kind. Regression tests added.
3. **SNMP spoke v1, where a missing OID fails the whole request.** We ask every device for the
   printer page counter, so every non-printer read as unreachable and reported nothing.
   `net-snmp` defaults to v1; the code comment confidently described the v2c behaviour. **Only
   a real agent could have shown this** — a mock built from my own assumptions would have
   agreed with me.
4. **`tsc --build` passed on stale incremental state while `next build` failed on the same
   code.** A gate that can silently pass. Now `--force` (~2s more).
5. **The Docker build was failing and `compose up` started the stale image anyway**, so my
   changes silently never took effect — I spent time reading an old build as a code bug.
6. **The entrypoint ignored its command**, so the new worker service ran `next start` and
   looked like it was working.

### Known caveats

1. **Auth.js v5 is beta** (`5.0.0-beta.31`), pinned. Revisit each gate.
2. **Sign-out is global across a user's devices** (ADR-0016). Accepted.
3. **The osquery, SOTI and LIS adapters have never spoken to the real thing** (C3/C4/C6). SNMP
   has — against a generic snmpd, not a printer, so `prtMarkerLifeCount` handling is verified
   only for its _absence_ (A18).
4. **A16: the poll intervals are intentions, not measurements.** They set the coverage gaps.
5. **`ConflictAlert` is written but not surfaced.** Phase 4.
6. **No route/page disclosure test yet.** Both scope leaks would have been caught by one.
7. **A worker-less deployment looks healthy and silently never sweeps.** Phase 4 should
   surface last-run times.
8. **`REPROJECTION_WINDOW_MS` is 7 days.** A signal older than that arriving late is stored but
   does not move the projection. Revisit with retention in Phase 4.
