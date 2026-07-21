# 22. An operational status must be observation-backed; unobserved is not "in use"

Date: 2026-07-21
Status: Accepted

Relates to ADR-0006 (signals are the source of truth; status is derived), ADR-0008 (never
claim activity we did not observe), ADR-0010 (scan vs telemetry precedence), ADR-0015
(absence of data is not zero).

## Context

The OAT is scrupulous about utilisation: no coverage → no snapshot → the UI says "not
measured", never 0% (ADR-0015). A live review found the **status** field quietly breaking that
same contract. The seed wrote `status: IN_USE` as a literal on every asset, and the engine's
`project()` _holds the current status_ when there is no telemetry verdict and no scan. So an
asset that had never been observed — no signal, `lastSeenAt = null` — displayed a confident
green **In use**, presented with exactly the authority the rest of the UI reserves for measured
facts.

That is the product's own honesty ethos cracking in one place: a sharp evaluator can ask "how
do you know it's in use if you've never seen it?" and the honest answer would have been "we
don't — the seed said so."

Two fixes were on the table:

- **(a)** Make the seed observation-backed: seed a real signal behind every asset's status (a
  human scan is the fallback-floor observation), and let the engine derive the status — so
  "In use" is always something a person or a connector actually reported.
- **(b)** Introduce an explicit **UNOBSERVED / UNKNOWN** status, distinct from IN_USE/IDLE, for
  any asset with no signal and no scan — so status carries the same observed-vs-assumed
  provenance the utilisation figure already does.

## Decision

**Do (a) now; adopt (b) as the rigorous product direction, to implement next.** Confirmed with
the product owner before merging, because it changes what a status _means_.

### (a) — implemented now

`seedDemoSignals` (`packages/seed/src/demo-signals.ts`) seeds real signals and derives all
state through the **same engine the live system uses** — `ingestSignals` → `reprojectAsset` →
`recordIdleAlert`, then `rollUpDay`. No status literal, no utilisation literal:

- Every asset gets a backing observation: a recent human **scan** (IN_USE, within TTL) for
  instruments/scanner/rack; a **SOTI** idle report for the two IT endpoints; **SNMP** page-count
  history for the printer. `lastSeenAt` is therefore never null, and the displayed status is
  always something that was reported.
- The seed no longer writes `status`; the column's `@default(IN_USE)` only bootstraps it before
  the first projection overwrites it.
- Idle, the idle **alert**, and the printer's **utilisation %** all fall out of the engine from
  those signals — they are computed, not seeded numbers. A regression test
  (`e2e/phase4-demo-honesty.spec.ts`) asserts the status is observation-backed and that the % is
  genuinely `busy/observed`, so a future literal reintroduction fails CI.

This is honest, not a workaround: in a real deployment the register is populated by exactly
these signals — a barcode scan is how an asset enters the operational picture (the fallback
floor), and every asset is scanned before it is trusted.

### (b) — the rigorous direction (not yet built)

Add an explicit `UNOBSERVED` operational status, surfaced with provenance ("no observation
yet"), distinct from IN_USE/IDLE, for assets with no signal and no scan. Then `project()`
returns `UNOBSERVED` instead of holding a stale `current.status`, and the DB default stops
being IN_USE. This makes an un-scanned, un-monitored asset render as honestly unknown — the
status-field analogue of "not measured".

It is deferred, not dismissed, because it is a genuine product-meaning change touching the
status enum, the engine, every status render and their tests, and the write-back/dashboard
aggregates. (a) removes the dishonesty for the demo today; (b) removes the _possibility_ of it
for good, and should be scheduled as its own change.

## Consequences

- The demo shows only statuses a person or connector reported; the "In use" count reflects
  observation-backed statuses only.
- The seed exercises the real engine, so the seeded state cannot drift from what the live
  pipeline would produce — the strongest guarantee that the demo is truthful.
- Until (b) ships, an asset created with **no** signal would still default to IN_USE. That path
  does not occur in the seed (every asset is observed) and is the exact gap (b) closes; it is
  recorded here so it is a known, scheduled item rather than a latent surprise.
