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
| Auth      | Auth.js v5 (beta, pinned) + RBAC; OIDC/SAML seam (SAP IAS) |
| Jobs      | pg-boss, in its own worker process (ADR-0005, ADR-0020)    |
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
packages/db          Prisma schema + migrations
packages/jobs        the SCHEDULER — its own process, not inside Next (ADR-0020)
packages/seed        seed/reset tooling (separate: it composes db + auth, which would
                     otherwise be a project-reference cycle)
packages/auth        RBAC + audit (pure policy) · `@oat/auth/server` = credentials (Node only)
infra/               docker-compose, Dockerfile, env samples, deploy notes
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

Priority order: **1. scan** (barcode/QR — the fallback floor) · 2. soti (MDM) · 3. osquery/Fleet · 4. snmp · 5. lis (HL7/ASTM).

Each adapter declares its `pollIntervalMinutes`; the utilisation coverage gap is derived from
it, per source (ADR-0018). All five are built except **lis**, which is a documented interface
stub pending client dependency C4 — and which is the only thing that can ever give an
instrument a utilisation figure.

**Graceful degradation is a hard requirement:** disable every connector and the register
must remain fully usable via scan/manual entry.

## Decided rules — do not re-litigate (see the ADRs)

Confirmed with the client in Phase 1. Each is enforced in code and covered by tests.

- **Idle is per-`AssetClass` config**, and each class declares which sources may evidence
  _activity_. **A heartbeat is never activity.** Instruments derive idle from the **LIS**
  only: an analyser idle overnight still answers SNMP, and counting that as use would make
  every instrument report ~100% utilisation forever — the OAT's central claim, confidently
  false. An instrument with no LIS feed reports _unknown_, never 100% (ADR-0008).
- **Idle config resolves below class**: asset → sub-type → class → default. `subType` is free
  text, so Lablink names their own equipment without a migration; `AssetClass` stays a
  vocabulary shared with SAP. **`activitySources` is never overridable** — it is the rule
  that keeps utilisation honest, not a tuning knob (ADR-0014).
- **The scan TTL is per-site** (default 12h): "one shift" is not one number across 32 sites
  (ADR-0013).
- **Utilisation is measured against OBSERVED time, never elapsed time**, and **absence of
  data is not zero**. No coverage → no snapshot → the UI says "not measured". A connector
  outage must never read as idleness: that is what would justify disposing of a busy machine.
  Rollup eligibility is derived from deployed connectors, so instruments begin rolling up
  the day the LIS is enabled (ADR-0015).
- **SAP matching precedence**: existing link → **tag** → **serial** → **manual**. Unmatched
  records go to the **reconciliation queue**. **The OAT never creates assets**, in either
  direction: SAP knowing about an asset is not evidence anyone tagged it (ADR-0009).
- **Scan vs telemetry own different facts.** Scan owns location, custodian, and
  administrative status; telemetry owns idle/utilisation. On the one contested question
  (IN_USE↔IDLE) a **scan wins for a 12h TTL**, then telemetry resumes automatically.
  `UNDER_REPAIR`/`RETIRED` are **sticky — human-cleared only, no TTL**. Both events always
  persist; sustained conflict raises an alert (ADR-0010).
- **Access control lives in the page/route, never in middleware alone** (ADR-0012), and
  applies to **aggregates as well as rows** — a count is a fact about the rows. Seeing every
  site needs the explicit `site:read:all` grant, which BRANCH does not have (ADR-0017).
- **Sign-out revokes the token** (bumps `tokenVersion`); clearing the cookie is a courtesy.
  Deleting the cookie is not reliable — a concurrent rolling-session refresh re-writes it,
  which left sign-out leaving the session LIVE about half the time (ADR-0016).

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

**Verify the property, not the mechanism.** Not a platitude — it has caught two fail-open
security bugs here. Ask "can an anonymous caller read this?" and check with curl. Do not ask
"is the middleware file present?": it was, and correct, while the whole register was exposed
(ADR-0012). Likewise `scopeToSite` once returned `null` for both "unrestricted" and
"restricted to nowhere", which would have shown a misconfigured branch user all 32 sites.

Corollary: **a test must assert its preconditions actually happened**, and **check the probe
can see what it claims to measure**. A SOTI poll that silently 401'd made a whole
verification vacuous while reading green; a leak probe that sliced the page body before
searching it reported 0 leaks while 4 were happening in front of it.

**An intermittent failure on a security path deserves a probe, not a wait.** "Flaky test"
was the wrong diagnosis for a sign-out that genuinely left the session live 50% of the time
(ADR-0016). It passed alone, failed in the suite, and passed when a wait was added — one
`await` from burying a real auth bypass forever.
