# 8. Idle is per-class config; instruments derive idle from LIS activity, not heartbeat

Date: 2026-07-16
Status: Accepted

Supersedes assumption A1 in `PROGRESS.md`, which is now a decision rather than a guess.

## Context

"Idle" does not mean one thing across the estate. A workstation untouched for 30 minutes is
idle. A centrifuge untouched for 30 minutes is between runs. A label printer is quiet for
most of a shift and perfectly healthy. A single global threshold would be wrong for every
class at once.

Phase 0 shipped per-class thresholds as defaults invented by us. Lablink has not yet
confirmed the real numbers, and the numbers are the one thing no test can validate — a
green suite proves the mechanics, not that 30 minutes is right for a workstation.

There is a second, sharper problem, and it is the one that actually decides this ADR.

**A lab instrument's heartbeat is not evidence of use.** An analyser sitting idle overnight
is powered on, network-reachable, and will answer SNMP or an MDM ping all night. If
reachability counted as activity, every instrument in the estate would report ~100%
utilisation forever, and the OAT's central claim — that it can tell Lablink which
instruments are underused — would be quietly, confidently false. Worse, it would look
plausible on the dashboard. The number that matters most would be the number most likely to
be wrong, and nothing would flag it.

The only true evidence that an analyser did work is that it processed specimens, which is
recorded by the **LIS**, not by any device-level connector.

## Decision

**1. The idle threshold is configuration, per `AssetClass`.** Provisional defaults ship in
`packages/core/src/idle-policy.ts` and are overridable without a code change:

| Class                | Provisional | Reasoning                                |
| -------------------- | ----------- | ---------------------------------------- |
| `LAB_INSTRUMENT`     | 120 min     | Between-run gaps are normal              |
| `IT`                 | 30 min      | Matches screen-lock expectations         |
| `PRINTER`            | 240 min     | Bursty by nature                         |
| `SCANNER`            | 240 min     | Bursty by nature                         |
| `REUSABLE_COMPONENT` | 480 min     | Pooled items sit on a shelf between uses |
| `OTHER`              | 120 min     | Conservative middle                      |

These are **provisional**: our engineering judgement, pending Lablink's operational answer.
They are labelled as such in code and surfaced in the UI, so nobody mistakes a placeholder
for a client-approved figure.

**2. Each class declares which sources may evidence activity** (`activitySources`). A
signal from a source not on its class's list still records presence (`lastSeenAt`) — we did
hear from the asset — but cannot contribute activity and so cannot suppress idleness.

| Class                | Activity sources             |
| -------------------- | ---------------------------- |
| `LAB_INSTRUMENT`     | `lis` only                   |
| `IT`                 | `osquery`, `soti`            |
| `PRINTER`            | `snmp`                       |
| `SCANNER`            | `snmp`, `soti`               |
| `REUSABLE_COMPONENT` | _(none — scan-tracked only)_ |
| `OTHER`              | any                          |

**3. Heartbeats never evidence activity, for any class.** Reachability is presence. This was
already true in the Phase 0 engine and is now stated as policy rather than left as an
implementation detail someone could "fix".

**4. An instrument with no LIS connector reports unknown utilisation, not 100%.** The engine
already declines to conclude anything for an asset with no activity evidence. Combined with
(2), this means instruments are honest-by-default: before the LIS is wired, they show no
utilisation rather than a fabricated one.

## Consequences

- Instrument utilisation becomes trustworthy, because it is derived from the only source
  that actually knows: specimens processed.
- Instrument utilisation is **unavailable until the LIS connector lands in Phase 3.** This
  is the cost, and it is worth paying. An honest gap is a scheduling problem; a fabricated
  100% is a decision-making hazard that would survive to the client's board pack.
- Changing a threshold later is a recompute, not a migration — signals are an append-only
  log (ADR-0006), so the inputs are still there. This is what makes shipping provisional
  numbers safe rather than reckless.
- `activitySources` must be updated when a connector is added, or that connector's signals
  will be silently presence-only. The per-class table is the single place to do it.
- `REUSABLE_COMPONENT` has no automated activity source by design: racks and pooled items
  are tracked by scan. They will not go idle on their own, which is correct — a rack on a
  shelf is not "idle", it is stored.

## Still to confirm with Lablink

The six threshold values, and whether `LAB_INSTRUMENT` should be subdivided (an analyser and
a microscope plausibly want different definitions, and both are `LAB_INSTRUMENT` today).
