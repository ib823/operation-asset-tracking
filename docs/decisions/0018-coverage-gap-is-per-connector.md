# 18. The coverage gap is per connector, derived from its poll interval

Date: 2026-07-17
Status: Accepted

Resolves assumption A14. Refines ADR-0015.

## Context

ADR-0015 made utilisation measure against _observed_ time: coverage is the gaps between
consecutive signals, and a silence longer than `MAX_COVERAGE_GAP_MINUTES` (60) is unobserved
rather than idle. That single constant was flagged as A14 at the time, because one number
cannot describe two very different sources:

- **SOTI** reports every ~5 minutes. A 20-minute silence is three missed polls — the MDM is
  down. Under a 60-minute gap it silently counted as 20 minutes of _observed idleness_, and
  an outage became evidence against the machine. This is precisely the failure ADR-0015
  exists to prevent, surviving inside the fix for it.
- **SNMP** sweeps hourly. A 45-minute silence is _normal_. A 60-minute gap barely tolerates
  it, and any tightening would read a healthy printer's ordinary quiet as an outage —
  throwing away real coverage.

Tighten the constant and SNMP breaks; loosen it and SOTI's outages get laundered into
idleness. There is no correct single value, because the question "is this silence
meaningful?" is only answerable relative to how often the source is _supposed_ to speak.

## Decision

**Each connector declares its own `pollIntervalMinutes`**, and the coverage gap is derived:

```
gap = pollIntervalMinutes × 3
```

Three missed reports. One is noise; three in a row is the source being down. The adapter
declares it because only the adapter knows its own cadence — it is not something the domain
can guess, and not something an operator should have to configure per site.

**Coverage is computed per source, then unioned.** Consecutive signals from the _same_
source, within _that_ source's gap. This matters beyond tuning: mixing sources would let a
5-minute SOTI poll vouch for an hourly SNMP sweep's silence, stitching two devices' evidence
into observation that neither provided. Union across sources afterwards is correct — any
source watching is coverage.

**`scan` gets a fixed 15-minute window, not a multiple.** A human with a barcode reader has
no cadence at all. Two scans an hour apart do not mean we watched the intervening hour; a
scan proves presence at that instant and very little either side of it. Deriving a gap from a
non-existent interval would invent coverage from nothing.

The gaps flow from the app into `rollUp`, because `packages/core` must not import
`packages/connectors` (ADR-0002) — the domain does not get to know what an MDM is. The old
constant survives only as `DEFAULT_COVERAGE_GAP_MINUTES`, for a source whose cadence is
unknown.

## Consequences

- A SOTI outage now shows as reduced `observedMinutes` rather than as fabricated idleness,
  which is what ADR-0015 promised and did not quite deliver.
- SNMP's normal hourly quiet is correctly coverage, not an outage.
- The intervals are still our estimates, not measured facts — SOTI at 5 minutes and SNMP at
  15 are what we intend to poll at (the scheduler in this phase), not what a real tenant
  reports at. They are declared on the adapter, so correcting one is a one-line change with
  no migration.
- Adding a connector means declaring its cadence. That is a good forcing question: "how often
  does this thing actually talk?" is exactly what you need to know to interpret its silence.
- The `× 3` multiplier is a judgement. It is deliberately generous: over-tolerating a silence
  costs a little accuracy in the idle figure, whereas under-tolerating it deletes real
  coverage and pushes utilisation toward "not measured". Given the choice, we lose precision
  rather than data.
