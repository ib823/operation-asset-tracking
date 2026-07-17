# 5. pg-boss for background jobs; no Redis

Date: 2026-07-16
Status: Accepted

## Context

The OAT needs background work: scheduled SAP master sync, connector polls, utilisation
rollups, and signal ingestion that should not block an HTTP request. This needs a queue
with scheduling, retries, and at-least-once delivery.

The workload is small — 32 sites, thousands of assets, polls measured in minutes, not a
high-throughput event bus. The client's IT team must operate this without a platform group,
and it must come up with `docker-compose up`.

Options:

1. **BullMQ + Redis** (both MIT/BSD-3). Excellent throughput, mature. Cost: a second
   stateful service to deploy, back up, secure, and reason about. Two places where state
   lives means two consistency stories — a job can be enqueued in Redis for a transaction
   that then rolls back in Postgres.
2. **pg-boss** (MIT). Queue lives in Postgres, using `SKIP LOCKED`. Lower ceiling, but the
   ceiling is far above this workload.
3. **Hand-rolled polling table.** Fewer dependencies, but we would end up reimplementing
   pg-boss's retry/scheduling/locking semantics, badly.

## Decision

pg-boss. Postgres is already a required service, so the queue adds no new infrastructure:
one database to back up, secure, and grant least-privilege on (§8), and one place where
state lives.

The consistency property is the real reason. Enqueuing a job in the same Postgres
transaction as the domain write it follows means "asset updated" and "rollup scheduled"
commit or fail together. With Redis they cannot.

Redis/BullMQ is introduced only if a measured need appears — sustained throughput Postgres
cannot absorb, or fan-out across many workers. That requires a superseding ADR with the
measurement attached, per the brief.

Licence: pg-boss is MIT. Transitive tree is `pg` (MIT) and friends; the CI licence gate
(ADR-0003) verifies this.

## Consequences

- One fewer service in compose, the deploy, the threat model, and the runbook.
- Jobs are transactional with domain writes.
- Queue load shares the Postgres connection budget; worker concurrency must be sized
  against the DB connection pool rather than tuned independently.
- If throughput ever outgrows Postgres, migration to BullMQ is a real project. Judged
  unlikely at this scale, and the job-dispatch seam keeps the call sites stable.
