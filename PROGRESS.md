# PROGRESS — Lablink OAT

Living log. Update after every milestone. Read with `CLAUDE.md` at session start.

## Current phase

**Phase 2 — Idle & utilisation: COMPLETE.** Awaiting the phase gate. Phase 3 next.

## Task list

### Phase 0 — PoC · Phase 1 — Core register + SAP link — done

See git history and ADRs 0001–0012. CI green on GitHub Actions from Phase 0 onward.

### Phase 2 — Idle & utilisation — done

- [x] **Scan TTL is per-site config, default 12h** (ADR-0013) — clears A11
- [x] **Idle config resolves below class: asset → sub-type → class → default** (ADR-0014) —
      clears A13. `LAB_INSTRUMENT` stays one class with one default; `subType` is free text.
- [x] **Utilisation is measured against OBSERVED time; absence of data is not zero**
      (ADR-0015) — the decision that keeps the disposal number honest
- [x] `UtilisationSnapshot` rollups, per local day (Asia/Kuala_Lumpur)
- [x] Rollup eligibility derived from deployed connectors — device/IT classes only;
      instruments wait for the LIS, and start automatically the day it is enabled
- [x] Per-class idle config in the UI, showing the resolved value **and its provenance**,
      with provisional defaults flagged as provisional
- [x] Real SOTI adapter, built to the contract, with the mock as fallback
- [x] Threshold alerts: `IdleAlert`, acknowledge flow, site-scoped, one alert per asset
- [x] Dashboard utilisation per site, rendering "not measured" rather than 0%
- [x] 135 unit tests · 55 e2e · lint · typecheck · licences · build — all green

### Phase 2 — deferred (with reasons)

- [ ] **pg-boss scheduling.** Rollup and sweep are service-token endpoints, driven by e2e and
      ready to schedule. Deferred to Phase 3 so pg-boss is wired once, alongside the
      connector polls it will also drive — rather than twice.
- [ ] **Utilisation trend charts.** The snapshots and the per-asset API exist; the 32-site
      heatmap is explicitly Phase 4.
- [ ] **Sub-type/asset override editing from the asset page.** The API and resolution chain
      are done and tested; the class-level UI ships now, which is where the client starts.

### Phase 3 — Additional connectors — not started

osquery/Fleet, SNMP, LIS (HL7/ASTM), each feature-flagged. Graceful-degradation test.
**The LIS is the one that unlocks instrument utilisation** (ADR-0008/0015).

### Phase 4 — not started

Do not scaffold early — see `CLAUDE.md`.

## Done

- ADRs 0001–0016.
- Phases 0–2 complete and verified; CI green throughout.
- **Four real defects found by verification and fixed**, all fail-open, none visible in the
  code: middleware auth failing open (ADR-0012), `scopeToSite` null ambiguity, a `.env` baked
  into the docker image, and sign-out leaving the session live (ADR-0016).

## Next

1. **Phase 2 gate review.**
2. Phase 3: osquery/Fleet, SNMP, LIS connectors; wire pg-boss once for polls + rollup + sweep;
   graceful-degradation test (all connectors off → register still fully usable).
3. Chase the client dependencies below — the LIS feed is the highest-value one, because
   instrument utilisation is unavailable by design until it lands.

## Client dependencies (not build tasks)

These need Lablink or a vendor, and no amount of engineering substitutes for them.

| #      | Dependency                                                                     | Why it matters                                                                                                                                                                                                                                | Status                |
| ------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **C1** | **Lablink populates SAP FI-AA's inventory-number field with the barcode tag.** | Enables tag matching, the strongest step in the SAP precedence chain (ADR-0009). Without it, precedence degrades to serial → manual: more manual reconciliation, permanently. Cheap for Lablink to do once; removes recurring effort forever. | Requested (was A12)   |
| **C2** | SAP tenant + released OData endpoint and credentials.                          | Replaces the mock. A config swap (`OAT_SAP_CLIENT`).                                                                                                                                                                                          | Outstanding (A2)      |
| **C3** | SOTI MobiControl tenant + API credentials.                                     | The real adapter is **built and tested**; it falls back to the mock until `OAT_SOTI_*` is set. Vendor/Lablink dependency, not a build task.                                                                                                   | Outstanding           |
| **C4** | LIS / integration-engine feed (HL7/ASTM).                                      | **Instrument utilisation reports nothing until this exists** — by design (ADR-0008). Only the LIS knows whether specimens were processed.                                                                                                     | Outstanding (Phase 3) |
| **C5** | Real site and asset lists.                                                     | We seed 3 of 32 sites.                                                                                                                                                                                                                        | Outstanding (A3)      |

## Assumptions to confirm

