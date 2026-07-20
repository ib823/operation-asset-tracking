# References — On-LAN Collector

Every external dependency, standard, and architectural reference used by the collector, with
its licence and why it is here. **Shipped** dependencies are pinned to the exact version in the
lockfile and must sit inside the licence gate's `ALLOWED` set
(`scripts/check-licences.mjs:24-41`, ADR-0003). **Cite-only** references (RFCs, vendor
architecture docs) ship nothing — we borrow the OID or the idea, never the source.

Fetch status (2026-07-20, from this Codespace): snmpsim licence confirmed via GitHub
(BSD-2-Clause); net-snmp GitHub page did not surface the SPDX field in the fetch, so its
licence (MIT) is recorded from the published npm manifest and the package's `LICENSE`. Where a
fetch was incomplete it is noted; nothing here is hard-blocked on a fetch.

---

## Shipped dependencies (pinned; must pass the licence gate)

| Dependency        | Version (pinned)              | Licence | SPDX allowed? | Why it's here                                                                                                                                                               |
| ----------------- | ----------------------------- | ------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `net-snmp` (Node) | **3.26.3** (`pnpm-lock.yaml`) | **MIT** | ✅ `MIT`      | SNMP v2c client. Already used by `packages/connectors/src/snmp.ts`; the collector reuses that adapter rather than adding a second SNMP client.                              |
| `@types/net-snmp` | 3.23.0                        | MIT     | ✅            | Types for the above (devDependency).                                                                                                                                        |
| `zod`             | 3.24.1                        | MIT     | ✅            | Payload validation at the trust boundary (collector→OAT). Already the repo's validation library.                                                                            |
| `tsx`             | 4.23.1                        | MIT     | ✅            | Dev/runtime TS execution for the collector process, matching `packages/jobs`.                                                                                               |
| `pg-boss`         | (repo-pinned)                 | MIT     | ✅            | **Not** a collector dependency — noted here only to record that the collector does **not** take a DB/queue dependency. It has no Postgres driver by design (outbound-only). |

The collector adds **no new runtime dependency** beyond what `@oat/connectors` already pulls.
That is deliberate: a new package on a customer LAN is new supply-chain surface, and the
strongest way to keep the licence gate green and the attack surface small is to add nothing.

### Node's built-in modules the collector uses (no licence entry — part of Node)

`node:dgram` (SNMP, via net-snmp), `node:net` (subnet TCP-connect sweep), `node:http`/`fetch`
(outbound push + Fleet), `node:crypto` (constant-time token compare). All ship with Node
(itself MIT-licensed); nothing added to `package.json`.

---

## Standards — cite only, vendor only the OIDs used

We implement against free IETF RFCs. Per the brief, we **vendor only the exact OIDs the code
GETs**, each with its RFC citation. These four are already the constant set in
`packages/connectors/src/snmp.ts:22-31` (`OIDS`), reused unchanged:

| OID                           | Name                 | RFC                        | Why used                                                                                                                                 |
| ----------------------------- | -------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `1.3.6.1.2.1.1.1.0`           | `sysDescr`           | **RFC 1213** (MIB-II)      | Device identity string (a hint, never used to _create_ an asset).                                                                        |
| `1.3.6.1.2.1.1.3.0`           | `sysUpTime`          | RFC 1213 (MIB-II)          | Liveness / boot time. Uptime is **presence, never activity** (ADR-0008).                                                                 |
| `1.3.6.1.2.1.1.5.0`           | `sysName`            | RFC 1213 (MIB-II)          | Device's own name (identity hint).                                                                                                       |
| `1.3.6.1.2.1.43.10.2.1.4.1.1` | `prtMarkerLifeCount` | **RFC 3805** (Printer MIB) | Lifetime page count — the **only** real evidence a printer did work. A rising counter → `utilisation busy:true`; a flat one → heartbeat. |

