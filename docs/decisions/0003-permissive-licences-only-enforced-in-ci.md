# 3. Permissive licences only, enforced in CI

Date: 2026-07-16
Status: Accepted

## Context

ABeam owns the IP and will hand the source to Lablink with **zero copyleft obligation**.
A single GPL/AGPL/SSPL dependency — including one pulled in transitively, several levels
down, by a package that is itself MIT — could impose distribution obligations on the
delivered source. Reviewing this by eye at handover time is not credible: the transitive
tree runs to hundreds of packages and changes with every `pnpm install`.

The risk is asymmetric. A missed copyleft dependency is a legal problem discovered late;
a false positive is a five-minute conversation. So the gate should be strict by default and
loosened only by an explicit, recorded exception.

## Decision

Permissive licences only: MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, Unlicense, CC0-1.0,
Python-2.0, BlueOak-1.0.0. Everything else fails the build.

Enforcement is a **CI job that fails on any non-allowlisted licence in the entire
transitive tree**, run on every PR — not a checklist. `license-checker-rseidelsohn`
(BSD-3-Clause) produces the report; `scripts/check-licences.mjs` applies the allowlist so
the policy lives in our repo, in version control, rather than in a CI flag.

Each dependency's licence is stated in the ADR or commit that introduces it. Exceptions
require a new ADR naming the package, its licence, why no permissive alternative exists,
and why the obligation does not reach delivered source. There is currently no exception.

Note: this repo itself is Apache-2.0 (see `LICENSE`), which is permissive and compatible
with handover.

## Consequences

- Copyleft cannot enter the tree silently; the failure is at PR time, not at handover.
- Some otherwise-good packages are unavailable. Accepted — we prefer the standard library
  and a minimal dependency surface anyway (which also serves the §8 security posture).
- The allowlist needs occasional maintenance as new SPDX identifiers appear; a package with
  an unrecognised or missing licence field also fails, deliberately, and is resolved by
  reading its actual licence text and either allowlisting the SPDX id or dropping the package.
- Dual-licensed packages (`MIT OR GPL-3.0`) are treated as allowed only if a permissive
  option is present, since we may elect it.
