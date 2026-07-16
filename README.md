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

Then drive the slice:

```bash
TOKEN=oat_local_demo_token

# Pull the SAP asset master — populates sapAssetNo on the shared key.
curl -X POST -H "Authorization: Bearer $TOKEN" localhost:3000/api/sap/sync

# The MDM reports a workstation idle for 45 minutes (IT threshold: 30).
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"reports\":[{\"deviceId\":\"DEV-77\",\"assetRef\":\"LAB-0004\",\"idleMinutes\":45,\"reportedAt\":\"$(date -u +%FT%TZ)\"}]}" \
  localhost:3000/api/connectors/soti/poll

# Scan an asset onto the repair bench — no automated connector involved.
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"tag":"LAB-0003","location":"Repair bench","status":"UNDER_REPAIR"}' \
  localhost:3000/api/signals/scan
```

LAB-0004 flips to **IDLE**, dated from when it went quiet rather than when we were told, and
the dashboard tile reflects it.

> The token above is a known local default, not a secret. Any real deployment must supply
> `OAT_API_TOKEN` from the environment or a vault.

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

## Connectors

All optional, feature-flagged, independently deployable.

| #   | Connector                                          | Status                                  |
| --- | -------------------------------------------------- | --------------------------------------- |
| 1   | `scan` — barcode/QR → location, assignment, status | **Built.** The fallback floor.          |
| 2   | `soti` — MDM device status, idle, battery          | Mock (Phase 0); real adapter in Phase 2 |
| 3   | `osquery` / Fleet — desktop OS idle, uptime        | Phase 3                                 |
| 4   | `snmp` — network printers and infrastructure       | Phase 3                                 |
| 5   | `lis` — instrument activity via HL7/ASTM           | Phase 3                                 |

**Graceful degradation is a hard requirement.** Disable every connector and the register
stays fully usable via scan and manual entry. The idle engine will not conclude "idle" for
an asset no connector has ever reported activity for — absence of evidence is not evidence
of idleness.

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
