# 1. Record architecture decisions

Date: 2026-07-16
Status: Accepted

## Context

ABeam owns the IP in this codebase and will eventually hand the source to Lablink. We need
a durable provenance trail showing that each non-obvious design choice was reasoned about
independently — this is both good engineering practice and evidence supporting the
clean-room claim (`CLAUDE.md` → Guardrails).

Sessions are also discontinuous: a future session must be able to reconstruct _why_ the
system looks the way it does without re-litigating settled decisions.

## Decision

Record every non-obvious architectural decision as an Architecture Decision Record in
`docs/decisions/`, numbered sequentially, in the Nygard format: Context → Decision →
Consequences. Status is one of Proposed / Accepted / Superseded by ADR-NNNN.

An ADR is required when a choice: (a) is hard to reverse, (b) constrains other modules,
(c) deviates from the brief in `CLAUDE.md`, or (d) records a licence assessment for a new
dependency.

## Consequences

- Provenance is auditable per decision, with a date.
- Superseding is explicit — ADRs are never edited to change their meaning, only marked
  superseded and replaced.
- Small cost per decision; accepted deliberately.
