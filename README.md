# Lablink Operational Asset Tracker (OAT)

The operational layer for Lablink (M) Sdn Bhd's laboratory assets across 32 sites:
**location, custodian, status, idle time and utilisation** (RFP clause 2.6.4) — the
operational picture a financial ledger does not hold.

An **optional module, fully decoupled** from the SAP core.

## The SAP boundary

```
SAP FI-AA (financial master) ──shared sapAssetNo──▶ OAT (operational) ◀──signals── connectors
```

SAP S/4HANA FI-AA remains the authoritative **financial** record of every asset. The OAT
holds the **operational** record. They are linked by a shared asset ID and never merged.

| Direction     | What crosses                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| SAP → OAT     | One-way asset master sync (scheduled, idempotent upsert on `sapAssetNo`).                                               |
| OAT → SAP     | **Only** `DISPOSAL_PROPOSED`, `IMPAIRMENT_FLAG`, `LOCATION_CHANGED` — via released write APIs, behind an approval step. |
| Signals → SAP | **Never.** Idle, utilisation, heartbeat and location telemetry stay in the OAT.                                         |

The boundary is not a convention — it is a closed, typed contract. Sending telemetry to SAP
is a **compile error**, and a test fails the build if the outbound event union ever widens
to admit it. See [ADR-0004](docs/decisions/0004-sap-boundary-typed-contract.md).

## Quick start

```bash
docker compose -f infra/docker-compose.yml up
```

That is the whole demo: Postgres starts, migrations apply, 10 assets across 3 sites are
seeded, and the app comes up on <http://localhost:3000>.

Sign in at <http://localhost:3000/signin> as any seeded user — password `devpassword123`:

| User                         | Role                   | Sees                                        |
| ---------------------------- | ---------------------- | ------------------------------------------- |
| `labmanager@lablink.example` | HQ Lab Manager         | all 32 sites, utilisation, idle policy      |
| `branch.kl@lablink.example`  | Branch                 | **KL01 only** — scan, move, assign          |
| `finance@lablink.example`    | Finance                | register + approves SAP write-back          |
| `it@lablink.example`         | IT                     | connectors, integrations, runs the SAP sync |
| `purchasing@` · `developer@` | Purchasing · Developer |                                             |

Then, signed in as `it@`, run the SAP sync from the UI or the API. `LAB-0004` flips to
**IDLE** when the MDM reports it quiet, dated from when it went quiet rather than when we
were told — and the dashboard tile reflects it.

