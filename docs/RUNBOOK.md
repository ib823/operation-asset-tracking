# AMS Runbook — Lablink OAT

For whoever is on call. Symptom → cause → fix. Read `HANDOVER.md` once before you need this.

## The shape of the system

Three processes, one database.

```
app       Next.js — serves the UI and the API. Applies migrations on start.
worker    the scheduler (pg-boss) — connector polls, idle sweep, nightly rollup.
postgres  everything: the register, the signal log, the queue (schema `pgboss`).
```

The **worker is the one that goes unnoticed.** The app can serve perfectly while the entire
operational picture is frozen. Start here on any "the numbers look wrong" report.

## First checks

```bash
curl -s localhost:3000/api/health           # app + database
curl -s "localhost:3000/api/health?deep=1"  # + the scheduler
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml logs worker --tail=50
```

`?deep=1` returns a `worker.state` of `healthy` · `failing` · `stale` · `never-run`.

---

## Symptom: nothing ever goes idle / utilisation is frozen

**Almost always: the worker is not running.**

Idleness accrues _because_ nothing is reported, so no signal will ever arrive to trigger its
own discovery. Only the sweep finds it. Same for scan TTL expiry and the nightly rollup.

```bash
curl -s "localhost:3000/api/health?deep=1"   # worker.state
docker compose -f infra/docker-compose.yml up -d worker
docker compose -f infra/docker-compose.yml logs worker --tail=50
```

The header also shows a warning badge to every signed-in user (ADR-0022) — if nobody
reported it, ask why they did not see it.

| `worker.state` | Means                                                  | Do                                                                    |
| -------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| `never-run`    | The worker has never started. Probably never deployed. | Start it. Check the compose service exists.                           |
| `stale`        | It ran and stopped, or is wedged.                      | Check logs, restart. A job that started and never finished is a hang. |
| `failing`      | Alive but erroring.                                    | Read `job_run.detail` — the queue name tells you which.               |
| `healthy`      | The sweep ran in the last 15 min and succeeded.        | Look elsewhere.                                                       |

```sql
SELECT queue, started_at, finished_at, ok, detail FROM job_run ORDER BY queue;
```

---

## Symptom: an instrument shows no utilisation

**This is correct, not a fault.** Instruments derive activity from the LIS only (ADR-0008),
and the LIS connector is a stub pending client dependency C4. An analyser idle overnight still
answers SNMP; counting that as use would make every instrument report ~100% forever.

Check the idle-policy page: `LAB_INSTRUMENT` → "activity comes from: lis". Nothing feeds it
yet. Do not "fix" this by adding a device-level source.

---

## Symptom: a site shows "not measured" rather than a percentage

Also correct. No connector was watching, so there is no snapshot (ADR-0015). Rendering it as
0% would be the lie the design exists to prevent.

```bash
# Which classes were skipped, and why:
curl -s -X POST -H "Authorization: Bearer $OAT_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' -d '{}' localhost:3000/api/admin/rollup
```

`skippedClasses` lists classes with no deployed connector. Enable the connector
(`OAT_CONNECTOR_*`) and rollups start automatically — eligibility is derived, not hardcoded.

---

## Symptom: every form fails — "Invalid Server Actions request"

**Cause:** the app is behind a proxy and `OAT_ALLOWED_ORIGINS` is unset.

Next compares the browser's `origin` against `x-forwarded-host` and aborts on mismatch. Every
form in the app is a server action, so sign-in, sign-out, idle policy, reconciliation and
alerts all fail together.

```bash
OAT_ALLOWED_ORIGINS="oat.lablink.example"   # comma-separated, host only, no protocol
```

If the proxy rewrites `Origin` to the upstream target, allowlist **that** value instead — it
is the `origin` Next checks, not the forwarded host. Read the app log; it names both.

---

## Symptom: signed-out users can reach pages / redirects go to localhost

**Cause:** `AUTH_TRUST_HOST` is unset behind a proxy.

Auth.js throws `UntrustedHost` inside middleware, Next swallows it, and the gate silently
stops gating (ADR-0012). Pages enforce their own access, so nothing is exposed — but fix it:

