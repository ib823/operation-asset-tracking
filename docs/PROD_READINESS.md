# Production readiness — On-LAN Collector (ADR-0021)

Scope: the on-LAN **Collector** and its cloud ingest path. For the wider OAT product readiness,
see the top-level `PROGRESS.md` and the phase acceptance records. This document separates what
**I have validated** from what **only a human / the client / real infrastructure can close** — the
latter cannot be closed by writing code, and pretending otherwise would be the dishonesty this
project is built to avoid.

---

## CLOSED — validated in this work

Each item names how it was checked. "CI" = the GitHub Actions run on the collector PR; "local" =
run in the build environment; "e2e" = Playwright against a real Postgres in CI.

| #   | Gate item                                                      | Command / evidence                                                                                                                                   | Result                                                                       |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Shared collect/normalise split, no fork                        | `packages/connectors/pipeline.ts` (`collectUnresolved`/`ingestUnresolved` reuse `runConnector`'s primitives); `runConnector` unchanged               | 7 unit tests; **zero regression** in the 186 prior tests                     |
| 2   | Collector loads **no Prisma / no DB**                          | ran `pnpm --filter @oat/collector start` with `DATABASE_URL` unset; `@oat/db` is `import type` only (erased)                                         | local: starts clean, no DB socket                                            |
| 3   | SNMP module → real page-count delta                            | `packages/collector/src/modules/snmp.integration.test.ts` vs a pure-Node emulated printer (RFC 3805 `prtMarkerLifeCount`)                            | local + CI: first sight → heartbeat, counter rises → `utilisation busy:true` |
| 4   | osquery/Fleet module behind `OAT_FLEET_*`, mock fallback       | `modules/osquery.ts`, `modules.test.ts`                                                                                                              | CI green                                                                     |
| 5   | Subnet sweep = identity hints only, **never creates an asset** | `modules/sweep.ts` + `sweep.test.ts` (incl. discovered ref pushed through `ingestUnresolved` → unmatched, no create)                                 | CI green                                                                     |
| 6   | Ingest **never creates an asset** (ADR-0009)                   | `pipeline.test.ts` + `phase4-collector.spec.ts` (unknown ref → reported, register unchanged)                                                         | unit + **e2e** green                                                         |
| 7   | Real signal → real utilisation on a **seeded** asset           | `phase4-collector.spec.ts` (push → LAB-0005 `lastActiveAt` moves) **and** `infra/collector-demo/smoke.sh` (full offline compose)                     | e2e + **CI `collector-demo` job**                                            |
| 8   | Per-collector auth **fails closed**                            | `collector-auth.test.ts` (503 unset, 401 wrong/unknown, constant-time, no id oracle) + e2e (401 without a valid bearer)                              | unit + e2e green                                                             |
| 9   | Channel is **outbound POST-only**, never logs the token        | `channel.test.ts` (POST only; status-only errors; no body echo)                                                                                      | unit green                                                                   |
| 10  | **SAP boundary** untouched                                     | no code path from collector/ingest to `packages/sap`; ADR-0004 contract test still guards the build; e2e asserts `sapAssetNo` untouched by telemetry | typecheck + e2e green                                                        |
| 11  | Honesty model preserved                                        | same delta/idle rules as the worker; collector outage = silence = UNOBSERVED (ADR-0018), not idle; `activitySources` non-overridable                 | by construction + existing suites                                            |
| 12  | **Permissive licences only**                                   | no new runtime dependency (net-snmp/zod MIT, Node built-ins); `pnpm licences`                                                                        | local + CI: 95 pkgs, all permissive                                          |
| 13  | Secrets from **env only**, never git/logs                      | `.env.example` documents empty vars; collector logs counts/refs only                                                                                 | reviewed                                                                     |
| 14  | Collector image builds; Alpine, non-root, corepack opt-out     | `infra/collector.Dockerfile` built by the CI `collector-demo` compose                                                                                | CI green                                                                     |
| 15  | Graceful degradation                                           | `collector.ts` survives a module/push/sweep failure; `collectAll` skips a throwing module                                                            | unit green                                                                   |

---

## REQUIRES HUMAN / CLIENT / INFRA — cannot be closed here

These are not code tasks. They need credentials, real systems, a data owner's decision, or an
independent assessor. Each is isolated behind config or a documented seam so closing it is a swap,
not a rewrite.

### Client data & systems

- **Real SAP access + FI-AA / Equipment master sync** (C2). The collector feeds only the
  operational layer, but the _register it resolves against_ is populated from SAP; without the
  real master, resolution is tested against seeded assets only. Config swap (`OAT_SAP_CLIENT`).
- **Client data** — the Lablink **site list** and real **asset/tag list** (C5/C1), **idle
  thresholds per asset class** (A10 — provisional numbers, no test can validate them), and
  connector credentials: **LIS** (C4 — the only source that gives an _instrument_ utilisation),
  **SOTI** (C3), **osquery/Fleet** (C6), **SNMP device addresses + community** (C7). Open client
  dependencies **C1–C7** in `PROGRESS.md`.
- **Per-collector site binding.** v1 authorises a collector to _submit signals for resolution_
  estate-wide. Binding a collector's token to specific site(s) (so a compromised site collector
  cannot assert telemetry for another site's asset) needs the client's site/collector topology.
  Isolated: the registry (`OAT_COLLECTOR_TOKENS`) is the single place this would be extended.

### Security

- **External penetration test** of the ingest endpoint and the collector, by an independent
  assessor. Self-review (in the PR) is not a substitute. Targets to hand them: the bearer flow,
  batch-size limits, the matched/unmatched oracle surface, and DoS via large batches.

### Production infrastructure

- **Secret manager** for `OAT_COLLECTOR_TOKENS` and each collector's `OAT_COLLECTOR_TOKEN` (the
  demo uses plain env / compose literals — never for production).
- **TLS in earnest** — real certificates on OAT; the collector already speaks HTTPS by URL, but
  the trust store / pinning policy is a deployment decision.
- **Least-privilege prod DB role**, **backups / DR**, and **gated canary promotion** for the app
  the collector pushes to — OAT-wide infra, not collector code.
- **Collector deployed on the client LAN** — a real Docker host or laptop inside each site,
  reachable to the site's printers/Fleet and outbound to OAT. Until then the topology is proven
  only in the offline compose demo.
- **Enrollment hardening (optional)** — v1 provisions the per-collector token out-of-band. A
  self-enrollment handshake (one-time code → scoped token, rotation) is a clean later extension;
  it is not required for the channel to be safe, because the manual token is already scoped and
  fails closed.

---

## Verdict

**Code production-grade; go-live blocked only on the listed external gates.**
