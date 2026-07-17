# 14. Idle config resolves below class: asset → sub-type → class → default

Date: 2026-07-17
Status: Accepted

Resolves assumption A13 in `PROGRESS.md`. Refines ADR-0008.

## Context

ADR-0008 made the idle definition per-`AssetClass`. A13 flagged the obvious strain: an
analyser and a microscope are both `LAB_INSTRUMENT`, and they are not remotely the same
question. An analyser quiet for two hours may be genuinely underused; a microscope quiet for
two hours is a Tuesday.

Two ways to fix this, and the tempting one is wrong.

**Subdivide the enum** — `LAB_INSTRUMENT_ANALYSER`, `LAB_INSTRUMENT_MICROSCOPE`, and so on.
This looks tidy and is a trap. `AssetClass` is a **shared vocabulary**: it maps to SAP asset
classes (ADR-0009), drives `activitySources` (ADR-0008), and appears in every report the
client reads. Splitting it to express an idle nuance means a migration, an SAP mapping
change, and a new enum member every time Lablink buys a kind of equipment we have not seen.
The enum would grow without bound, driven by a concern that has nothing to do with what the
enum is for.

The deeper point: **how granular "idle" needs to be is not knowable up front, and it differs
per client, per site, per machine.** Any fixed granularity we pick will be wrong somewhere.
So the answer is not to pick a better granularity — it is to stop picking one.

## Decision

Idle configuration **resolves down a chain**, most specific wins:

```
Asset override  →  Sub-type  →  Class  →  Built-in default
```

- **Asset** — `IdleConfig(scope: ASSET, key: assetId)`. For the one machine that genuinely
  is special. There is always one.
- **Sub-type** — `IdleConfig(scope: SUB_TYPE, key: "<class>:<subType>")`, where
  `Asset.subType` is **free text**, not an enum. "Analyser", "Microscope", "Centrifuge".
  Lablink names their own equipment; adding a sub-type is data entry, not a migration.
- **Class** — `IdleConfig(scope: CLASS, key: "<class>")`. What the HQ Lab Manager sets in
  the UI, and what ADR-0008 already describes.
- **Default** — `DEFAULT_IDLE_POLICY` in code. Provisional (A10), unchanged.

**`LAB_INSTRUMENT` stays a single class with one default.** The class-level default is the
sensible baseline; the nuance lives below it, where it belongs, and only for the assets that
actually need it. Most instruments will never have a sub-type row, and that is the point —
you configure the exception, not the taxonomy.

`activitySources` is deliberately **NOT** overridable below class. That is not a tuning knob:
it is the rule that stops a heartbeat being mistaken for use (ADR-0008), and the whole reason
instrument utilisation is trustworthy. Letting a per-asset override re-admit SNMP as
"activity" for one analyser would silently reintroduce exactly the fabricated-utilisation
failure ADR-0008 exists to prevent — for the asset someone cared enough to configure.

`thresholdMinutes` and `alertAfterMinutes` are overridable. Sources are not.

## Consequences

- The granularity question is answered by the client, per asset, without a code change — and
  answered lazily, only where it matters.
- `AssetClass` stays a stable vocabulary shared with SAP and with reporting, rather than a
  dumping ground for idle nuance.
- The resolver is a pure function over a small config set, so the engine stays testable and
  the chain is one obvious place to reason about.
- Cost: four places a threshold can come from. Mitigated by the UI showing the **resolved**
  value and where it came from — a number whose origin you cannot see is a number nobody
  trusts. "120 min (from class default)" is very different from "120 min (set on this asset)".
- Cost: `IdleConfig` rows must be loaded to project an asset. Small, cacheable, and read once
  per rollup or sweep rather than per asset.
- A sub-type typo silently means "no sub-type config" rather than an error. Acceptable: the
  fallback is the class default, which is correct-by-construction, and the UI surfaces the
  resolved source so a typo shows up as "from class default" where the user expected
  otherwise.
