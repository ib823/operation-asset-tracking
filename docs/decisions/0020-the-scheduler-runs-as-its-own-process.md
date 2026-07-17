# 20. The scheduler runs as its own process, not inside the web app

Date: 2026-07-17
Status: Accepted

Refines ADR-0005 (pg-boss). Does not change it — pg-boss is still the queue, still in Postgres.

## Context

Phases 1 and 2 left the clock-driven work as manual endpoints: connector polls, the idle
sweep, the utilisation rollup. That was fine for a demo and useless in production. The idle
sweep in particular _has_ to be scheduled, because idleness accrues precisely when nothing is
reported — no signal will ever arrive to trigger its own discovery, and a scan TTL expires on
the clock alone (ADR-0010).

The obvious place to start pg-boss was Next's `instrumentation.ts`, which runs once per
server process. That is the documented hook, and it does not work here.

Next builds `instrumentation.ts` for **both** the Node and Edge runtimes. Guarding with
`process.env.NEXT_RUNTIME === 'nodejs'` and using a dynamic import does not help: webpack
still walks the import graph for the Edge bundle, where `dgram`, `fs`, `path` and `stream` do
not exist. The build fails on pg-boss → pg → pgpass → `path`.

`serverExternalPackages` does not apply to the Edge bundle, so externalising `pg-boss`
achieved nothing; externalising `pg` moved the failure to `pg-connection-string`, then to
`pgpass`. Chasing transitive dependencies through a bundler is a sign of fighting the tool
rather than using it — the tool was telling me the code did not belong there.

It is right. The scheduler and the web server are **different workloads**:

- Different lifecycle. A rollup should finish; a request should be fast.
- Different scaling. Scaling the web tier to N replicas should not start N schedulers.
  pg-boss would dedupe them, but "it deduplicates" is a poor reason to start work you did not
  want.
- Different failure domain. A scheduler crash-looping should not take the register offline,
  and vice versa.
- Different dependencies. The scheduler needs UDP sockets and a Postgres driver. The web app
  needs neither, and Next is entitled to be suspicious of a bundle that asks for them.

## Decision

**The scheduler is `packages/jobs`, run as its own process:** `pnpm --filter @oat/jobs start`.

`docker-compose` starts it as a `worker` service from the **same image** with a different
command. One image, two processes — not a second artefact to build, version and deploy.

The image entrypoint now honours a passed command (`exec "$@"`) rather than always starting
the web server, with `OAT_SKIP_MIGRATIONS=1` on the worker: the app owns the schema, and two
containers racing `migrate deploy` at boot is a needless lock fight.

**Connector resolution moved into `@oat/jobs` and the app re-exports it.** The scheduled poll
and the manual endpoint must resolve adapters _identically_ — if a hand-triggered poll could
pick a different adapter than the cron, a demo would prove nothing about production.

**The manual endpoints stay.** Same code path, and running a rollup by hand after correcting
a threshold is worth keeping.

This is not a new moving part in the sense ADR-0005 was avoiding. That ADR rejected **Redis**:
a second _datastore_, with its own backups, security and consistency story. A second process
against the same Postgres adds no state, no new failure mode we did not already have, and no
new thing to back up.

## Consequences

- The Next bundle contains no Postgres driver, no UDP sockets, and no queue. It builds.
- The scheduler can be restarted, scaled to zero, or run on a different box without touching
  the web tier. A deployment that wants the register but not the automation simply does not
  run the worker — and the register still works via scan (graceful degradation).
- `docker-compose up` starts three services rather than two. Honest: there were always three
  jobs, and one was pretending to be part of the web server.
- Cost: the worker is a process someone must remember to run. A deployment without it looks
  healthy and silently never sweeps — no asset ever goes idle, and the dashboard is quietly
  frozen in the past. Phase 4 should surface last-run times in the UI, so "the worker is not
  running" is visible rather than inferred from a suspiciously calm dashboard.
- The worker runs TypeScript via `tsx` rather than a compiled bundle. Acceptable: it is a
  long-lived process where a few hundred milliseconds of start-up cost nothing, and it keeps
  the workspace free of a second build pipeline.
