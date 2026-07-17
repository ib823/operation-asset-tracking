# 9. SAP matching precedence (tag → serial → manual); unmatched go to a reconciliation queue

Date: 2026-07-16
Status: Accepted

Supersedes assumption A8 in `PROGRESS.md`. **Reverses** the auto-create behaviour shipped in
Phase 0 (`syncAssetMaster` → `created`).

## Context

The OAT and SAP hold records of the same physical assets and must be linked on a shared key
(`sapAssetNo`). The link has to be established before the key exists on our side, because
the two systems learn about an asset in a different order and for different reasons:

- Operations tags an analyser and puts it to work the week it arrives.
- Finance capitalises it later — sometimes much later.

So at tagging time there is no SAP asset number to link on. Something else has to bridge the
first join.

Phase 0 matched on `sapAssetNo`, falling back to serial number, and **created a local asset
whenever SAP knew something we did not**. That auto-create is wrong, and the demo shows
exactly why: syncing the mock master reports `created: 1`, silently inventing a
`SAP-100000010` asset with a fabricated tag for a rack that SAP records without a serial
number. Nobody asked for that asset. Nobody will ever scan that tag, because no such label
exists on a shelf anywhere. It is a fiction that looks like an asset.

The failure mode generalises. A misconfigured or partially-migrated SAP client would let the
nightly sync populate the operational register with hundreds of phantom rows, each one
looking exactly as legitimate as a real one. The register would be quietly poisoned by a
process running unattended at 2am, and the first symptom would be a stocktake that never
reconciles.

The underlying error is a category mistake: **SAP knowing about an asset is not evidence
that the asset is operationally tracked.** They are different facts about different things.

## Decision

**1. Matching precedence, in order:**

| #   | Match on                                                                 | Why here                                                                                                                                               |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | `sapAssetNo`                                                             | Already linked. Makes the sync idempotent; not really a "match" so much as a re-find.                                                                  |
| 1   | **Tag** — SAP's inventory number field against OAT `tag`                 | The strongest identifier: a human deliberately wrote it on both systems. An exact tag match is an intentional statement that these are the same asset. |
| 2   | **Serial** — manufacturer serial, matched only against _unlinked_ assets | The only identifier both systems hold independently. Bridges the first join for assets tagged before capitalisation.                                   |
| 3   | **Manual** — a human decides, via the reconciliation queue               | Where automation's confidence runs out.                                                                                                                |

Steps 1 and 2 only ever adopt an asset with `sapAssetNo = null`. An asset already carrying a
_different_ SAP number is a data conflict to investigate, never something to silently
re-point.

**2. Unmatched SAP records go to a reconciliation queue** (`ReconciliationItem`) for a human
to resolve. They are not created, not guessed at, not dropped.

**3. The OAT never creates assets — in either direction.**

- It does not create local `Asset` rows from SAP records. SAP's knowledge is not tagging.
- It does not create assets in SAP. There is no `CREATE` member in `SapOutboundEvent` and
  there will not be one; creating a fixed asset is a finance decision made in the financial
  system of record (ADR-0004).

## Consequences

- The register only ever contains assets a human tagged. That is the property that makes a
  stocktake meaningful, and it cannot be maintained by a process that can also invent rows.
- Unmatched records are **visible work**, not silence. A queue that grows is a signal —
  someone has an unlinked asset, or SAP has an asset nobody tagged, or a serial is
  mistyped. Each of those is a real thing worth a human's attention, and none of them should
  be resolved by a guess made at 2am.
- The sync's `created` counter disappears; `queued` replaces it. The Phase 0 e2e assertion
  on `created` changes accordingly.
- Someone must work the queue. An ignored queue is worse than no queue, because it looks
  like control while providing none. Phase 4 should alert on queue age, not just depth.
- Requires SAP's inventory-number field to be populated for tag matching to do any work. If
  Lablink does not populate it, precedence degrades to serial → manual, which still
  functions — just with more manual work. Worth raising with them, as populating it is cheap
  and removes reconciliation effort permanently.
