# 12. Pages and routes enforce their own access; middleware is an optimisation

Date: 2026-07-17
Status: Accepted

## Context

This ADR exists because of a bug we shipped into the working tree and caught during Phase 1
verification. It is worth recording exactly, because the lesson is not obvious and the
failure was silent.

The Phase 1 design put a default-deny gate in Next middleware: every path except an
allowlist required a session. The middleware was written correctly, built correctly, and
registered with the right matcher. And the asset register was served, in full, to an
unauthenticated caller.

The cause: Auth.js v5 refuses to trust the request host in production unless `AUTH_TRUST_HOST`
or `AUTH_URL` is set. Without it, `auth()` threw `UntrustedHost` **inside the middleware**.
Next caught the error and continued to the route.

**The middleware failed open.** Not "denied the request"; not "returned a 500". It stopped
gating, and the pages behind it rendered exactly as if the gate had approved them. The only
visible symptom was a log line among many, on a system that otherwise looked healthy. Every
page still loaded, so nothing looked wrong.

The verification that found it was checking a specific claim — "an unauthenticated caller
cannot list assets" — with curl, rather than confirming that the middleware file existed and
the tests passed. Both of those were true the entire time the register was exposed.

The general principle: **a security boundary that can silently stop being a boundary is not
a boundary.** Middleware sits _in front of_ the thing it protects, which means anything that
takes it out of the path — a thrown error, a matcher typo, a runtime mismatch, a future Next
change to error semantics — removes the protection without removing the appearance of it.

## Decision

**Every protected page and every API route enforces its own authentication, permission, and
site scope.** Not in addition to a comment saying middleware handles it — as the actual,
load-bearing check.

- Pages call `requirePermission(permission, from)` (`app/src/lib/page-auth.ts`), which
  resolves the principal or redirects.
- API routes call `requirePermission(permission)` (`app/src/lib/api-auth.ts`), which returns
  a 401/403 response or a principal.
- Site scoping narrows the **query** (`scopeToSite`), so a scoped user's request cannot
  select another site's rows in the first place.

**Middleware is retained, but demoted to an optimisation.** It saves a render and gives a
clean redirect for a signed-out human. It is not relied upon. If it vanished entirely,
nothing would be exposed — verified by neutering it and re-checking: `/assets` still returns
307 to `/signin` and leaks nothing.

**`AUTH_TRUST_HOST` is set explicitly** in compose, the deploy notes, and `.env.example`,
with a comment saying why. That fixes the specific trigger. The architectural change above
is what makes the next trigger — whatever it turns out to be — survivable.

## Consequences

- Access control is enforced where the data is read, which is the only place that cannot be
  bypassed by something upstream failing.
- Cost: one explicit call per page and per route, and the discipline to remember it. A new
  page that forgets it is unprotected — which is the honest trade for not depending on a
  gate that can silently disappear. Phase 4 hardening should add a test that enumerates
  routes and asserts each rejects an anonymous caller, so "forgot to add it" fails CI rather
  than fails quietly.
- The defence-in-depth claim is tested by deliberate falsification (disable middleware, curl
  the page), not asserted. It should be re-verified whenever the auth stack is upgraded —
  Auth.js v5 is beta (ADR-0011) and its error behaviour may change.
- Reinforces a rule for the rest of this project: verify the property (can an anonymous
  caller read this?), never the mechanism (does the middleware file exist?). The mechanism
  was flawless while the property was false.
