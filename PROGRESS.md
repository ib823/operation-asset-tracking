# PROGRESS — Lablink OAT

Living log. Update after every milestone. Read with `CLAUDE.md` at session start.

## Current phase

**Phase 1 — Core register + SAP link: COMPLETE.** Awaiting the phase gate. Phase 2 next.

## Task list

### Bootstrap — done

- [x] `CLAUDE.md` standing brief · `PROGRESS.md` living log · `docs/decisions/` · task list

### Phase 0 — PoC — done

- [x] Monorepo, docker-compose, devcontainer, CI + licence gate
- [x] Prisma schema, seed 3 sites + 10 assets
- [x] Idle engine, mock SAP sync, scan + mock SOTI connectors
- [x] Asset list, asset detail, idle-vs-in-use dashboard tile
- [x] Verified against Phase 0 acceptance criteria; CI green on GitHub Actions (run 29541667454)

### Phase 1 — Core register + SAP link — done

- [x] **Idle is per-class config; instruments derive idle from LIS, not heartbeat** (ADR-0008)
- [x] **SAP matching precedence tag → serial → manual; unmatched → reconciliation queue;
      the OAT never creates assets** (ADR-0009) — reverses Phase 0's auto-create
- [x] **Scan/telemetry ownership split; scan wins IN_USE↔IDLE for a 12h TTL; admin statuses
      sticky; both events persist; sustained conflict alerts** (ADR-0010)
- [x] `packages/auth`: Auth.js v5 + RBAC per RFP Appendix F, OIDC seam (ADR-0011)
- [x] Interim bearer token retired — sessions + permissions, machine callers separated
- [x] Site scoping enforced by query narrowing (`scopeToSite`), fails closed
- [x] Reconciliation queue: API, UI, link/dismiss with audit
- [x] `LocationHistory` written on scan-driven location change
- [x] Audit log on every mutation, with a real actor
- [x] **Pages and routes enforce their own access; middleware demoted** (ADR-0012)
- [x] 85 unit tests · 38 e2e · lint · typecheck · licence gate · build — all green

### Phase 1 — deferred to Phase 2 (with reasons)

- [ ] **Scheduled sync + idle sweep via pg-boss.** Both exist as service-token endpoints and
      are driven by e2e. Scheduling is mechanical; grouped with Phase 2's rollup scheduling
      so pg-boss is wired once, not twice.
- [ ] **SAP write-back approval workflow UI.** The contract, sink, and approval enforcement
      exist and are tested (`packages/sap`); no human-facing approval screen yet. Nothing can
      reach SAP without an approval reference, so the gap is a missing UI, not a missing control.
- [ ] **Full RFP 2.6.7 attributes** (warranty, calibration/licence expiry). `attributes:Json`
      holds OEM/serial/capitalisation today. Deferred pending the client's real field list —
      guessing the schema then migrating twice is worse than waiting.
- [ ] **UAT script.** Wants Lablink's sign-off on the ADR-0008/0009/0010 rules first.

### Phases 2–4 — not started

Do not scaffold early — see `CLAUDE.md`.

## Done

- Bootstrap docs; ADRs 0001–0012.
- Phase 0 vertical slice; CI green on GitHub Actions.
- Phase 1: the three client decisions applied, auth + RBAC, reconciliation queue.
- Two real defects found by verification and fixed (see Verification results).

## Next

1. **Phase 1 gate review.**
2. Phase 2: utilisation rollups + `UtilisationSnapshot`, per-class idle config surfaced in
   the UI for the HQ Lab Manager, the real SOTI adapter, threshold alerts.
3. Wire pg-boss once, for: scheduled SAP sync, the idle sweep (which also expires scan TTLs),
   and utilisation rollups.

## Assumptions to confirm

A1 (idle definition) and A8 (serial matching) are **decided** — see ADR-0008 and ADR-0009.