- **RFC 1213** — MIB-II: <https://www.rfc-editor.org/rfc/rfc1213> — IETF, free to implement.
- **RFC 3805** — Printer MIB v2: <https://www.rfc-editor.org/rfc/rfc3805> — IETF, free.
- **RFC 2790** — Host Resources MIB: <https://www.rfc-editor.org/rfc/rfc2790> — IETF, free.
  _(Referenced for the subnet-sweep design vocabulary; no OID vendored from it yet — the sweep
  produces identity hints, not signals.)_
- **RFC 2863** — Interface MIB (IF-MIB): <https://www.rfc-editor.org/rfc/rfc2863> — IETF, free.
  _(Referenced only; no OID vendored — interface counters are not an activity source under
  ADR-0008.)_

Only RFC 1213 and RFC 3805 OIDs are actually vendored (the four above). RFC 2790/2863 are
listed because the brief names them; if a future module GETs one of their OIDs it will be added
to the table with the same citation discipline.

---

## Tooling & control planes — cite only

| Reference                        | Licence                                 | URL                                           | Why                                                                                                                                                                                                                                               |
| -------------------------------- | --------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **osquery**                      | Apache-2.0                              | <https://osquery.io>                          | Endpoint telemetry substrate. We **do not rebuild it** — we borrow it via Fleet, exactly as ServiceNow ACC borrows osquery.                                                                                                                       |
| **Fleet REST API**               | MIT (core)                              | <https://fleetdm.com/docs/rest-api/rest-api>  | osquery control plane. The collector's osquery module calls Fleet's REST API (`POST /api/v1/fleet/queries/run`), reusing `packages/connectors/src/osquery.ts`. Behind `OAT_FLEET_*`; mock fallback when unset.                                    |
| **snmpsim** (`snmpsim-lextudio`) | **BSD-2-Clause** (confirmed via GitHub) | <https://github.com/lextudio/snmpsim>         | **Demo only — never shipped.** Emulated SNMP printer in `infra/snmpsim`, pinned `snmpsim-lextudio==1.1.1`. Serves a rising Printer-MIB page counter so the collector observes a real delta with no external network. Not in any production image. |
| **Prometheus node_exporter**     | Apache-2.0                              | <https://github.com/prometheus/node_exporter> | OPTIONAL stretch (not implemented in this iteration): a `/metrics` scrape module. Recorded so the licence is on file if pursued.                                                                                                                  |
| **Prometheus snmp_exporter**     | Apache-2.0                              | <https://github.com/prometheus/snmp_exporter> | Same — optional stretch.                                                                                                                                                                                                                          |

---

## Architectural reference — ServiceNow (cite only, copy nothing)

North-star for **parity of concept**, not code. Names and mapping recorded so reviewers can
check we borrowed the _shape_, not the implementation:

| ServiceNow concept                                                                                             | OAT collector equivalent                                                                                  | ServiceNow doc (concept reference)                          |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **MID Server** (agent inside the customer network, outbound to the instance)                                   | The collector: runs on the customer LAN, outbound-only to cloud OAT.                                      | ServiceNow "MID Server" product docs.                       |
| **Probes / Sensors** (collect raw; parse into records)                                                         | `Connector.poll()` (probe) + `Connector.normalise()` (sensor), reused from `@oat/connectors`.             | ServiceNow "Probes and sensors" docs.                       |
| **ACC ↔ osquery** (Agent Client Collector uses osquery)                                                        | osquery module via Fleet — borrow osquery, don't rebuild it.                                              | ServiceNow "Agent Client Collector" docs.                   |
| **IRE** (Identification & Reconciliation Engine — matches inbound data to existing CIs, never blindly creates) | `resolveAssetByRef` + the never-create branch in `pipeline.ts:40`; unmatched → reconciliation (ADR-0009). | ServiceNow "Identification and Reconciliation Engine" docs. |

The parallel is exact where it matters: **collection happens on the LAN, identity/reconciliation
happens in the cloud, and neither side may invent a CI/asset from a signal.**

---

## Explicitly out of scope (per brief)

Rebuilding osquery or any agent (we borrow osquery via Fleet); a pattern DSL; native
Windows/WMI (use osquery-on-Windows); auto-creating assets (forbidden — ADR-0009).
