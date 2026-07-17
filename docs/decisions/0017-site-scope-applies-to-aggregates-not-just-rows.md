# 17. Site scope applies to aggregates, not just rows; all-sites needs an explicit grant

Date: 2026-07-17
Status: Accepted

Refines ADR-0012. Fixes a real data leak found in live review.

## Context

Site scoping was implemented on the register: `listAssets` narrows the query by `siteId`, and
a BRANCH user querying `/api/assets` sees only their own site. That was tested, and it works.

The **dashboard was never scoped at all.** `siteStatusBreakdown` took no scope and grouped
across every site. Signed in as `branch.kl` (KL01, 4 assets), the register correctly showed 4
assets at KL01 — while the dashboard showed:

- `total-in-use = 10` — every asset in the estate
- site rows for **JB03, KL01 and PJ02** — the names, codes and per-site counts of two sites
  they have no business seeing
- "Operational status across 3 sites"

So a branch user could not list another site's assets, but could read that site's name, its
asset count, and how much of it was idle. That is a real leak, and utilisation is exactly the
figure that drives disposal decisions — one branch reading another's is a political problem
as well as a privacy one.

The bug is instructive about _why_ it happened. Scoping was applied where the data looked
like the sensitive thing — the rows. Aggregates felt like a summary, and a summary feels
harmless. It is not: a count is a fact about the rows, and if the rows are confidential the
count derived from them is too. **Every read path needs the scope, not just the ones that
return the records themselves.**

There was a second, quieter problem. `scopeToSite` decided who was cross-site from a
**hardcoded role list** inside the function:

```ts
const crossSite: Role[] = ['FINANCE', 'HQ_LAB_MANAGER', 'IT', 'DEVELOPER', 'PURCHASING']
```

That list is a permission decision, hidden in a helper, invisible in the RBAC matrix the
client reviews. Anyone reading `MATRIX` in `packages/auth/src/rbac.ts` to answer "who can see
the whole estate?" would find no answer there — and would be wrong to conclude nobody can.

## Decision

**1. Seeing the whole estate is an explicit permission: `site:read:all`.**

It lives in the RBAC matrix with everything else, so the client can review it on one screen.
Granted to FINANCE, PURCHASING, HQ_LAB_MANAGER, IT and DEVELOPER; **not** to BRANCH.

`scopeToSite` now derives from that permission rather than a hardcoded list. The role list and
the matrix cannot drift apart, because there is only one of them.

**2. Site scope applies to every read path, including aggregates.**

`siteStatusBreakdown` and `siteUtilisation` take a `SiteScope` and narrow the query — they do
not filter after the fact. A scoped user's dashboard shows only their site: the KPI totals sum
only their assets, only their site row renders, and the subtitle counts only the sites they
are authorised for.

**3. The subtitle counts authorised sites, not global ones.** "Operational status across 1
site" for a branch user. Telling them there are 3 sites is itself a disclosure, and a small
one, but it is the kind that reveals the shape of an estate you are not cleared for.

## Consequences

- The dashboard tells a branch user the truth about their own site and nothing about anyone
  else's.
- Who can see the whole estate is answerable by reading the RBAC matrix — which is the point
  of having one.
- Cost: every aggregate function now takes a scope parameter. That is deliberate friction: a
  new aggregate cannot be written without confronting the question, and `SiteScope`'s
  three-way shape means the compiler forces the deny case to be handled.
- This is the second scope bug of the same family. The first was `scopeToSite` returning
  `null` for both "unrestricted" and "restricted to nowhere" (fail-open for a misconfigured
  branch user). Both were invisible in review and obvious the moment someone signed in as a
  branch user and looked. **Phase 4 hardening should add a test that signs in as each role
  and asserts what every page discloses**, rather than testing routes one at a time — the
  leak was never in a route, it was in what a page chose to render.
