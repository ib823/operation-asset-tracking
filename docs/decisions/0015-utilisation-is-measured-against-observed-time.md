# 15. Utilisation is measured against observed time; absence of data is not zero

Date: 2026-07-17
Status: Accepted

## Context

Phase 2 rolls signals up into `UtilisationSnapshot`: the number the HQ Lab Manager reads, and
the number that will justify a disposal proposal to Finance. It is the most consequential
figure the OAT produces, and the easiest to get quietly, plausibly wrong.

The naive rollup is `busyMinutes / periodMinutes`. It has a fatal flaw: **it cannot tell
"this asset was idle" from "we weren't watching".**

If a connector is down for six hours, the naive formula reports the asset as idle for six
hours. The MDM being offline becomes evidence against the machine. Do that across a
fortnight of patchy coverage and a perfectly busy analyser reports 40% utilisation — and
someone proposes disposing of it, with a chart to back them up. The chart would be wrong in
a way nobody could see, because the missing data left no trace in the output.

This is the same failure ADR-0008 addresses (a heartbeat is not activity, so an unmonitored
instrument must not report 100%), seen from the other side: **an unobserved asset must not
report 0% either.** Absence of evidence is not evidence, in either direction.

There is a second question: what does "busy" even mean between two observations? Signals are
discrete. A poll at 10:00 and 10:05 says nothing directly about 10:02.

## Decision

**1. The denominator is observed time, not elapsed time.**

```
utilisationPct = busyMinutes / observedMinutes
```

`observedMinutes` is stored on every snapshot, so the figure is always auditable: 80% of a
2-hour observed window is a different claim from 80% of a full day, and a reader must be able
to tell them apart.

**2. Coverage comes from presence; busy comes from activity.**

This reuses the split ADR-0006 and ADR-0008 already established. _Any_ signal — including a
heartbeat — proves we were watching. Only an **activity** signal from a source the class
trusts proves use. So a device that heartbeats all night while doing nothing is correctly
observed and correctly idle, which is exactly the case the naive formula gets wrong in
reverse.

Coverage is the union of gaps between consecutive signals, capped at `MAX_COVERAGE_GAP_MINUTES`
(60). A gap longer than that is **unobserved**, not idle: if a connector goes quiet for six
hours we did not learn six hours of idleness, we learned nothing.

**3. An activity observation at `a` marks `[a, a + threshold)` as busy** — the same rule the
live engine applies, so the rollup and the dashboard cannot disagree. Overlapping windows are
unioned, not summed, so two signals five minutes apart do not manufacture two hours of use.

**4. No coverage means NO ROW.** Not a row saying 0%.

A missing snapshot means "we do not know", and the UI must render that as _unknown_ — never
as zero. This is the decision that makes the rest safe: a zero we cannot distinguish from
ignorance is worse than a gap, because a gap prompts the question and a zero answers it
wrongly.

**5. Only classes with a deployed activity source are rolled up.**

Eligibility is derived, not hardcoded: a class is eligible if its `activitySources` is
non-empty **and** at least one of those connectors is enabled. Today that means IT, printers
and scanners roll up; `LAB_INSTRUMENT` (source: `lis`) does not, and
`REUSABLE_COMPONENT` (no automated source) never will.

Deriving it means instruments **start rolling up automatically** the day the LIS connector is
enabled — no code change, no forgotten flag. And it means turning a connector off stops the
rollups rather than silently converting them to zeroes.

## Consequences

- Utilisation is defensible. Every figure carries its denominator, and a reader can see how
  much of the period we actually watched.
- A connector outage shows as reduced `observedMinutes` — visible, and prompting the right
  question ("why is coverage low?") rather than the wrong conclusion ("this asset is idle").
- Instrument utilisation stays **unavailable** until the LIS lands, by construction rather
  than by remembering. Consistent with ADR-0008: an honest gap over a fabricated number.
- Rollups are recomputable from the append-only log (ADR-0006), so changing a threshold means
  re-running them, not migrating them.
- Cost: the UI must handle "unknown" everywhere it shows utilisation. That is real work and
  it is the point — the alternative is a dashboard that lies quietly.
- `MAX_COVERAGE_GAP_MINUTES` (60) is a judgement about how long a silence still counts as
  watching. Too high and outages read as coverage; too low and a slow poll cycle reads as an
  outage. It should be revisited per connector once real poll intervals are known.