| #   | Assumption                                                                                                                                        | Made because                                                                         | How it's isolated                                                                           | Confirm with           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------- |
| A2  | SAP asset master is exposed via a released OData service; field names and asset-class codes in the mock are placeholders.                         | No tenant, endpoint, or credentials provided.                                        | Typed ports + mock (`packages/sap`); the real client is a config swap via `OAT_SAP_CLIENT`. | Lablink SAP team       |
| A3  | 32 sites; we seed 3 representative ones (KL01, PJ02, JB03).                                                                                       | Real site list not supplied.                                                         | Seed data only; `Site` is a first-class table keyed by `code`.                              | Lablink ops            |
| A4  | Asset tags are barcode/QR encoding `tag` directly (no check-digit scheme).                                                                        | No tagging standard supplied.                                                        | Scan connector normalises in one place.                                                     | Lablink ops            |
| A5  | Data residency: a Malaysia region, not yet chosen (AWS ap-southeast-5 / Azure Malaysia West).                                                     | No hosting decision yet.                                                             | Docker-based; region is a deploy-time choice.                                               | ABeam + Lablink IT     |
| A6  | Single tenant, single timezone (Asia/Kuala_Lumpur).                                                                                               | One Malaysian entity.                                                                | `TIMEZONE` in `app/src/lib/format.ts`.                                                      | Lablink ops            |
| A7  | SAP cost centre maps 1:1 to an OAT site, matched on site `code`.                                                                                  | Cost centre is the only site signal SAP offers.                                      | Unmapped cost centres go to the reconciliation queue, never guessed.                        | Lablink SAP team + ops |
| A9  | SAP deactivation is authoritative for RETIRED; SAP must not otherwise dictate operational status.                                                 | SAP cannot know whether a machine is idle or under repair.                           | `syncAssetMaster` only writes `status` when `deactivated`.                                  | Lablink finance        |
| A10 | The six **provisional** idle thresholds (ADR-0008): LAB_INSTRUMENT 120m, IT 30m, PRINTER 240m, SCANNER 240m, REUSABLE_COMPONENT 480m, OTHER 120m. | The _policy_ is decided; the _numbers_ are our judgement. No test can validate them. | Config-driven; changing them is a recompute, not a migration (ADR-0006).                    | Lablink HQ Lab Manager |
| A11 | The 12-hour scan TTL (ADR-0010) covers one shift.                                                                                                 | Shift pattern not confirmed.                                                         | Config (`scanTtlMinutes`). A two-shift site may want 24.                                    | Lablink ops            |
| A12 | SAP FI-AA's inventory-number field carries the OAT tag.                                                                                           | Enables tag matching, the strongest precedence step.                                 | If unpopulated, precedence degrades to serial → manual: more manual work, still correct.    | Lablink SAP team       |
| A13 | `LAB_INSTRUMENT` is one class for idle purposes.                                                                                                  | An analyser and a microscope plausibly want different definitions.                   | Per-class config; subdividing is a config + enum change.                                    | Lablink HQ Lab Manager |

## Blocked / needed from the client

Nothing is blocking. Every unknown is behind a mock or a config value.

To move beyond mocks: an SAP tenant + released OData endpoint and credentials (A2); a SOTI
tenant (Phase 2); an LIS/integration-engine feed (Phase 3 — **required before instrument
utilisation reports anything at all**, by design, see ADR-0008); the real site and asset
lists (A3); and sign-off on A10–A13.

## How to resume

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d postgres
cp .env.example .env            # then set AUTH_SECRET and OAT_SERVICE_TOKEN
pnpm db:deploy && pnpm db:seed
pnpm dev                        # http://localhost:3000
```

Or the whole stack, seeded, in one command: `docker compose -f infra/docker-compose.yml up`.

Sign in as any seeded user (password `devpassword123`):
`labmanager@` (HQ) · `branch.kl@` / `branch.pj@` (site-scoped) · `finance@` · `it@` ·
`purchasing@` · `developer@` — all `@lablink.example`.

| Command                                              |                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm test`                                          | Unit tests — no database needed                              |
| `pnpm e2e`                                           | End-to-end, against a production build (resets and re-seeds) |
| `pnpm lint` · `pnpm typecheck` · `pnpm format:check` | Static checks                                                |
| `pnpm licences` · `pnpm sbom`                        | Licence gate · SBOM                                          |

