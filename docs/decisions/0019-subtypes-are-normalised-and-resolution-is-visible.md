# 19. Sub-types are normalised on write, and the applied resolution level is visible

Date: 2026-07-17
Status: Accepted

Refines ADR-0014.

## Context

ADR-0014 made `Asset.subType` free text, deliberately: it is what lets Lablink name their own
equipment without a migration, and it keeps `AssetClass` a stable vocabulary shared with SAP.

Free text has a cost, and ADR-0014 acknowledged it and then waved it through:

> A sub-type typo silently means "no sub-type config" rather than an error. Acceptable: the
> fallback is the class default, which is correct-by-construction.

That reasoning is right about the _fallback_ and wrong about the _consequence_. The fallback
is safe; the **silence** is not.

Consider an HQ manager who sets "Microscope" to 8 hours, then tags an asset `microscope` — or
`Microscope ` with a trailing space, which a barcode scanner or a paste from a spreadsheet
will happily produce. The config no longer matches. The asset falls back to the
`LAB_INSTRUMENT` class default of 120 minutes. The dashboard shows a perfectly plausible
number. The manager believes their 8-hour rule is in force. It is not, and **nothing anywhere
says so** — the only evidence is a number that looks exactly as reasonable as the right one.

That is the worst kind of wrong: not an error, not a gap, but a confident answer to a
different question. And the estate has ~thousands of assets across 32 sites; nobody is
diffing config keys against asset fields by eye.

Two independent problems, needing two fixes:

1. **Near-miss sub-types should not exist.** " Analyser", "analyser" and "ANALYSER" are one
   sub-type that a human typed three ways, not three sub-types.
2. **A fall-back should be visible.** Even with normalisation, a genuine typo ("Micrscope")
   will still fall back — and the user must be able to see that it did.

## Decision

**1. Normalise on write.** `normaliseSubType` trims, collapses internal whitespace, and
case-folds to a canonical Title Case form. Applied wherever a sub-type is stored (the seed,
and the sub-type key in the idle-config API). Title Case rather than lowercase because this
is a value shown to humans, not just a lookup key.

**2. Match case-insensitively on read.** A config row written before normalisation existed
still matches. Cheap insurance against exactly the class of drift this ADR is about.

**3. Show the applied resolution level on the asset view.** The asset page renders the
resolved idle threshold _and where it came from_: "set on this asset", "set for this
sub-type", "set for this class", or "provisional default" — the last styled as a warning,
consistent with the idle-policy page.

That fourth label is the point. A manager who expected their sub-type rule to apply sees
**"provisional default"** on the asset and knows immediately that something did not match.
The typo becomes visible at the moment someone looks at the asset, rather than never.

**4. The API still rejects a sub-type key no asset matches** (from Phase 2), now
case-insensitively. Normalisation prevents near-misses; this catches real typos at write
time; the visible resolution level catches whatever gets through both.

## Consequences

- A mistyped sub-type surfaces as "provisional default" where a user expected otherwise,
  instead of being invisible forever.
- Sub-types stay free text — the property ADR-0014 exists to preserve — while the accidental
  duplicates that free text invites are removed.
- The asset page now also shows `activitySources`, which answers the question the resolution
  level provokes next: _why does this instrument show no utilisation?_ Because nothing feeds
  it yet (ADR-0008).
- Cost: normalisation is lossy. An operator who genuinely wants "pH Meter" gets "Ph Meter".
  Accepted — the alternative is honouring capitalisation nobody agreed on, and the display
  form is cosmetic where the matching is what matters. If a client cares, the canonical form
  is one function.
- Existing rows are not migrated. Read-side case-insensitive matching means they still
  resolve; new writes are canonical. A backfill would be a one-liner if the mixture ever
  becomes confusing to look at.