Machine callers (the scheduler's sweep, connector polls) use a separate service token:

```bash
# The MDM reports a workstation idle for 45 minutes (IT threshold: 30).
curl -X POST -H "Authorization: Bearer oat_local_demo_service_token" \
  -H 'Content-Type: application/json' \
  -d "{\"reports\":[{\"deviceId\":\"DEV-77\",\"assetRef\":\"LAB-0004\",\"idleMinutes\":45,\"reportedAt\":\"$(date -u +%FT%TZ)\"}]}" \
  localhost:3000/api/connectors/soti/poll
```

> Every credential above is a known local default, not a secret. A real deployment supplies
> `AUTH_SECRET` and `OAT_SERVICE_TOKEN` from the environment or a vault.

## Development

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d postgres
cp .env.example .env          # then set OAT_API_TOKEN
pnpm db:deploy && pnpm db:seed
pnpm dev                      # http://localhost:3000
```

| Command                        |                                                     |
| ------------------------------ | --------------------------------------------------- |
| `pnpm test`                    | Unit tests (Vitest) — no database needed            |
| `pnpm e2e`                     | End-to-end (Playwright), against a production build |
| `pnpm lint` / `pnpm typecheck` | Static checks                                       |
| `pnpm licences`                | Licence gate — fails on any copyleft dependency     |
| `pnpm sbom`                    | Generate `sbom.json` (CycloneDX)                    |

A `.devcontainer` is included: a Codespace boots ready, with a generated `OAT_API_TOKEN`.

## Architecture

A modular monolith ([ADR-0002](docs/decisions/0002-modular-monolith-in-a-pnpm-workspace.md)).
One deployable; boundaries enforced by the module graph and the compiler.

```
app/                 Next.js UI + API
packages/core        domain model, idle/utilisation engine   (never imports sap/connectors)
packages/sap         SAP master sync (in), event write-back (out)
packages/connectors  pluggable signal adapters
packages/db          Prisma schema, migrations, seed
infra/               docker-compose, Dockerfile, deploy notes
docs/decisions/      ADRs — the design rationale, and the IP-provenance trail
```

**Signals are an append-only log; status is derived**
([ADR-0006](docs/decisions/0006-signals-are-an-append-only-log-status-is-derived.md)).
Connectors never write asset state. They emit immutable observations, and the idle engine —
a pure function of (signals, policy) — decides what they mean. This is what lets the idle
definition change without a data migration, keeps a late-arriving MDM backlog from reading
as fresh idleness, and makes every utilisation figure defensible to an auditor.

### The rules that decide what the numbers mean

- **A heartbeat is never activity.** Idle is per-`AssetClass` config, and each class declares
  which sources may evidence _use_. Instruments derive idle from the **LIS** only: an analyser
  idle overnight still answers SNMP, and counting that as use would make every instrument
  report ~100% utilisation forever — the OAT's central claim, confidently false. An instrument
  with no LIS feed reports _unknown_, never 100%
  ([ADR-0008](docs/decisions/0008-idle-is-per-class-config-instruments-derive-from-lis.md)).
- **The OAT never creates assets.** SAP matching runs tag → serial → manual; anything
  unmatched goes to a **reconciliation queue** for a human. SAP knowing about an asset is not
  evidence that anyone tagged it, and a sync that can invent register rows can poison the
  register unattended at 2am
  ([ADR-0009](docs/decisions/0009-sap-matching-precedence-and-reconciliation-queue.md)).
- **Scan and telemetry own different facts.** Scan owns location, custodian, and
  administrative status; telemetry owns idle/utilisation. On the one contested question
  (IN_USE↔IDLE) a scan wins for a **TTL** (12h default, per-site —
  [ADR-0013](docs/decisions/0013-scan-ttl-is-per-site-config.md)), then telemetry resumes
  automatically, so operators' scans have real effect and stale human judgement cannot
  outrank current machine fact forever. `UNDER_REPAIR`/`RETIRED` are sticky and
  human-cleared only ([ADR-0010](docs/decisions/0010-scan-and-telemetry-precedence.md)).
- **Utilisation is measured against observed time — and absence of data is not zero.** The
  naive `busy / elapsed` cannot tell "this asset was idle" from "we weren't watching", so a
  connector outage becomes evidence against the machine and a busy analyser reports 40% with
  a chart to back it up. No coverage means **no snapshot**, and the UI says _not measured_.
  Every figure carries its denominator
  ([ADR-0015](docs/decisions/0015-utilisation-is-measured-against-observed-time.md)).
- **Idle config resolves below class**: asset → sub-type → class → default. `subType` is free
  text, so Lablink names their own equipment without a migration — an analyser and a
  microscope are both lab instruments and are not the same question
  ([ADR-0014](docs/decisions/0014-idle-config-resolves-below-class.md)).

## Access control

Auth.js v5 + RBAC across the six RFP Appendix F roles. Every page and route enforces its own
permission and site scope — **middleware is an optimisation, not the boundary**
([ADR-0012](docs/decisions/0012-pages-enforce-their-own-access.md)). That ADR exists because
we shipped a middleware gate that was correct, registered, and completely bypassed: Auth.js
threw inside it, Next swallowed the error, and the register was served unauthenticated. It
failed _open_, and every page still loaded, so nothing looked wrong.

Verified by deliberate falsification: with middleware disabled entirely, `/assets` still
redirects and leaks nothing.

## Connectors

All optional, feature-flagged, independently deployable.

| #   | Connector                                          | Status                                       |
| --- | -------------------------------------------------- | -------------------------------------------- |
| 1   | `scan` — barcode/QR → location, assignment, status | **Built.** The fallback floor.               |
| 2   | `soti` — MDM device status, idle, battery          | **Built.** Real adapter + mock fallback      |
| 3   | `osquery` / Fleet — desktop OS idle, uptime        | Phase 3                                      |
| 4   | `snmp` — network printers and infrastructure       | Phase 3                                      |
| 5   | `lis` — instrument activity via HL7/ASTM           | Phase 3 — **unlocks instrument utilisation** |

**Graceful degradation is a hard requirement.** Disable every connector and the register
stays fully usable via scan and manual entry. The idle engine will not conclude "idle" for
an asset no connector has ever reported activity for — absence of evidence is not evidence
of idleness.

Utilisation rollup eligibility is **derived** from which connectors are deployed, never
hardcoded: lab instruments report no utilisation until the LIS connector is enabled, then
start automatically with no code change. That gap is deliberate — an analyser idle overnight
still answers SNMP, so an honest _not measured_ beats a fabricated 100%.

## Licensing

Apache-2.0. **Permissive dependencies only** (MIT / Apache-2.0 / BSD / ISC); GPL, AGPL,
LGPL and SSPL are rejected, including transitively, and CI fails the build on any of them
([ADR-0003](docs/decisions/0003-permissive-licences-only-enforced-in-ci.md)).

The gate earned its place on day one by catching `@img/sharp-libvips` (LGPL-3.0-or-later)
arriving as an _optional_ dependency of Next.js — nothing we declared. It was dropped rather
than exempted ([ADR-0007](docs/decisions/0007-exclude-sharp-lgpl-libvips.md)). The exception
list is empty.

All code is original and clean-room.

## Documentation

- **[CLAUDE.md](CLAUDE.md)** — the standing brief: mission, boundary rule, guardrails, phases
- **[PROGRESS.md](PROGRESS.md)** — current state, what is next, assumptions awaiting confirmation
- **[docs/decisions/](docs/decisions/)** — ADRs
- **[docs/openapi.yaml](docs/openapi.yaml)** — REST API
