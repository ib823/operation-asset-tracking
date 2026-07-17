# Handover — Lablink Operational Asset Tracker (OAT)

For the engineer who inherits this. Read `CLAUDE.md` and `PROGRESS.md` first; this fills the
gaps between them.

## What this is, in one paragraph

SAP S/4HANA FI-AA is Lablink's authoritative **financial** record of every asset. It does not
know where a machine is, who has it, or whether it has done any work this month. The OAT is
that operational layer. The two systems share `sapAssetNo` and are never merged. The OAT is
optional: switch it off and SAP is unaffected.

## The five things you must not undo

Every one of these was arrived at the hard way, and each has an ADR. If you find yourself
about to "simplify" one, read the ADR first — the simplification is usually the bug.

**1. The SAP boundary is a compile error, not a rule** (ADR-0004). `packages/sap` exposes a
closed union of three accounting events. There is no generic `post`. Sending telemetry to SAP
is a type error, and a test fails the build if the union ever widens to admit it.

**2. A heartbeat is never activity** (ADR-0008). An analyser idle overnight still answers SNMP
and still checks in to an MDM. If reachability counted as use, every instrument would report
~100% utilisation forever and the OAT's central claim would be confidently false. Instruments
derive idle from the **LIS only**. This is why instrument utilisation is blank today.

**3. Absence of data is not zero** (ADR-0015). Utilisation is measured against **observed**
time. No coverage → no snapshot → the UI says "not measured". A connector outage must never
read as idleness: that is the number that would justify disposing of a busy analyser.

**4. The OAT never creates assets** (ADR-0009). SAP knowing about an asset is not evidence
anyone tagged it. Unmatched records go to the reconciliation queue for a human.

**5. Access control lives in the page/route, never in middleware alone** (ADR-0012), and
applies to **aggregates as well as rows** (ADR-0017). A count is a fact about the rows.

## Where things are

```
app/                 Next.js UI + API
packages/core        the domain: idle engine, utilisation rollups, registry. No IO frameworks.
packages/sap         the SAP boundary. Read the ADR before touching.
packages/connectors  scan · soti · osquery · snmp · lis (stub)
packages/jobs        the SCHEDULER — its own process (ADR-0020)
packages/auth        RBAC + audit (pure) · `@oat/auth/server` = credentials (Node only)
packages/db          Prisma schema + migrations
packages/seed        seed/reset tooling
infra/               Dockerfile, compose, entrypoint
docs/decisions/      23 ADRs. The design rationale, and the IP-provenance trail.
```

Dependency direction is enforced by the module graph and by lint: `core` never imports `sap`
or `connectors`.

## The idle engine, in 60 seconds

The one thing worth understanding before you change anything.

Connectors emit **immutable observations** (`SignalEvent`). They never write asset state.
`Asset.status` / `idleSince` / `lastActiveAt` are a **projection** the engine derives
(ADR-0006). The engine is a **pure function** of (signals, policy, now) — no IO, no clock
read — which is what makes it testable without a database and re-runnable over history when
a threshold changes.

Consequences you will rely on:

- Changing the idle definition is a **recompute**, not a migration. Nothing is lost.
- Out-of-order and late signals are handled by design: `observedAt` is when the world did the
  thing, `ingestedAt` is when we heard. An MDM flushing a backlog after an outage is not
  fresh idleness.
- Conflicts resolve in **one auditable function**, not a race between adapters.

The rules layered on top: scan owns location/custodian/administrative status; telemetry owns
idle/utilisation; on `IN_USE`↔`IDLE` a scan wins for a per-site TTL then telemetry resumes;
`UNDER_REPAIR`/`RETIRED` are sticky and human-cleared (ADR-0010, ADR-0013).

## What is real and what is a mock

|                   | State                                                                                                       | Unblocked by |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------ |
| **scan**          | Real. The fallback floor.                                                                                   | —            |
| **SAP**           | Mock (`OAT_SAP_CLIENT=mock`). Typed ports; the real OData client is a config swap.                          | C2           |
| **SOTI**          | Adapter **built and tested**; mock until `OAT_SOTI_*` is set. Never spoken to a real tenant.                | C3           |
| **osquery/Fleet** | Adapter **built and tested**; mock until `OAT_FLEET_*` is set. Never spoken to a real Fleet.                | C6           |
| **SNMP**          | Adapter **built and tested against a real snmpd**. No targets configured = polls nothing, which is correct. | C7           |
| **LIS**           | **Interface stub.** Throws loudly. `normalise` is implemented and tested.                                   | **C4**       |

**The LIS is the highest-value gap.** Until it lands, instrument utilisation reports nothing
— by design, not by omission. The open questions it must answer are in
`packages/connectors/src/lis.ts`; they are load-bearing, and guessing any of them wrong
produces a connector that runs and lies.

## Things that will bite you

- **The scheduler is a separate process.** No worker = the operational picture silently
  freezes. The header warns (ADR-0022), but if you are debugging "why is nothing going idle",
  this is why.
- **Behind a proxy, set `AUTH_TRUST_HOST` and `OAT_ALLOWED_ORIGINS`.** Without the first,
  Auth.js throws inside middleware and Next swallows it — the gate silently stops gating
  (ADR-0012). Without the second, every form fails with "Invalid Server Actions request".
- **Auth.js v5 is beta**, pinned. Its sign-out cookie handling races with rolling-session
  refresh, so **sign-out revokes the token** rather than trusting the cookie (ADR-0016).
- **`pnpm licences` is a gate, not a formality.** It caught an LGPL transitive dependency of
  Next on day one (ADR-0007). The exception list is empty. Keep it that way.
- **The e2e suite runs two servers**: normal, and fully degraded. Both are production builds.

## The lesson this codebase keeps teaching

Six real defects were found in Phases 1–4. **Not one was visible in the code.** Every one was
found by driving the actual behaviour and asking whether the _property_ held:

- middleware that failed **open** and served the register unauthenticated
- `scopeToSite` returning `null` for both "unrestricted" and "restricted to nowhere"
- a dashboard that leaked every site's counts while correctly refusing the rows
- sign-out that left the session live ~50% of the time
- a scan that could not clear `UNDER_REPAIR`, for two phases
- SNMP speaking v1, where a missing OID fails the whole request

Two of them passed their own unit tests. One "flaky" test was a real auth bypass, one `await`
away from being papered over forever. A probe that sliced a page body before searching it
reported zero leaks while four were happening.

**Verify the property, not the mechanism.** Ask "can an anonymous caller read this?" and check
with curl. Do not ask "is the middleware file present?" — it was, and correct, while the whole
register was exposed. And check that your probe can actually see what it claims to measure.

## Before go-live

1. **A penetration test.** ADR-0023 names six security gaps deliberately; that is a floor, not
   a certificate.
2. **The provisional idle thresholds (A10).** They are ABeam's judgement, flagged in the UI as
   provisional. No test can validate them. Once rollups have run over real telemetry for a few
   weeks, propose numbers from the observed distribution rather than judgement.
3. **Least-privilege database roles** and a secret manager (ADR-0023, gaps 5 and 7).
4. **A CVE scan in CI.** The licence gate is not a vulnerability gate.
5. **Confirm the client dependencies** (C1–C7 in `PROGRESS.md`).
