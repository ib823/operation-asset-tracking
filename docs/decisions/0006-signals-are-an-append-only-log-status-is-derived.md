# 6. Signals are an append-only log; status is derived

Date: 2026-07-16
Status: Accepted

## Context

Connectors report what they observed: a heartbeat, an idle period, a scan at a bench, a
printer page count. The OAT must turn that into the operational picture RFP 2.6.4 asks for
— status, idle time, utilisation — and must be able to defend those numbers to a client
who asks "why does the dashboard say this analyser was idle for six days?"

Two shapes were considered.

1. **Mutate the asset in place.** A connector writes `status = IDLE`, `idleSince = ...`
   directly. Simple and fast to read. But the observation is destroyed by the write: only
   the conclusion survives. Recomputing after an idle-threshold change is impossible, and
   two connectors disagreeing about the same asset is a last-writer-wins race with no trace.
2. **Append observations; derive state.** `SignalEvent` rows are immutable facts.
   `Asset.status`, `idleSince`, `lastSeenAt` are a derived projection maintained by the
   idle engine.

Three forces decide it. The idle definition is **not yet known** (assumption A1 in
`PROGRESS.md`) — the client will tell us later, per asset class, and will change their mind.
Connectors are unreliable and **arrive late or out of order** — an MDM offline for an hour
then flushing a backlog must not be read as an hour of idleness. And RFP 1.41 wants an
audit trail: a derived number is defensible only if the inputs still exist.

## Decision

`SignalEvent` is append-only and immutable — never updated, never deleted by application
code. It carries both `observedAt` (when the world did the thing) and `ingestedAt` (when we
heard about it), because the gap between them is exactly what late-arriving telemetry looks
like, and reasoning about idleness requires `observedAt`.

`Asset.status` / `idleSince` / `lastSeenAt` are a **projection**, maintained by the idle
engine in `packages/core`. Connectors never write asset state directly; they emit signals
and the engine decides. That makes conflict resolution one auditable function rather than a
race between adapters, and it is what lets an operator's scan authoritatively override a
stale MDM heartbeat.

The engine's core is a **pure function** of (signals, idle policy) → state, so it is
testable without a database and re-runnable over history when the policy changes.

`UtilisationSnapshot` is a **cache of a derivation**, not a source of truth — rollups can
always be rebuilt from the log.

This is CQRS/event-sourcing applied narrowly to the signal path only. The register itself
(create asset, assign custodian) stays plain CRUD with an `AuditLog`; event-sourcing the
whole domain would buy nothing and cost a lot.

## Consequences

- Changing the idle definition is a recompute, not a data migration with lost history.
- Out-of-order and duplicate signals are handled in one place, by design rather than luck.
- Utilisation figures are defensible to the client and to audit: the inputs are still there.
- Cost: `SignalEvent` is the high-volume table and grows without bound. It needs an index on
  `(assetId, observedAt)` and, before rollout, a retention/partitioning policy — raw signals
  can be aged out once snapshots cover the period. Flagged for Phase 4.
- Cost: reads of "current status" must hit the projection, so the projection must be kept
  correct. A rebuild path is therefore not optional — it is the recovery mechanism.
