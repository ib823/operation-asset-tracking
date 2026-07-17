# 10. Scan and telemetry own different facts; scan wins IN_USE↔IDLE for 12h

Date: 2026-07-16
Status: Accepted

Refines the conflict-resolution rule sketched in ADR-0006.

## Context

Two kinds of source report on the same asset and will disagree.

- A **scan** is a human standing in front of the asset, asserting something.
- **Telemetry** is a device reporting about itself, continuously and without judgement.

Phase 0 resolved this bluntly: any explicit `status` assertion beat telemetry, forever. That
is wrong in both directions.

**Too weak:** a scan saying "this workstation is in use" was overridden by the next MDM poll
minutes later. The operator's statement evaporated, and from their point of view the system
simply ignored them. People stop scanning when scanning does nothing.

**Too strong:** a scan saying "in use" would suppress telemetry _forever_. Six months later
an analyser could be genuinely idle, with the engine still deferring to one scan from
January. A stale human judgement would outrank current machine fact indefinitely — the exact
failure the telemetry exists to prevent.

The resolution is that these sources are not competing on the same question. They are
authoritative about **different facts**, and the only genuine overlap is a narrow one.

## Decision

**1. Ownership is split by fact, not by source precedence.**

| Fact                                              | Owner                   | Rationale                                                                 |
| ------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| Location                                          | **Scan**                | Only a human knows where a thing physically is.                           |
| Custodian                                         | **Scan**                | An assignment is a human act.                                             |
| Administrative status (`UNDER_REPAIR`, `RETIRED`) | **Scan / human only**   | A judgement about the asset's fate. No device can make it.                |
| Idle / utilisation                                | **Telemetry**           | Continuous machine measurement; a human cannot observe a 6-week idle run. |
| `IN_USE` ↔ `IDLE`                                 | **Contested** — see (2) | The one genuine overlap.                                                  |

Telemetry cannot assert location or custodian, and cannot set or clear an administrative
status. A scan cannot fabricate utilisation.

**2. On `IN_USE` ↔ `IDLE`, a scan wins for a 12-hour TTL, then telemetry resumes.**

A scan asserting `IN_USE` or `IDLE` sets `scanAssertedStatus` / `scanAssertedAt`. While that
assertion is under 12 hours old it beats telemetry. Once it expires, telemetry resumes
automatically — no cleanup, no human action.

12 hours is chosen to cover **one shift**. The scan is trusted for as long as the person who
made it could plausibly still be right, and no longer. A judgement made this morning is good
information about this morning; it says nothing about tomorrow. The TTL is config, not a
constant, because the right number is an operational question (a two-shift site may want 24).

**3. `UNDER_REPAIR` and `RETIRED` are sticky and human-cleared only.** No TTL. A machine on
the repair bench still emits heartbeats and may still look busy; it must not resurrect
itself, and it must not resurrect itself _quietly_ after twelve hours either. Only a human
moves it out. This is deliberately asymmetric with (2): expiry is safe for "is it in use",
where the worst case is a mildly stale dashboard, and unsafe for "is it broken", where the
worst case is an unrepaired analyser silently rejoining the pool.

**4. Both events persist, always.** Signals are append-only (ADR-0006); the loser of a
conflict is never discarded. The scan _and_ the contradicting telemetry both remain in the
log, so "why does this say IN_USE?" is always answerable.

**5. Sustained conflict raises an alert.** A single disagreement is normal — a scan at
09:00 and an idle report at 09:05 is just the world changing. **Sustained** conflict is
information: telemetry insisting `IDLE` for hours against a fresh scan of `IN_USE` means
either the scan was wrong, the device is misconfigured, or the asset ref is mapped to the
wrong machine. All three are worth knowing and none are visible from either source alone.
Recorded as a `ConflictAlert`, surfaced in Phase 4 alerting.

## Consequences

- Operators' scans have real, visible effect — which is what keeps people scanning, and the
  scan connector is the fallback floor the whole system rests on when connectors are off.
- Stale human judgement cannot outrank current machine fact indefinitely. The system
  self-heals at the TTL without anyone remembering to clean up.
- Conflict becomes diagnostic output rather than a silent last-writer-wins race.
- Cost: `Asset` carries `scanAssertedStatus` / `scanAssertedAt`, and the projection is now
  time-dependent in a second way — an asset can change status with no new signal, purely
  because a TTL expired. The idle sweep already re-projects on the clock, so this is
  covered, but it means "no new signals" no longer implies "no status change".
- The 12h TTL is a guess at Lablink's shift pattern. It is config; confirm it with them.
