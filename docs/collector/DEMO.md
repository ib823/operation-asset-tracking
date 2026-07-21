# On-LAN Collector — live demo

A self-contained, offline demonstration that a **real device signal becomes real utilisation on
a known asset** through the on-LAN collector (ADR-0021) — nothing faked in the signal path, no
external network, no database connection on the collector.

```
snmpsim (emulated printer, rising page counter)
     ▲  SNMP v2c
     │
 collector  ── outbound POST ─▶  app /api/collector/ingest  ──▶  postgres
 (the "LAN")     (per-collector      resolve → ingest,
                  bearer)            never create (ADR-0009)
```

The collector polls the emulated printer, sees the Printer-MIB page counter rise (RFC 3805
`prtMarkerLifeCount`), turns the delta into a `utilisation busy:true` signal, and pushes it
outbound to the app, which resolves it to the seeded `LAB-0005` printer and moves its
utilisation. The collector holds **no** database connection.

---

## 1. Docker Compose (the whole stack, offline)

From the repo root:

```bash
docker compose -f infra/collector-demo/docker-compose.yml up --build
```

This starts four services on one private network — `postgres`, `app` (migrated + seeded),
`snmpsim` (the emulated printer), and `collector`. Give it a minute: the app migrates and seeds
on first boot, then the collector begins its 10-second poll loop.

**Watch the collector work:**

```bash
docker compose -f infra/collector-demo/docker-compose.yml logs -f collector
```

The first cycle establishes the page-count baseline (a `heartbeat` — reachable is not busy); the
next cycle sees the counter has advanced and pushes `utilisation`:

```
[collector] pushed 1: 1 accepted, 0 dup, 0 unmatched
```

**See it in the UI:** open <http://localhost:3000>, sign in as
`labmanager@lablink.example` / `devpassword123`, open **LAB-0005**, and look at _Recent signals_ —
the SNMP `utilisation` the collector delivered is there, and the asset reads **IN_USE** with a
fresh _last active_ time.

Tear down (removing the demo database volume):

```bash
docker compose -f infra/collector-demo/docker-compose.yml down -v
```

### One-command headless check

`smoke.sh` brings the stack up, waits for the collector to deliver a utilisation signal, asserts
it against the database, and tears down — the same proof, no browser. This is what CI runs
(GATE 5):

```bash
sh infra/collector-demo/smoke.sh
```

---

## 2. On a laptop (collector native, no container)

The collector is a plain Node process — a technician can run it on a laptop plugged into a site
LAN, pointed at a real printer (or the emulated one). It needs only outbound reach to OAT.

**On the OAT side**, register the collector's bearer (one entry is enough):

```bash
# in the app's environment
OAT_COLLECTOR_TOKENS="collector-hq:$(openssl rand -hex 24)"
```

**On the laptop**, set the collector's own environment and start it:

```bash
export OAT_URL="https://oat.lablink.example"      # cloud OAT, outbound HTTPS only
export OAT_COLLECTOR_ID="collector-hq"
export OAT_COLLECTOR_TOKEN="…the token from OAT_COLLECTOR_TOKENS…"

export OAT_CONNECTOR_SNMP=1
export OAT_SNMP_TARGETS="LAB-0005@10.1.2.3:161"    # TAG@host[:port], comma-separated
export OAT_SNMP_COMMUNITY="public"

# optional subnet discovery (identity hints only, never creates an asset)
# export OAT_COLLECTOR_SWEEP=1
# export OAT_COLLECTOR_SWEEP_CIDR="10.1.2.0/24"

pnpm install
pnpm --filter @oat/collector start
```

The tag in `OAT_SNMP_TARGETS` must equal an asset already in the register (the collector never
creates assets). To try the laptop path with the emulated printer instead of a real one, run
`snmpsim` from `infra/snmpsim` and point `OAT_SNMP_TARGETS` at it.

---

## What the demo proves (and what it does not)

**Proves:** a real (emulated) SNMP device → a real page-count delta → a real `utilisation` signal
→ pushed outbound → resolved to a known asset → visible utilisation. The collector opens no
inbound port and no database connection. An unknown tag would be reported, never registered.

**Does not prove (out of scope / later phases):** a real Fleet/osquery tenant (C6), a real LIS
feed (C4 — the only source that gives an _instrument_ utilisation), or production TLS/secret
management (see `docs/PROD_READINESS.md`). The emulated printer stands in for a real one; a real
deployment points `OAT_SNMP_TARGETS` at real printers and never runs `snmpsim`.

## Troubleshooting

| Symptom                                            | Cause / fix                                                                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| collector logs `not enrolled: no outbound channel` | `OAT_URL` / `OAT_COLLECTOR_ID` / `OAT_COLLECTOR_TOKEN` not all set.                                                                    |
| ingest returns 401                                 | The collector's `OAT_COLLECTOR_TOKEN` has no matching entry in the app's `OAT_COLLECTOR_TOKENS`.                                       |
| ingest returns 503                                 | The app has no `OAT_COLLECTOR_TOKENS` set — the endpoint fails closed.                                                                 |
| `unmatched: [LAB-0005]`                            | The tag matches no asset. Re-seed, or point `OAT_SNMP_TARGETS` at a seeded tag.                                                        |
| only `heartbeat`, never `utilisation`              | The page counter has not advanced between two polls. With `snmpsim` it rises automatically; against a real idle printer, print a page. |
