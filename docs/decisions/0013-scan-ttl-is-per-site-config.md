# 13. The scan TTL is per-site configuration, defaulting to 12h

Date: 2026-07-17
Status: Accepted

Resolves assumption A11 in `PROGRESS.md`.

## Context

ADR-0010 gives a human's IN_USE/IDLE scan precedence over telemetry for a fixed 12-hour TTL,
chosen to cover one shift: the scan is trusted for as long as the person who made it could
plausibly still be right.

"One shift" is not one number across 32 sites. A single-shift branch lab and a central lab
running two or three shifts have materially different answers, and a 24-hour site would find
a 12-hour TTL hands the machine the argument halfway through the working day — a scan made at
08:00 stops being believed at 20:00, while the person who made it is still on shift.

A global constant forces the wrong value on most of the estate. A per-asset value would be
absurd: nobody sets a TTL per centrifuge, and the thing that actually varies is how the
_site_ works.

## Decision

The scan TTL is resolved **per site**, falling back to a global default:

```
Site.scanTtlMinutes  →  DEFAULT_SCAN_TTL_MINUTES (12h)
```

`Site.scanTtlMinutes` is nullable. Null means "use the default" — not zero, and not a copy
of the default written into every row. A site that has never been configured must follow the
default as it changes, rather than being silently frozen at whatever the default was on the
day the site was created.

The resolver lives in `packages/core` and is a pure function of (site, defaults), so the
engine stays testable without a database.

## Consequences

- A two-shift site sets 24 and gets sensible behaviour without a code change or a deploy.
- The engine's policy input is now per-asset-context rather than global: `project()` takes
  the resolved TTL, and the caller resolves it from the asset's site. That is the correct
  direction — the engine should not know what a Site is.
- Cost: the projection path must load the site's TTL. It is one small, cacheable field on a
  table with 32 rows, read alongside the asset.
- Invalid values (negative, non-numeric) fall back to the default rather than throwing. A
  bad config entry must not take the idle engine down across the estate.
- 12h remains the default and is still our judgement, not Lablink's measured answer. It is
  now a value they can change per site rather than a constant they must accept.
