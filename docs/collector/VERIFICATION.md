# Collector — adversarial self-verification

Read-only verification of the on-LAN Collector against its own claims. Every item is **proven
with a command and `file:line`, not asserted**. Where a claim could be faked by a weak test, the
test was mutation-checked (made to fail by injecting the violation). Where local infra is absent
(no Docker in this environment), the CI evidence is cited with run/job ids.

Baseline for diffs: `56978fc` (pre-collector, PR #6) → `main` `8edfc0e` (collector = PR #7 + #8).
Date: 2026-07-21.

| #   | Claim                                                               | Verdict  |
| --- | ------------------------------------------------------------------- | -------- |
| 1   | Never-creates-from-telemetry has a REAL test that fails if violated | **PASS** |
| 2   | No test weakened to go green                                        | **PASS** |
| 3   | The SNMP demo produces a REAL signal on a seeded asset              | **PASS** |
| 4   | Licence gate: new deps permissive, gate green                       | **PASS** |
| 5   | Outbound-only + secrets from env (none in git/logs)                 | **PASS** |
| 6   | PROD_READINESS honestly lists external gates, not marked done       | **PASS** |

---

## 1. "OAT never creates an asset from telemetry" — real test, fails if violated — **PASS**

**The test** (`packages/connectors/src/pipeline.test.ts:134-143`):

```
134  it('NEVER creates an asset for an unknown ref — reports it as unmatched instead (ADR-0009)', …
139    expect(result.unmatched).toEqual(['GHOST-9999'])
141    expect(result.accepted).toBe(0)
142    expect(assetCreate).not.toHaveBeenCalled()   // spy on prisma.asset.create
143    expect(createMany).not.toHaveBeenCalled()     // spy on prisma.signalEvent.createMany
```

Plus the mixed-batch case (`:145-155`) and the e2e over a real DB
(`e2e/phase4-collector.spec.ts:68-87`: unknown ref → `GET /api/assets?q=GHOST-9999` returns
nothing). The production branch it pins: `packages/connectors/src/pipeline.ts:193-197` (unknown
ref → `unmatched.push`, `continue`; no create) — reused verbatim from `pipeline.ts:48-52`.

**It passes as written:**

```
$ pnpm vitest run packages/connectors/src/pipeline.test.ts
  ✓ packages/connectors/src/pipeline.test.ts (7 tests)   Tests 7 passed
```

**It has teeth (mutation test).** Injecting the violation into the real
`ingestUnresolved` — on an unknown ref, `await prisma.asset.create(...)` and assign a fake id
instead of reporting — and re-running the SAME test:

```
  × NEVER creates an asset for an unknown ref … (ADR-0009)
  × splits a mixed batch: known refs ingested, unknown refs reported, none created
  AssertionError: expected [] to deeply equal [ 'GHOST-9999' ]
  AssertionError: expected 2 to be 1
     153|     expect(assetCreate).not.toHaveBeenCalled()
  Tests  2 failed | 5 passed
```

The mutation was applied in-place and immediately reverted; `git status` confirms the tree is
clean (the committed code is unchanged). The test fails precisely when the invariant is broken.

## 2. No test weakened to go green — **PASS**

**Every deletion** in the collector work (`git diff 56978fc..HEAD | grep '^-'`) is four lines —
two reworded comments, the `SELF_GUARDED` line (adding `/api/collector`), and the `pipeline.ts`
import line (adding symbols). **Zero test lines removed.**

**Scan for weakening** across all test/e2e files:

```
$ git diff 56978fc..HEAD -- '**/*.test.ts' 'e2e/**' | grep -iE '\.skip|\.only|xit|xdescribe|it\.todo|skipIf'
  NONE FOUND
```

The 6 skipped tests in the suite are the pre-existing connectors' `snmp.integration.test.ts`
(`describe.skipIf(!up)`, PR #3/#6) — that file is **not in this diff**; they run in CI against a
real `snmpd` service. The collector's own SNMP integration test uses an in-process emulated
printer and is **never skipped** (4/4 run).

**Licence gate script — untouched:** `git diff 56978fc..HEAD -- scripts/check-licences.mjs` is
**empty**. **CI config — additive only:** the sole change to `.github/workflows/ci.yml` is the new
`collector-demo` job; no existing job altered, no `continue-on-error`, no step removed.

Full suite on `main`: `Tests 256 passed | 6 skipped (262)` — up from the pre-collector count
(collector added tests, removed none).

## 3. The SNMP demo produces a REAL signal on a seeded asset — **PASS**

Two independent proofs (no Docker in this environment, so the compose demo runs in CI):

**(a) Local, over the wire.** The collector's SNMP module polls a real net-snmp agent (an
in-process emulated printer serving RFC 3805 `prtMarkerLifeCount` as a rising counter):

```
$ pnpm vitest run packages/collector/src/modules/snmp.integration.test.ts
  ✓ reports presence (heartbeat), not activity, on first sight
  ✓ produces a real utilisation delta when the page counter advances between polls
  ✓ goes back to heartbeat when the counter is flat between polls
  ✓ the collected signal resolves against a KNOWN asset and is never created when unknown
  Tests 4 passed
```

(`packages/collector/src/modules/snmp.integration.test.ts:59-71` — first poll → `heartbeat`,
`printer.printPages(7)`, second poll → `{ type: 'utilisation', value: { busy: true } }`.)

**(b) CI, full `docker compose` demo** — `collector-demo` job, run `29792097312`, job
`88515878092`, sha `8edfc0e` (current `main`), conclusion **success**. It brings up
postgres + app + emulated printer + collector and asserts against the database
(`infra/collector-demo/smoke.sh:34-46`):

```
--- waiting up to 240s for the collector to deliver an SNMP utilisation signal ---
  ...not yet (utilisation rows=0, lastActiveAt set=0); waiting
PASS: the collector delivered a real SNMP utilisation signal to LAB-0005.
      signal_event snmp/utilisation rows = 1; LAB-0005.lastActiveAt is set.
```

LAB-0005 is a seeded PRINTER (`packages/seed/src/seed.ts:81-83`). The signal came from the
collector's outbound push, not a DB fixture.

## 4. Licence gate: new deps permissive, gate green — **PASS**

**No new external package entered the tree.** The only lockfile addition is the workspace
importer itself:

```
$ git diff 56978fc..HEAD -- pnpm-lock.yaml | grep '^+' | grep -i resolution
  (none)
$ git diff … pnpm-lock.yaml | grep '^+'  →  only "+  packages/collector:"
```

The collector's deps were already in the workspace (used by `@oat/jobs`/`@oat/connectors`):
`@oat/connectors`, `@oat/core` (workspace), `tsx`, `zod` (deps); `net-snmp`, `@types/net-snmp`
(dev) — `packages/collector/package.json:14-24`. Licences confirmed from each installed manifest:
`net-snmp → MIT`, `zod → MIT`, `tsx → MIT`, `@types/net-snmp → MIT (DefinitelyTyped)`.

**Gate green:**

```
$ pnpm licences
  ✓ Licence gate passed — 95 production packages, all permissively licensed.
```

## 5. Outbound-only + secrets from env — **PASS**

**No inbound listener in runtime code:**

```
$ grep -rE 'createServer|\.listen\(|createAgent|createReceiver|net\.createServer' \
      packages/collector/src --include='*.ts' | grep -v '\.test\.ts|/testing/'
  NONE — no inbound listener in runtime code
```

The only component that opens a listener is `testing/emulated-printer.ts` (an SNMP agent) — it is
**test-only**, imported solely by `snmp.integration.test.ts`, never by `index.ts`/`main.ts`/
`collector.ts` (grep confirms). The single outbound path is the channel: `fetch(..., { method:
'POST' })` to `/api/collector/ingest` (`packages/collector/src/channel.ts:53,66-67`). SNMP polling
is an outbound UDP client to LAN printers; the collector accepts no unsolicited connections.

**All credentials from env** (`packages/collector/src/config.ts:52-55`): `OAT_URL`,
`OAT_COLLECTOR_ID`, `OAT_COLLECTOR_TOKEN`. No hardcoded secret in runtime src:

```
$ grep -rniE '(token|secret|password)\s*[:=]\s*[\x27"][A-Za-z0-9]' packages/collector/src …
  NONE
```

**Token never logged:** no `console.*` call in `main.ts`/`health.ts`/`channel.ts` references the
token; `main.ts` logs `safeHost(url)` — host only, "never the token"
(`packages/collector/src/main.ts:15-16,32`); channel errors are status-only
(`channel.ts:79-83`). **`.env.example`** collector values are empty placeholders
(`.env.example:41,51-53`). The only committed token literal is `demo_collector_token` in the
offline demo compose (`infra/collector-demo/docker-compose.yml:57,88`) — a demo value on a
self-contained network, in the same category as the compose file's existing `AUTH_SECRET` /
`OAT_SERVICE_TOKEN` demo defaults; no real secret is in the repo.

## 6. PROD_READINESS honestly lists external gates, not marked done — **PASS**

`docs/PROD_READINESS.md` has two separated sections: `## CLOSED — validated in this work`
(line 11) and `## REQUIRES HUMAN / CLIENT / INFRA — cannot be closed here` (line 36). The
external go-live gates are all under the REQUIRES section, **not** CLOSED:

- **Real SAP access + FI-AA / Equipment master sync** — `:44`
- **Client data** (site list, asset/tag list, per-class idle thresholds) — `:47`
- **External penetration test** — `:59`
- **Secret manager**, **least-privilege DB role / backups / DR / canary** — `:65,69`
- **Collector deployed on the client LAN** — `:71`

Verdict line (`:83`): **"Code production-grade; go-live blocked only on the listed external
gates."** None of these is ticked or claimed done.

---

## Honest caveats

- The `docker compose` demo (item 3b) and the DB-backed e2e were **not run in this
  environment** (no Docker/Postgres here); they are proven by CI on the exact `main` sha, with
  run/job ids above. The local pure-Node SNMP integration (3a) independently proves a real
  over-the-wire signal → utilisation.
- Item 1's mutation test temporarily modified `pipeline.ts` and reverted it; the repository
  content is unchanged (verified clean). No other file under verification was modified.
