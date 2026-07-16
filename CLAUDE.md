# CLAUDE.md — Lablink Operational Asset Tracker (OAT)

**Standing brief. Read this + `PROGRESS.md` at the start of every session, before anything else.**

## Mission

Lablink (M) Sdn Bhd (KPJ Healthcare subsidiary) runs 32 laboratory sites. Their ERP is
SAP S/4HANA Public Cloud; SAP Fixed Asset Accounting (FI-AA) is the authoritative
**financial** record of each asset. RFP clause 2.6.4 additionally requires tracking
equipment **location, user, status, idle time and utilisation** — operational data a
financial ledger does not hold.

The OAT is that operational layer. It is an **optional module, fully decoupled** from the
SAP core. SAP stays the financial system of record; the OAT holds the operational
picture; the two are linked by a shared asset ID (`sapAssetNo`), never merged.

Owner: ABeam. Eventual source handover to the client with **zero copyleft obligation**.

## The SAP boundary rule (sacred)

```
SAP FI-AA (financial master) ──shared sapAssetNo──▶ OAT (operational) ◀──signals── connectors
```

- **SAP → OAT**: one-way asset master sync (scheduled pull, released OData APIs, idempotent upsert on `sapAssetNo`).
- **OAT → SAP**: accounting-relevant events **only** — `DISPOSAL_PROPOSED`, `IMPAIRMENT_FLAG`,
  `LOCATION_CHANGED` — via released write APIs, behind an approval step.
- **Signals → OAT only**. Never push idle / utilisation / heartbeat telemetry into SAP.

The boundary is encoded as a typed interface in `packages/sap` so violations are
impossible by construction. See `docs/decisions/0004-sap-boundary-typed-contract.md`.

## Guardrails

- **Clean-room.** Study Snipe-IT, Ralph, Atlas CMMS, shelf.nu, NetBox for _ideas and
  data-model patterns only_. Never copy their source. 100% original code.
- **Licences.** Permissive only: MIT / Apache-2.0 / BSD / ISC. Reject GPL / AGPL / SSPL,
  including transitive. State the licence of every dependency in its ADR or commit. CI
  fails the build on any copyleft transitive dependency.
- **Never leave the repo broken. Never commit secrets.**

## Stack

| Concern   | Choice                                                     |
| --------- | ---------------------------------------------------------- |
| Language  | TypeScript, end to end                                     |
| Framework | Next.js (App Router) — UI + API routes in one app          |
| DB / ORM  | PostgreSQL / Prisma                                        |
| UI        | Tailwind CSS + shadcn/ui                                   |
| Auth      | Auth.js, with a seam to swap to OIDC/SAML (SAP IAS)        |
| Jobs      | pg-boss (pure Postgres)                                    |
| API       | REST, documented with OpenAPI                              |
| Packaging | Docker + docker-compose, `.devcontainer`                   |
| Tests     | Vitest (unit/integration) + Playwright (e2e)               |
| CI        | GitHub Actions: lint, typecheck, test, licence-scan, build |

## Layout

```
app/                 Next.js UI + API (assets, dashboards, admin)
packages/core        domain model + services (registry, utilisation/idle engine)
packages/sap         SAP integration: master sync (in), event write-back (out)
packages/connectors  pluggable signal adapters
packages/db          Prisma schema, migrations, seed
packages/auth        RBAC, roles, audit
infra/               docker-compose, devcontainer, env samples, deploy notes
docs/decisions/      ADRs
```

## Connectors

All optional, feature-flagged, independently deployable. Mock external systems first.

```ts
interface Connector {
  id: string
  poll?(): Promise<RawSignal[]>
  ingest?(payload: unknown): Promise<RawSignal[]>
  normalise(raw: RawSignal): SignalEventInput
}
```

Priority order: **1. scan** (barcode/QR — the fallback floor, build first) · 2. soti (MDM) · 3. osquery/Fleet · 4. snmp · 5. lis (HL7/ASTM).

**Graceful degradation is a hard requirement:** disable every connector and the register
must remain fully usable via scan/manual entry.

## Phase plan

- **Phase 0 — PoC.** Monorepo, docker-compose, devcontainer, CI+licence gate, Prisma
  Asset/Site/SignalEvent, seed 3 sites + 10 assets, asset list + detail UI, mock SAP sync,
  mock connector emitting idle signals, idle engine flipping IN_USE↔IDLE, one dashboard
  tile, Playwright e2e.
- **Phase 1 — Core register + SAP link.** Full Asset model (2.6.3/2.6.7), one-way master
  sync, write-back with approval, barcode/manual updates, RBAC per RFP Appendix F, audit log.
- **Phase 2 — Idle & utilisation.** Utilisation engine + snapshots, per-class idle config,
  SOTI adapter, reporting, threshold alerts.
- **Phase 3 — Additional connectors.** osquery/Fleet, SNMP, LIS. Degradation test.
- **Phase 4 — Dashboards & rollout.** 32-site heatmap, idle list, location history,
  alerting, SIEM export, hardening, handover docs + AMS runbook + SBOM.

## Working method

Work **one phase at a time, in order**. Do not scaffold future phases early.
Within a phase: plan → small focused commits → tests alongside code → lint + typecheck +
test + build green → advance. ADR after each non-obvious decision. Update `PROGRESS.md`
after each milestone. Self-verify each phase against its acceptance criteria and record
the results. Pause for human review at phase gates only.

**Unknowns:** assume the most reasonable value, build against a mock/config so the real
value is a later swap, log it under "Assumptions to confirm" in `PROGRESS.md`, and
continue. Only stop if no mock can substitute (missing credentials, irreversible decision).
