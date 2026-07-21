# 24. The serverless app uses Neon's direct (session-mode) connection, never the pgBouncer pooler

Date: 2026-07-21
Status: Accepted (supersedes ADR-0023)

## Context

ADR-0023 / PR #17 routed the app's Prisma client through Neon's pooled `-pooler` endpoint
(pgBouncer, transaction mode) with `pgbouncer=true`, to guard against serverless connection
fan-out. It was verified against `/api/health` — which runs `prisma.$queryRaw\`SELECT 1\``— saw`{"database":"up"}`, and shipped.

It broke every real page. `/assets` and the dashboard sat on the "Loading…" skeleton and
never populated; the server component's Prisma query hung until the function timed out. No
error was thrown or logged (the runtime error table stayed empty), so nothing looked wrong
from the outside — and `/api/health` stayed green throughout.

Root cause: under pgBouncer **transaction pooling**, a raw simple query (`SELECT 1`) runs on
any connection and returns, but Prisma's ordinary model queries (`findMany`, etc.) use the
**extended query protocol** (parse/bind/execute, prepared statements). `pgbouncer=true` tells
Prisma not to keep named prepared statements around, but the app's queries still wedge here
rather than erroring — a hang, not a failure. A `SELECT 1` health check cannot see this: it
exercises the one query shape that is unaffected.

This is the project's own maxim biting: **verify the property, not the mechanism** — and
verify it with a probe that can see what it claims to measure. "The database answers `SELECT
1`" is not "the app's queries return". The acceptance test for a data path is a **rendered
page with real rows**, not a health endpoint.

## Decision

The Prisma client always connects to Neon's **direct, session-mode** endpoint and never to
the `-pooler` (pgBouncer) endpoint. `resolvePrismaUrl()` returns `DATABASE_URL` (the direct
host in prod and in local docker), falling back to `DATABASE_URL_UNPOOLED` /
`POSTGRES_URL_NON_POOLING` (the same direct host, the vars Neon also exposes to Vercel
preview/dev where `DATABASE_URL` is unset — so previews connect and can be verified before a
production promotion). `POSTGRES_PRISMA_URL` is never used.

Any DB change is now verified by **loading a rendered, authenticated page and asserting the
real numbers** (e.g. `/assets` lists 10 assets, the dashboard shows idle > 0 and an open
alert, LAB-0005 shows 33.3%), not by `/api/health`.

## Consequences

- Data pages render again. The direct connection is exactly the state that served every page
  with 200s before PR #17.
- The serverless fan-out ADR-0023 worried about returns — but it was never actually observed
  to fail (the original "`/api/health` hang" that motivated ADR-0023 was never reproduced),
  and demo-scale concurrency is well within Neon's direct connection ceiling.
- If connection scaling ever does become real, the correct fix is the **`@prisma/adapter-neon`
  - `@neondatabase/serverless` (WebSocket) driver** — Neon's serverless path, which pools
    correctly without pgBouncer's transaction-mode protocol limits — not the raw pgBouncer URL.
- Direct-connection consumers (scheduler, `@oat/seed`) were always on the direct host and are
  unaffected.
