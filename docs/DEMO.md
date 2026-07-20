# Demos

## SNMP live-signal demo

**What it shows.** The OAT polls a **real SNMP device** over the wire and records **real
utilisation** on a known asset — entirely inside the Codespace, with no external network and
no shortcut through the poll path. It is the honest end-to-end version of the SNMP connector:
a printer answering a walk is only _reachable_; a printer whose page counter has _moved_ has
done work (ADR-0008), and only the second is utilisation.

**The moving parts.**

- `infra/snmpsim/` — an emulated SNMP printer ([snmpsim](https://github.com/lextudio/snmpsim),
  BSD-2-Clause). It serves the Printer-MIB page counter (`prtMarkerLifeCount`,
  `1.3.6.1.2.1.43.10.2.1.4.1.1`) as an **increasing** value, so two reads a few seconds apart
  differ. Runs as the `snmpsim` compose service, reachable as `snmpsim:161` on the compose
  network. Demo scaffolding only — never in a production image.
- Seeded asset **`LAB-0005`** ("Label Printer TD-4550", class `PRINTER`, site PJ02). `PRINTER`
  declares `activitySources: ['snmp']`, so SNMP may evidence its activity.
- The `worker` service runs with `OAT_CONNECTOR_SNMP=1` and
  `OAT_SNMP_TARGETS=LAB-0005@snmpsim:161` — so the target tag matches the seeded asset and the
  poll resolves to a real asset (the connector never creates assets — ADR-0009).
- `pnpm demo:poll-snmp` — a one-shot that runs the **real** poll path (`snmpConnector()` +
  `pollConnector()`, exactly what the scheduler uses) on demand, so you don't wait for the
  15-minute scheduler cadence.

### Run it (Codespace / any Docker host)

```bash
# 1. Build and start the whole stack — postgres, app, snmpsim, worker.
#    The app seeds demo data on first boot (LAB-0005 among them).
docker compose -f infra/docker-compose.yml up -d --build

# 2. Wait for the app to be ready, then confirm every service is up — including snmpsim and worker.
docker compose -f infra/docker-compose.yml ps

# 3. Fire the real SNMP poll on demand, INSIDE the worker container (where OAT_SNMP_TARGETS
#    and DATABASE_URL are already set and snmpsim is reachable by name). It polls twice —
#    baseline, then again after the counter advances — and prints what it wrote.
docker compose -f infra/docker-compose.yml exec worker pnpm --filter @oat/jobs demo:poll-snmp
```

Expected tail of the output:

```
[demo] poll 1/2 — establishing the page-count baseline...
[demo]   -> 1 accepted, 0 duplicate(s), unmatched [none]
[demo] poll 2/2 — detecting pages printed since the baseline...
[demo]   -> 1 accepted, 0 duplicate(s), unmatched [none]
[demo] LAB-0005 — Label Printer TD-4550
[demo]   status=IN_USE  lastActive=...  lastSeen=...
[demo]   recent SNMP signals (newest first):
[demo]     ...  snmp/utilisation  {"busy":true}
[demo]     ...  snmp/heartbeat  {}
[demo] ✔ Real SNMP utilisation signal written — visible on /assets/<id> under "Recent signals".
```

### See it in the UI

1. Open the app: `http://localhost:3000` (in a Codespace, the forwarded port 3000).
2. Sign in as the PJ02 branch user — `branch.pj@lablink.example` / `devpassword123`
   (or `labmanager@lablink.example` to see all sites). Dev passwords, `OAT_SEED_PASSWORD`.
3. Open **LAB-0005** (Assets → "Label Printer TD-4550"). Under **Recent signals** you'll see a
   `snmp` / `utilisation` / `{"busy":true}` row; **Status** is `IN_USE` and **Last active** is
   the moment of the second poll.

### Why the one-shot polls twice

Utilisation from a page counter is a **delta**. `prtMarkerLifeCount` is a lifetime total, so a
single reading only proves the printer is reachable (a heartbeat). Evidence of work is a second
reading higher than the first. The one-shot takes the baseline, waits
`OAT_DEMO_SNMP_WAIT_MS` (default 3000 ms) while the counter advances, then reads again and
writes `utilisation busy:true`. Both reads are real SNMP GETs against `snmpsim` — nothing is
fabricated. If the counter hasn't advanced enough between reads, raise the wait:
`OAT_DEMO_SNMP_WAIT_MS=6000`.

### Notes

- **The scheduled worker poll also runs**, every 15 minutes (`OAT_CONNECTOR_SNMP=1`). Because
  each scheduled tick constructs a fresh connector — and the page-count baseline is held in
  memory per connector instance — the scheduled path records `snmp/heartbeat` (reachable), and
  the two-reads-in-one-process one-shot is what surfaces `utilisation` on demand. Both are real
  signals written by the real path; the one-shot is simply how you see utilisation immediately.
- **Graceful degradation still holds.** Turn the connector off (`OAT_CONNECTOR_SNMP=0`) or stop
  the `snmpsim` service and the register stays fully usable via scan/manual entry.
- **Pointing at real printers.** For a real deployment, drop the `snmpsim` service and set
  `OAT_SNMP_TARGETS` to real devices (`TAG@host[:port]`, comma-separated) whose tags already
  exist in the register. Nothing else changes.
