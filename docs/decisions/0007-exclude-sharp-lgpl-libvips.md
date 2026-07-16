# 7. Exclude `sharp` — its libvips binary is LGPL

Date: 2026-07-16
Status: Accepted

## Context

The licence gate (ADR-0003) failed on its first real run against the dependency tree:

```
@img/sharp-libvips-linux-x64@1.2.4 — LGPL-3.0-or-later
```

`sharp` is Next.js's image optimiser. We never declared it: Next lists it as an **optional
dependency**, so `pnpm install` pulled it in silently. `sharp` itself is Apache-2.0, but the
prebuilt libvips binary it ships is LGPL-3.0-or-later.

This is precisely the scenario ADR-0003 was written for — copyleft arriving transitively,
several levels down, via a permissively licensed parent that nobody in the project chose to
depend on. It would not have been caught by reading our own `package.json`.

The brief names GPL / AGPL / SSPL explicitly. LGPL is not on that list, but the brief's
operative rule is that the build fails on **any copyleft transitive dependency**. LGPL is
copyleft: weaker than GPL (dynamic linking does not force disclosure of our source), and
arguably survivable for a separately-distributed native binary. But "arguably survivable"
is not the standard we were given. ABeam hands this source over with **zero** copyleft
obligation, and an argument we would have to make to the client's lawyers is already a cost.

Options:

1. **Exempt it.** Argue the LGPL obligation does not reach our source. Cheap now; leaves a
   question to answer at handover, and sets the precedent that the gate is negotiable.
2. **Replace the optimiser.** Nothing to replace it with that would be better.
3. **Drop the dependency.** Available only if we do not need it.

## Decision

Exclude `sharp` from the install entirely, via `ignoredOptionalDependencies` in
`pnpm-workspace.yaml`, and set `images.unoptimized` in `next.config.mjs` to match.

The deciding fact is that **we do not need it**. The OAT renders an asset register: text,
tables, and status badges. There are no user-uploaded photographs, no remote images, no
media of any kind in the product. `sharp` was optimising nothing. Carrying a copyleft
obligation for a feature we do not use is a bad trade at any exchange rate.

The first exception to the licence gate should not be a dependency nobody asked for.

## Consequences

- The production tree is 58 packages, all permissive: MIT, Apache-2.0, BSD-2/3-Clause, ISC,
  0BSD, CC-BY-4.0. No exception was needed, and `EXCEPTIONS` in `scripts/check-licences.mjs`
  stays empty.
- `next/image` will not optimise images. If a future phase genuinely needs image handling
  (an asset photograph on a detail page is plausible), this must be revisited with a
  superseding ADR — the options then are a permissive encoder, an external service, or
  accepting unoptimised images. Do not simply re-add `sharp`.
- The gate proved itself on day one, which is the strongest argument for having built it
  before writing feature code rather than after.
- `caniuse-lite` (CC-BY-4.0, via Next) is allowed: attribution-only, not copyleft, and it
  imposes no obligation on our source.
