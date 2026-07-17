# PROGRESS — Lablink OAT

Living log. Update after every milestone. Read with `CLAUDE.md` at session start.

## Current phase

**Phase 4 — Dashboards & rollout: COMPLETE.** Awaiting the phase gate. All five phases built.

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

### Phase 4 — Dashboards & rollout — done

Split by durability (ADR-0021): logic final everywhere, presentation provisional on three views.

**Built fully:**

- [x] **Route/page disclosure test** — DISCOVERS routes from the filesystem; a new route with
      no stated expectation fails the suite. Caught `/heatmap` shipping without one, first run.
- [x] **Scheduler last-run + worker-health indicator** (ADR-0022) — four states, measured from
      `startedAt` so a hang shows as stale. Renders nothing when healthy.
- [x] **SIEM/audit export** — NDJSON, cursor-paginated, `audit:read` only. Plus **auth events**
      (`AUTH_SIGN_IN_FAILED` etc.), which were missing entirely.
- [x] **Security hardening** (ADR-0023) — CSP + headers from middleware, sign-in rate limiting,
      six gaps named rather than hidden.
- [x] **Handover docs + AMS runbook + SBOM** — `docs/HANDOVER.md`, `docs/RUNBOOK.md`,
      `sbom.json` committed and gated in CI against drift.

**Functional-not-final** (ADR-0021 — plain markup on purpose, logic reviewed):

- [x] 32-site utilisation heatmap
- [x] Location history view
- [x] Alerting UI, now surfacing `ConflictAlert` (written since Phase 2, never shown)

**Deferred, with reasons:**

- [ ] **CSP nonces.** Next inlines the RSC payload, so `'unsafe-inline'` stands until we
      measure the dynamic-rendering cost of nonces. Revisit with the design system, when the
      pages are being touched anyway (ADR-0023 gap 1).
- [ ] **CVE scan in CI.** The licence gate is not a vulnerability gate. It will produce
      findings needing triage — not something to bolt on at the end of a phase (gap 6).
- [ ] **Least-privilege DB roles + secret manager.** Deploy-time decisions, blocked on A5.
      Documented in the runbook rather than invented here.

## Done

- ADRs 0001–0023.
- **All five phases complete** and verified; CI green throughout.
- **Nine real defects found by verification** across Phases 1–4 — not one visible in review.

## Next

1. **Phase 4 gate review — and the phase plan is complete.**
2. **Before go-live** (also in `docs/HANDOVER.md`):
   - A **penetration test**. ADR-0023 names six gaps deliberately; that is a floor, not a
     certificate.
   - **Settle A10** — the provisional thresholds. Once rollups have run over real telemetry for
     a few weeks, propose numbers from the observed distribution rather than judgement. That is
     the honest way to close it, and it needs data we do not yet have.
   - Least-privilege DB roles, a secret manager, and a CVE scan in CI.
3. **Chase C1–C7.** C4 (the LIS feed) remains the highest-value: instrument utilisation reports
   nothing until it lands, by design.
4. The design system restyles the three functional-not-final views (ADR-0021). Logic is final;
   do not rebuild it.

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

| Check                                                | Result                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm lint` · `pnpm format:check` · `pnpm typecheck` | Pass                                                           |
| `pnpm test`                                          | **207 passed** / 207                                           |
| `pnpm e2e`                                           | **100 passed** / 100 across both projects (`main`, `degraded`) |
| `pnpm licences`                                      | Pass — 95 production packages, all permissive                  |
| `pnpm sbom`                                          | Up to date; committed and gated in CI against drift            |
| `docker compose up`                                  | Pass — postgres + app + worker                                 |

### Phase 4 acceptance criteria

| Criterion                                        | Evidence                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route/page disclosure test                       | 16 tests. **Discovers** routes from the filesystem, so it cannot go stale — it caught `/heatmap` shipping with no stated expectation on its first run. Asserts: no page renders to an anonymous visitor, no page or API returns another site to a branch user, and every route's RBAC matches the matrix. |
| Scheduler last-run + health                      | Verified live: worker stopped → header reads `never-run` and `?deep=1` agrees; worker started → `healthy`, badge disappears, heartbeats in `job_run`.                                                                                                                                                     |
| SIEM/audit export                                | NDJSON, cursor-paginated, `audit:read` only. Auth events included — verified that a failed sign-in is recorded **with the attempted email even when no such account exists**, and that the password never reaches the log.                                                                                |
| Security hardening                               | Headers on every response including the 404; CSP forbids `unsafe-eval` and all third parties; sign-in rate limited. Six gaps named in ADR-0023.                                                                                                                                                           |
| Handover docs + SBOM + runbook                   | `docs/HANDOVER.md`, `docs/RUNBOOK.md`, `sbom.json` (101 components), gated in CI.                                                                                                                                                                                                                         |
| 32-site heatmap · location history · alerting UI | Functional-not-final (ADR-0021). Logic and scoping final and tested; markup plain on purpose.                                                                                                                                                                                                             |

### Real defects found by verification, all four phases

Nine, and **not one was visible in the code**. Two passed their own unit tests. One "flaky"
test was a real auth bypass, one `await` from being papered over permanently.

1. Middleware auth **failed open** — the register served unauthenticated (ADR-0012).
2. `scopeToSite` returned `null` for both "unrestricted" and "restricted to nowhere" — a
   misconfigured branch user would have seen all 32 sites.
3. A `.env` was baked into the Docker image.
4. **Sign-out left the session live ~50% of the time** (ADR-0016). Probed 4/8 leaks.
5. The **dashboard leaked every site** to a branch user while correctly refusing the rows
   (ADR-0017).
6. **A scan could not clear `UNDER_REPAIR`** — live for two phases. Operators could put an
   asset into repair and never take it out.
7. **SNMP spoke v1**, where a missing OID fails the whole request, so every non-printer read as
   unreachable. Only a real agent could have shown it.
8. `tsc --build` passed on stale incremental state while `next build` failed on the same code.
9. The Docker build failed while `compose up` silently served the stale image.

### Known caveats

1. **Auth.js v5 is beta** (`5.0.0-beta.31`), pinned. Revisit at any upgrade.
2. **Sign-out is global across a user's devices** (ADR-0016). Accepted.
3. **CSP allows `unsafe-inline` for scripts** — Next inlines the RSC payload. Nonces force
   dynamic rendering; cost unmeasured (ADR-0023 gap 1).
4. **Rate limiting is in-memory, per process.** Sized for opportunistic password spray from one
   source. A distributed attack is the load balancer's job (gap 2).
5. **The osquery, SOTI and LIS adapters have never spoken to the real thing** (C3/C4/C6). SNMP
   has, against a generic snmpd — so `prtMarkerLifeCount` is verified only for its _absence_.
6. **A16: the poll intervals are intentions, not measurements.** They set the coverage gaps.
7. **No CVE scan in CI.** The licence gate is not a vulnerability gate (gap 6).
8. **`REPROJECTION_WINDOW_MS` is 7 days.** A signal older than that arriving late is stored but
   does not move the projection. Needs a retention policy alongside it.
9. **Three views are deliberately unstyled** (ADR-0021). Plain on purpose; logic reviewed.
