# 16. Sign-out revokes the token; clearing the cookie is only a courtesy

Date: 2026-07-17
Status: Accepted

Refines ADR-0011. Fixes a real, intermittent authentication bug found during Phase 2
verification.

## Context

Sign-out was a server action calling Auth.js's `signOut({ redirectTo: '/signin' })`. It
looked correct, it passed review, and its e2e test passed — most of the time.

The test was intermittently failing. The tempting reading was "flaky test": it passed in
isolation and failed in the full suite, which is the classic signature of a timing artifact.
Adding a wait made it pass. That would have been the end of it.

It was not a flaky test. Probing the actual property — _does the register render to a
signed-out user?_ — over eight iterations:

```
cookieRemained = 4/8      DATA LEAKS = 4/8
```

**In half of all sign-outs, the session cookie survived and the full asset register rendered
to a user who had just signed out.** The correlation was exact: whenever the cookie
survived, the data rendered. The user clicks "Sign out", lands on the sign-in page, believes
they are out — and their session is live. On a shared lab workstation, the next person
presses Back and reads the register.

The cause is a race inherent to rolling JWT sessions. Auth.js refreshes the session cookie on
activity, so a concurrent request (a prefetch, an RSC fetch, the layout re-rendering) can run
`auth()` and **re-write the cookie after the sign-out deleted it**. Whether the deletion or
the refresh lands last is a coin flip.

Switching from `redirectTo` to `signOut({ redirect: false })` plus an explicit `redirect()`
improved it to 2-in-8. Still a coin flip, just a better-weighted one. **No amount of care in
deleting the cookie fixes this**, because the problem is not the deletion — it is that
something else legitimately writes the cookie back.

There is a second, worse lesson. My first probe sliced the page body to 200 characters and
_then_ searched it for asset tags — so it only ever inspected the nav bar and reported
`DATA LEAKS = 0/8` while four leaks were happening in front of it. A test that measures
nothing reads exactly like a test that passes.

## Decision

**Sign-out revokes the token server-side. Clearing the cookie is a courtesy on top.**

The sign-out action bumps `User.tokenVersion` (`revokeSessions`) before calling `signOut`.
The `jwt` callback already re-reads the user and rejects any token whose `tokenVersion` no
longer matches (ADR-0011), so a cookie that survives the race is **worthless**: the very next
request rejects it.

This makes the outcome independent of the race, rather than trying to win it. The cookie
still survives sometimes — measured at 3/8, 1/8, 1/8 across runs after the fix — and it no
longer matters. Data leaks: **0/8, every run**.

**Consequence accepted: signing out on one device signs you out everywhere.** Bumping
`tokenVersion` invalidates every outstanding token for that user. For a lab asset register on
shared workstations this is a reasonable default, and arguably the expected one. Per-session
revocation would need a token-id blocklist — more machinery, for a benefit this client has
not asked for. If Lablink later wants per-device sessions, that is the ADR to write.

**The test asserts the property, not the mechanism.** It checks that the register does not
render and the API returns 401 — not that the cookie is gone. A test asserting the cookie's
absence would fail on the surviving-cookie race _while access was correctly denied_, and
someone would eventually "fix" it by weakening it.

## Consequences

- Sign-out means the session is dead, not merely forgotten. That is what users assume it
  means, and now it is true.
- The revocation mechanism built in ADR-0011 for deactivating users turned out to be the
  thing that makes sign-out correct. Worth noting: it was built for a different reason and
  paid for itself here.
- Cost: one write per sign-out, and sign-out is global across a user's devices.
- Cost: `revalidate` on every request is now load-bearing for sign-out, not only for
  deactivation. Caching it later must keep TTLs short, or sign-out becomes eventually
  consistent — which is exactly the bug this ADR fixes, reintroduced as a performance
  optimisation.
- **The general lesson, and it keeps recurring here:** an intermittent test failure on a
  security path deserves a probe, not a wait. This bug was one `await` away from being
  papered over permanently, and it would have shipped. Verify the property; and check that
  the probe itself can actually see the thing it claims to measure.