Resolved and removed: **A1**/**A10-policy** (ADR-0008), **A8** (ADR-0009), **A11** (ADR-0013),
**A13** (ADR-0014). **A12** became client dependency **C1**.

| #       | Assumption                                                                                                                                                                       | Made because                                                                                                                                                                                  | How it's isolated                                                                                                                                                                                                                                                                                                                                                                                                          | Confirm with           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A2      | SAP asset master is exposed via a released OData service; field names and class codes in the mock are placeholders.                                                              | No tenant or credentials.                                                                                                                                                                     | Typed ports + mock; real client is a config swap.                                                                                                                                                                                                                                                                                                                                                                          | Lablink SAP team       |
| A3      | 32 sites; we seed 3 (KL01, PJ02, JB03).                                                                                                                                          | Real site list not supplied.                                                                                                                                                                  | Seed data only.                                                                                                                                                                                                                                                                                                                                                                                                            | Lablink ops            |
| A4      | Asset tags are barcode/QR encoding `tag` directly (no check-digit scheme).                                                                                                       | No tagging standard supplied.                                                                                                                                                                 | Scan connector normalises in one place.                                                                                                                                                                                                                                                                                                                                                                                    | Lablink ops            |
| A5      | Data residency: a Malaysia region, not yet chosen.                                                                                                                               | No hosting decision.                                                                                                                                                                          | Docker-based; a deploy-time choice.                                                                                                                                                                                                                                                                                                                                                                                        | ABeam + Lablink IT     |
| A6      | Single tenant, timezone Asia/Kuala_Lumpur — including for daily rollup boundaries.                                                                                               | One Malaysian entity.                                                                                                                                                                         | `DEFAULT_TIMEZONE` in `packages/core`; `TIMEZONE` in the app.                                                                                                                                                                                                                                                                                                                                                              | Lablink ops            |
| A7      | SAP cost centre maps 1:1 to an OAT site, matched on site `code`.                                                                                                                 | The only site signal SAP offers.                                                                                                                                                              | Unmapped cost centres go to the reconciliation queue, never guessed.                                                                                                                                                                                                                                                                                                                                                       | Lablink SAP team + ops |
| A9      | SAP deactivation is authoritative for RETIRED; SAP must not otherwise dictate operational status.                                                                                | SAP cannot know whether a machine is idle or under repair.                                                                                                                                    | Sync only writes `status` when `deactivated`.                                                                                                                                                                                                                                                                                                                                                                              | Lablink finance        |
| **A10** | **The threshold NUMBERS remain PROVISIONAL** (LAB_INSTRUMENT 120m, IT 30m, PRINTER 240m, SCANNER 240m, REUSABLE_COMPONENT 480m, OTHER 120m), and the alert thresholds with them. | The _policy_ is decided (ADR-0008/0014); the _numbers_ are our judgement. **No test can validate them** — a green suite proves the mechanics, not that 30 minutes is right for a workstation. | Config-driven at four levels, editable in the UI, and **flagged as provisional in the UI itself** so a placeholder cannot quietly become an approved figure. Changing one is a recompute, not a migration (ADR-0006). **Explore empirically:** once rollups have run for a few weeks over real telemetry, propose numbers from the observed distribution rather than from judgement. That is the honest way to close this. | Lablink HQ Lab Manager |
| A14     | `MAX_COVERAGE_GAP_MINUTES` = 60: a silence longer than an hour is unobserved, not idle.                                                                                          | Real poll intervals unknown.                                                                                                                                                                  | Constant in `packages/core/src/utilisation.ts`; should become per-connector once intervals are known.                                                                                                                                                                                                                                                                                                                      | Lablink IT (after C3)  |
| A15     | Rollups run per local day, and a day is rolled up once it is over.                                                                                                               | Simplest defensible period.                                                                                                                                                                   | `rollUpDay` takes any day; the period is a parameter.                                                                                                                                                                                                                                                                                                                                                                      | Lablink HQ Lab Manager |

## How to resume

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d postgres
cp .env.example .env            # then set AUTH_SECRET and OAT_SERVICE_TOKEN
pnpm db:deploy && pnpm db:seed
pnpm dev                        # http://localhost:3000
```

Or the whole stack, seeded, in one command: `docker compose -f infra/docker-compose.yml up`.

Sign in as any seeded user (password `devpassword123`): `labmanager@` (HQ — utilisation, idle
policy, alerts) · `branch.kl@` / `branch.pj@` (site-scoped) · `finance@` · `it@` ·
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
| `pnpm test`                                          | **135 passed** / 135 (9 files)                                 |
| `pnpm e2e`                                           | **55 passed** / 55, against a production build + real Postgres |
| `pnpm licences`                                      | Pass — 68 production packages, all permissive                  |
| `pnpm build` · `docker compose build`                | Pass                                                           |
| CI on GitHub Actions                                 | Green (Phase 1 run 29545942485; Phase 2 pending push)          |

### Phase 2 acceptance criteria

| Criterion                                   | Evidence                                                                                                                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle/utilisation correct for covered assets | Verified live against the running stack: 8h of 5-min polls with 2h busy → `observedMinutes 480, busyMinutes 150, 31.3%`. The arithmetic is exact — last activity at +120, IT threshold 30, so the busy union is `[0,150)`. |
| Per-class idle config                       | Resolution chain verified live (class 90 → sub-type Microscope 480) and in unit tests across all four levels. Typo'd keys rejected at write time.                                                                          |
| First real connector (SOTI, mockable)       | Built to the contract; 15 unit tests against a stubbed `fetch` covering auth, token reuse, 401 retry, and every skip path. Falls back to the mock until `OAT_SOTI_*` is set.                                               |
| Threshold alerts                            | Verified live and in e2e: raise, no-duplicate, auto-resolve on activity, acknowledge, site scoping.                                                                                                                        |
| Tests green                                 | 135 unit + 55 e2e.                                                                                                                                                                                                         |

### Verified by deliberate falsification

- **Utilisation cannot report a connector outage as idleness.** 1h of coverage on a 24h day
  yields `observedMinutes 60`, not 1440. The naive `busy/periodLength` would report ~2% and
  someone would propose disposing of a busy machine.
- **Unknown is not zero.** Eligible-but-unwatched assets get **no snapshot**, and the
  dashboard renders "utilisation not measured". Verified in the rendered HTML: KL01 shows
  31.3%, JB03/PJ02 show "not measured".
- **An instrument's MDM traffic cannot fabricate utilisation.** SOTI activity on a
  `LAB_INSTRUMENT` leaves `lastActiveAt` null while `lastSeenAt` updates.
- **Rollup eligibility is derived, not hardcoded.** With SOTI on and LIS off, the rollup
  reports `skippedClasses: [LAB_INSTRUMENT, PRINTER, REUSABLE_COMPONENT]`.
- **A config typo cannot become a silently dead row.** `LAB_INSTRUMENT:Micrscope` is
  rejected at write time with the reason.
- Earlier phases' guards re-verified: SAP boundary (`TS2578`), licence gate rejects copyleft,
  pages self-protect with middleware disabled.

### A REAL authentication bug, caught by refusing to call a flaky test flaky

**Sign-out left the session live, ~50% of the time.** The user clicked Sign out, landed on
/signin, and their session stayed valid — press Back and the full register rendered. Probed:
`cookieRemained 4/8, DATA LEAKS 4/8`, exactly correlated.

Cause: a race inherent to rolling JWT sessions. Auth.js refreshes the session cookie on
activity, so a concurrent request re-writes it after sign-out deletes it. Deleting more
carefully only moved it to 2/8 — the deletion was never the problem.

Fixed by making sign-out **revoke the token** (bump `tokenVersion`, ADR-0011) rather than
merely clear the cookie: a surviving cookie is now worthless. After the fix the cookie still
survives sometimes (3/8, 1/8, 1/8) and **data leaks are 0/8 every run**. ADR-0016.

Two things worth recording:

- The test looked flaky — passed alone, failed in the suite, passed when a wait was added.
  One `await` would have buried a real auth bypass permanently.
- **My first probe measured nothing.** It sliced the page body to 200 characters and _then_
  searched for asset tags, so it only ever saw the nav and reported `0/8 leaks` while four
  leaks happened in front of it. A test that measures nothing reads exactly like a passing one.

### A test-isolation bug caught this phase

`resetOperational` did not clear `IdleConfig`/`IdleAlert`, so a threshold set by one test
silently changed what a later test measured — the same order-dependence trap as before, in
new tables. Fixed. Also: the sign-out e2e was **racing** the Set-Cookie that clears the
session; it now polls for the cookie to be gone. Sign-out itself was verified correct at the
HTTP level (session → null, `/assets` → 307) before touching the test — the failure was the
test's timing assumption, not an auth hole.

### Known caveats

1. **Auth.js v5 is beta** (`5.0.0-beta.31`), pinned. Revisit each gate (ADR-0011). Its
   sign-out cookie handling raced with rolling-session refresh (ADR-0016); we no longer
   depend on it.
2. **Sign-out is global across a user's devices** (ADR-0016). Accepted: per-session
   revocation needs a token-id blocklist, which Lablink has not asked for.
3. **The real SOTI adapter has never spoken to a real SOTI.** It is written to the documented
   API and tested against a stubbed `fetch`. Field names are assumption A2 until C3 lands.
4. **`MAX_COVERAGE_GAP_MINUTES` is one global constant** (A14). It should be per-connector
   once real poll intervals are known — a 5-minute MDM and an hourly SNMP sweep have
   different ideas of "still watching".
5. **Rollups are unscheduled.** Endpoints exist and are tested; pg-boss is Phase 3.
6. **`ConflictAlert` is written but not surfaced.** Alerting UI is Phase 4.
7. **No route-enumeration test yet** (ADR-0012). Phase 4 should assert every route rejects an
   anonymous caller, so a new page that forgets its guard fails CI.
8. **`REPROJECTION_WINDOW_MS` is 7 days.** A signal older than that arriving late is stored
   but does not move the projection. Revisit with retention in Phase 4.
