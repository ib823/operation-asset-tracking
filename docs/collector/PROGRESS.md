# Collector — build progress

Living log for the on-LAN Collector work (ADR-0021). Read with `docs/collector/INSPECTION.md`.
The top-level `PROGRESS.md` covers the OAT product; this file covers the collector module.

## Status: Phase 5 complete (packaging + demo built; compose smoke runs in CI). Phase 6 next.

| Phase | What                                      | Gate                                                     | State |
| ----- | ----------------------------------------- | -------------------------------------------------------- | ----- |
| 0     | Inspect & reconcile PART-B facts          | INSPECTION.md written, no code changed                   | ✅    |
| 1     | Design — ADR-0021 + REFERENCES.md         | ADR vs every invariant; refs cited                       | ✅    |
| 2     | Scaffold + shared collect/normalise split | build+typecheck+all tests+licence green, zero regression | ✅    |
| 3     | Collection modules + SNMP proof           | module tests + SNMP integration vs emulator green        | ✅    |
| 4     | Outbound channel + enrollment + ingest    | integration + invariant tests green                      | ✅    |
| 5     | Packaging + self-contained live demo      | compose demo → real signal on seeded asset in UI         | ✅    |
| 6     | Security review, docs, PR(s)              | CI green, checklist, merged                              | ⏳    |
| 7     | Production-readiness capstone             | PROD_READINESS.md CLOSED vs REQUIRES-EXTERNAL            | ⏳    |

## Done so far

### Phase 2 — shared library + scaffold

- `packages/connectors/pipeline.ts`: `UnresolvedSignal` wire type; `collectUnresolved` (LAN
  side, no DB) and `ingestUnresolved` (cloud side / IRE) — both compose the same primitives
  `runConnector` uses; `runConnector` itself unchanged (zero regression). 7 tests incl.
  never-create.
- `packages/collector` (`@oat/collector`): env-only config (fail-closed channel, module needs
  flag+targets), `HealthReporter` heartbeat (never logs the token), `main.ts`. Depends on
  `@oat/connectors` + `@oat/core` but **not** `@oat/db` — all `@oat/db` usage is `import type`
  (erased at runtime), so the collector loads no Prisma. Proven by running with no
  `DATABASE_URL`.

### Phase 3 — collection modules

- **SNMP module** (`modules/snmp.ts`): wraps `SnmpConnector`, holds the page-count baseline
  across polls. Proven over the wire against a **pure-Node emulated printer**
  (`testing/emulated-printer.ts`, net-snmp agent serving RFC 3805 `prtMarkerLifeCount` as a
  rising table cell): first sight → heartbeat, counter advances → `utilisation busy:true`.
- **osquery module** (`modules/osquery.ts`): wraps `OsqueryConnector` behind `OAT_FLEET_*`,
  `MockOsqueryConnector` fallback.
- **subnet sweep** (`modules/sweep.ts` + `net/cidr.ts`): identity hints only, no signals, no
  DB — structurally cannot create an asset. Default probe reuses `SnmpConnector` for sysName.
  Tests assert it never creates an asset, even when a discovered ref is pushed through
  `ingestUnresolved`.
- 39 collector tests green; full suite 232 passed / 6 skipped (the connectors' snmpd
  integration tests, which need a local Docker snmpd — CI runs them); licence/lint/format green.

### Phase 4 — outbound channel + enrollment + ingest

- **Cloud ingest** (`app/.../api/collector/ingest/route.ts`): per-collector bearer
  (`requireCollectorAuth`, fail-closed) → `ingestUnresolved` (resolve → ingest, never create) →
  audit as `system:collector:<id>`. Writes only the operational signal log; no path to SAP.
- **Per-collector auth** (`app/src/lib/collector-auth.ts`, pure/testable): registry from
  `OAT_COLLECTOR_TOKENS` (or the single `OAT_COLLECTOR_ID`+`OAT_COLLECTOR_TOKEN` pair), 503 when
  unset, 401 on wrong token, constant-time compare, no id-enumeration oracle. 12 unit tests.
- **Outbound channel** (`channel.ts`): POST-only push client; sends bearer + `X-Collector-Id`;
  status-only errors (never echoes a body that could carry a secret). 5 unit tests.
- **Orchestrator** (`collector.ts`): `runCycle` collect → sweep(discovery, logged not pushed) →
  push; graceful on module/push failure; `startLoop`. `main.ts` runs the loop. 7 unit tests.
- **e2e** (`e2e/phase4-collector.spec.ts`, runs in CI vs real Postgres): pushed signal moves a
  seeded asset's utilisation; unknown ref → reported, register unchanged; 401 without a valid
  bearer; redelivery deduped; SAP linkage untouched.
- Local gates green: 256 pass / 6 skipped, typecheck/lint/format/licences. The DB-backed e2e
  runs in CI (no local Postgres/Docker in this environment).

### Phase 5 — packaging + live demo

- **`infra/collector.Dockerfile`**: Alpine (node:22-alpine), non-root, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`,
  tini as PID 1. Leaner than the app image on purpose — no `next build`, no `prisma generate`,
  no DB. Licence-clean (net-snmp/zod MIT + Node built-ins).
- **`infra/collector-demo/docker-compose.yml`**: self-contained, offline stack — postgres + app
  (seeded) + snmpsim (emulated printer) + collector. The collector polls the printer and pushes
  outbound to the app; no external network, no DB on the collector.
- **`infra/collector-demo/smoke.sh`**: headless proof — brings the stack up, waits for the
  collector to deliver an SNMP `utilisation` signal, asserts against the DB that LAB-0005's
  `lastActiveAt` moved, tears down. Wired as the CI `collector-demo` job (builds the collector
  image + runs the full compose end-to-end → GATE 5 automated).
- **`docs/collector/DEMO.md`**: compose quick-start, "visible in the UI" walkthrough, and the
  run-on-a-laptop native path, plus troubleshooting.
- Not runnable in this dev environment (no local Docker/Postgres); it runs in CI.

## Assumptions to confirm (collector-specific)

| #   | Assumption                                                                      | Isolation                                                                              |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| CO1 | Outbound channel v1 is HTTPS push on a schedule; no inbound path.               | ADR-0021; a future long-poll for cloud→collector commands is additive.                 |
| CO2 | Per-collector bearer provisioned out-of-band (env), like `OAT_SERVICE_TOKEN`.   | ADR-0021 §4; a self-enrollment handshake is a later extension.                         |
| CO3 | The emulated printer (Node net-snmp agent / snmpsim) is DEMO/TEST only.         | Never in a production image; a real deploy points `OAT_SNMP_TARGETS` at real printers. |
| CO4 | Sweep default probe is SNMP sysName; a device that ignores SNMP yields no hint. | `HostProbe` is injectable — ICMP/TCP probes are drop-in.                               |