```bash
AUTH_TRUST_HOST=true    # or AUTH_URL=https://oat.lablink.example
```

---

## Symptom: the reconciliation queue is growing

Working as designed (ADR-0009). SAP has records the OAT cannot place, and the OAT will not
invent assets. Each item is real work:

- `NO_MATCH` — SAP knows an asset nobody tagged. Tag it and scan it in, or dismiss it.
- `UNKNOWN_COST_CENTRE` — SAP has a site we do not. Add the site.
- `CONFLICTING_LINK` — a serial matches an asset already linked to a different SAP number.
  **Investigate; do not re-point.** One of the two records is wrong.

**Age matters more than depth.** A long list of fresh items is last night's sync; one item
open for three weeks is a problem nobody is working.

---

## Symptom: idle alerts are noisy

Check the thresholds first: `/settings/idle-policy`. The **built-in defaults are provisional**
(A10) — ABeam's judgement, not Lablink's answer. If they are wrong for this estate, set them;
that is what the page is for. Changing one is a recompute, not a migration — nothing is lost.

Resolution is asset → sub-type → class → default. The asset page shows **which level applied**
— if it says "provisional default" where you expected a sub-type rule, the sub-type does not
match (ADR-0019).

---

## Symptom: conflicts on the alerts page

A human scan and the telemetry have disagreed for over an hour (ADR-0010). Three causes, all
worth knowing:

1. The scan was wrong (someone scanned the wrong tag).
2. The device is misconfigured.
3. The asset reference points at the wrong machine — the MDM's custom field is wrong.

The scan wins for its TTL regardless; the conflict is a diagnosis, not a veto.

---

## Routine operations

### Re-run a rollup after changing a threshold

```bash
curl -X POST -H "Authorization: Bearer $OAT_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' -d '{"day":"2026-07-15"}' \
  localhost:3000/api/admin/rollup
```

Idempotent — it upserts. Safe to re-run over any past day; signals are an append-only log, so
history is always re-derivable.

### Export the audit trail to a SIEM

```bash
curl -H "Cookie: <session>" "localhost:3000/api/audit/export?since=2026-07-01" > audit.ndjson
```

NDJSON, cursor-paginated (`X-Next-Cursor`). Resume from the cursor; never re-ingest. Requires
`audit:read` (Finance, IT, Developer). Includes auth events — `AUTH_SIGN_IN_FAILED` is the
line worth alerting on.

### Revoke a user's access immediately

Deactivate them (`User.active = false`) or bump `User.tokenVersion`. Either takes effect on
their **next request**, not at token expiry (ADR-0011). Sign-out does the same thing.

### Apply migrations

The app container runs `prisma migrate deploy` on start. It is idempotent and never drops
data. The worker skips it (`OAT_SKIP_MIGRATIONS=1`) so the two do not race.

## Environment

| Variable              | Required          | Notes                                                                                   |
| --------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | yes               |                                                                                         |
| `AUTH_SECRET`         | yes               | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `AUTH_TRUST_HOST`     | behind a proxy    | Or `AUTH_URL`. Without it the gate silently stops gating.                               |
| `OAT_ALLOWED_ORIGINS` | behind a proxy    | Or every form fails.                                                                    |
| `OAT_SERVICE_TOKEN`   | for the scheduler | Machine callers only. Fails closed when unset.                                          |
| `OAT_CONNECTOR_*`     | no                | All off except `scan`. Also decides rollup eligibility.                                 |
| `OAT_SAP_CLIENT`      | no                | `mock` only, until C2.                                                                  |
| `OAT_SEED_ON_START`   | no                | **Never `1` in production.**                                                            |

## Escalation

- **Data looks wrong but the app is up** → the worker. Start there, every time.
- **The register is unreachable** → app, then database. The worker being down does not affect
  serving.
- **Anything about a number being wrong** → check `observedMinutes` on the snapshot before
  anything else. "Not measured" and 0% are different claims, and the distinction is load-bearing.
