# 23. The serverless app connects to Neon through the pooled (pgBouncer) endpoint

Date: 2026-07-21
Status: Superseded by ADR-0024 — the pooled endpoint hung every real data query (see ADR-0024).

Relates to ADR-0005 / ADR-0020 (the scheduler is its own process — it, and the seed, keep
using a direct connection), and the Vercel deploy config in PR #11.

## Context

The OAT app is deployed on Vercel as Next.js serverless functions against a Neon Postgres
database (Neon's Vercel Marketplace integration). Prisma is wired as a plain `PrismaClient`
reading a single connection string — there is no JS driver adapter (the `driverAdapters` /
`@prisma/adapter-neon` path was considered and deferred; it mainly buys the Edge runtime, and
the app's data routes run on the Node serverless runtime).

A demo-eve report said the app "hung on the database — `/api/health` never returns". We could
not reproduce it: Vercel runtime logs for the live deployment showed **zero 5xx over 24h** and
`/api/health` returned `{"database":"up"}` in well under 1.5s, including a 12-way concurrent
burst. The only runtime error on record was a stale `PrismaClientInitializationError`
(engine-not-found) from an **older** deployment, already addressed by PR #11.

But the report pointed at a genuine latent risk. The Neon integration exposes two endpoints:

- **direct** — `ep-…​.neon.tech` (no `-pooler`): one server connection per client. Fine for a
  single long-lived process; on serverless, N function instances fan out N connections until
  Neon's ceiling is hit, and the compute autosuspends when idle so the first hit after a lull
  pays a cold-start — both of which present as a stalled request.
- **pooled** — `ep-…-pooler.​neon.tech` via pgBouncer, published as `POSTGRES_PRISMA_URL` with
  `connect_timeout=15`: multiplexes the fan-out, and fails a stuck connect fast instead of
  hanging.

The runtime `DATABASE_URL` on Vercel is a sensitive variable (unreadable via API/pull), so we
could not confirm whether it was the direct or the pooled host — i.e. we could not rule the
risk out. "Verify the property, not the mechanism" cuts the other way here: rather than prove
which host was set, make the safe host the one the code selects.

## Decision

`packages/db` resolves its connection string with an explicit precedence:
`POSTGRES_PRISMA_URL` (Neon pooled) → `DATABASE_URL` (everything else), passed to Prisma via
`datasourceUrl`. When the pooled URL is used we ensure `pgbouncer=true` (required so Prisma
disables prepared statements under pgBouncer transaction pooling; without it you get
intermittent "prepared statement already exists" errors).

`POSTGRES_PRISMA_URL` is defined only where Neon's integration sets it (Vercel prod/preview).
It is **absent** in the devcontainer, CI, and any shell that seeds/migrates with an explicit
`DATABASE_URL` — so those keep the direct connection they want (migrations and the bulk seed
are happier without a transaction pooler), and only the serverless app switches to pooled.

## Consequences

- The serverless app no longer risks connection-ceiling exhaustion or an unbounded cold-start
  stall; a bad connect now errors within `connect_timeout=15`, surfacing as a clean 503 from
  `/api/health` instead of a hang.
- Runtime `DATABASE_URL` on Vercel becomes a fallback, not the primary — a deliberate change to
  ignore it in favour of the Neon-managed pooled URL. Documented here so a future edit to
  `DATABASE_URL` that "has no effect" is not a mystery.
- Direct-connection consumers (scheduler process, `@oat/seed`) are unaffected.
- The `driverAdapters` + `@neondatabase/serverless` WebSocket path remains available as a
  future step if the app ever moves data routes to the Edge runtime; it is not needed for the
  Node serverless deployment and was kept out to minimise change on the demo path.
