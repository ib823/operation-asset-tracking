# 22. A stopped worker must be visible; health is the absence of a heartbeat

Date: 2026-07-17
Status: Accepted

Follows ADR-0020, which named this as its own cost.

## Context

ADR-0020 moved the scheduler into its own process and recorded the consequence honestly:

> Cost: the worker is a process someone must remember to run. A deployment without it looks
> healthy and silently never sweeps.

That is the worst failure mode in the system, and it is worth being precise about why.

With no worker: every page loads. Nothing errors. `/api/health` says the database answers.
The register accepts scans. And **the entire operational picture silently freezes.** No asset
ever transitions to IDLE, because idleness is discovered by the sweep and by nothing else. No
scan TTL ever expires (ADR-0010), so a scan from January still outranks telemetry in June. No
rollup is ever written, so utilisation stops at the last day the worker ran — and, because
snapshots are a cache of a derivation, the numbers already on the dashboard keep rendering
perfectly, from stale data, with total confidence.

There is no error anywhere. The only evidence is an **absence** — a heartbeat that stopped —
and an absence has to be deliberately looked for. Nothing in the system will raise its hand.

The naive fix is a `lastRunAt` timestamp and a check. That is most of it, and it has two
traps worth avoiding:

1. **"Never ran" and "ran a while ago" are different problems.** A missing row means the
   worker was probably never deployed — a configuration error at install time. A stale row
   means it ran and stopped — a crash, an OOM, a wedge. A boolean flattens both into `false`.
2. **Timing from the finish hides a hang.** A job that started an hour ago and never finished
   is the worst case, and `finishedAt`-based staleness reports it as merely "not finished
   yet", forever.

## Decision

**The scheduler writes a `JobRun` heartbeat per queue**, recording the start _before_ doing
the work and the outcome after. One row per queue, overwritten — a liveness signal, not a
history. pg-boss already keeps the job history, and a second copy here would be a second
source of truth to disagree with it.

**Staleness is measured from `startedAt`**, so a hung job shows as stale rather than pending.

**Four states, not a boolean:** `healthy` · `failing` (alive but erroring) · `stale` (stopped
or wedged) · `never-run` (probably never deployed). Each implies a different response, and a
flag that collapses them makes the operator guess.

**The sweep decides the verdict.** A failing SOTI poll is a connector problem, not a dead
scheduler; the sweep is the one that must run, because it is what turns silence into IDLE.
Other jobs are reported but do not set the overall state.

**Stale after 15 minutes** — three missed 5-minute runs. The same "one is noise, three is a
fault" reasoning as the connector coverage gaps (ADR-0018).

**It is surfaced in the header, to everyone**, not hidden on an admin page. A stopped worker
does not break a page; it silently corrupts every number, so the person who needs to know is
whoever is reading those numbers. That is everyone.

**It renders nothing when healthy.** A permanent green badge is furniture — people stop
seeing it within a week, and then it is worse than nothing, because it _looks_ like coverage
while conveying none.

**`/api/health` stays shallow by default; `?deep=1` includes the worker.** A stopped worker
must not fail the liveness probe: the app is still serving and still useful via scan
(graceful degradation), and failing the probe would have a load balancer kill a healthy web
tier over a background job. The deep variant withholds `detail`, which can carry a connector's
error text, because the endpoint is unauthenticated.

## Consequences

- The one failure mode that produces confidently wrong numbers is now the one thing on screen.
- An operator can tell "never deployed" from "died an hour ago" without reading a log.
- Cost: one upsert per job run. Trivial, and deliberately never allowed to fail the job it
  measures — a heartbeat that breaks the work would be worse than no heartbeat. If the write
  fails, the row goes stale, which is the signal anyway.
- Cost: `JobRun` is scheduler-owned state in the app's schema. Accepted; it is one row per
  queue and it is what makes the absence visible.
- Phase 4's alerting should page on `stale`/`never-run` rather than relying on someone
  noticing a badge. The badge is the floor, not the ceiling.