Then: read `CLAUDE.md` → this file → continue at **Next**.

## Verification results

Run 2026-07-17, Node 22, Postgres 16.

| Check                                                | Result                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm lint` · `pnpm format:check` · `pnpm typecheck` | Pass                                                           |
| `pnpm test`                                          | **85 passed** / 85 (6 files)                                   |
| `pnpm e2e`                                           | **38 passed** / 38, against a production build + real Postgres |
| `pnpm licences`                                      | Pass — 68 production packages, all permissive                  |
| `pnpm build` · `docker compose build`                | Pass                                                           |
| CI on GitHub Actions                                 | Green (Phase 0 run 29541667454; Phase 1 pending push)          |

### Two real defects, found by verification and fixed

Both were found by testing the **property**, not the mechanism. Both looked fine from the code.

1. **The middleware auth gate failed OPEN — the register was served unauthenticated.**
   Auth.js threw `UntrustedHost` (no `AUTH_TRUST_HOST`) _inside_ middleware; Next swallowed
   it and rendered the page. The middleware was correct, registered, and useless. Fixed by
   setting the variable **and** by making every page and route enforce its own access
   (ADR-0012). Verified by neutering middleware entirely: `/assets` still redirects and leaks
   nothing.

2. **Site scoping failed OPEN for a misconfigured user.** `scopeToSite` returned
   `string | null`, where `null` meant both "unrestricted" and "restricted to nowhere" — so a
   BRANCH user with no `siteId` would have seen all 32 sites. Caught by writing the test for
   the case. Fixed with a three-way `SiteScope` that makes the compiler force every caller to
   handle the deny case.

Also caught: **a "passing" manual test that never ran.** The SOTI poll returned 401 (middleware
was blocking service-token routes), and the assertion still read as green because the asset's
status happened to be what was expected. `reportIdle` in `e2e/helpers.ts` now asserts
`accepted === 1`, so a poll that silently does nothing fails the test.

### Verified by deliberate falsification

- **The SAP boundary guard is load-bearing.** Adding a `UTILISATION` member to
  `SapOutboundEvent` fails typecheck (`TS2578`). Confirmed by doing it and reverting.
- **The licence gate rejects.** Fed a synthetic tree: correctly fails LGPL-3.0, GPL-3.0,
  `MIT AND GPL-3.0`, and undeclared licences; correctly allows `MIT OR GPL-2.0`. It also
  aborts rather than passing over an implausibly small tree — the first draft silently
  "passed" over **0** packages.
- **Defence in depth holds.** With middleware disabled entirely, pages still redirect.
- **RBAC matches Appendix F**, driven live per role: only IT/Developer sync SAP; only
  Finance/HQ read the queue; only Branch/HQ scan; a KL user passing PJ02's `siteId` still
  sees only KL01.
- **The OAT invents nothing.** After sync: 10 assets (not 11), 2 queue items, zero `SAP-*`
  phantom tags.

### Known caveats

1. **Auth.js v5 is beta** (`5.0.0-beta.31`), pinned. Accepted deliberately (ADR-0011);
   revisit each phase gate.
2. **Argon2id was replaced by scrypt.** A step down from OWASP's preferred KDF, taken because
   every Argon2 binding ships a platform-specific native binary that breaks the bundler and
   the multi-arch Docker build (ADR-0011). Hashes are self-describing, so migrating back is
   possible without invalidating credentials.
3. **`ConflictAlert` is written but not surfaced.** Sustained scan-vs-telemetry conflict is
   detected and persisted; the alerting UI is Phase 4.
4. **Local credentials only.** Federation to SAP IAS is a provider swap (ADR-0011), not yet done.
5. **`REPROJECTION_WINDOW_MS` is 7 days.** A signal older than that arriving late is stored
   but does not move the projection. Fine at current volumes; revisit with retention in Phase 4.
6. **No route-enumeration test yet.** ADR-0012 notes that a new page could forget its own
   guard. Phase 4 should assert every route rejects an anonymous caller.
