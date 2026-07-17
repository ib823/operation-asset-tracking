# 23. Security hardening: what we did, and the gaps we are naming rather than hiding

Date: 2026-07-17
Status: Accepted

## Context

The RFP (§5.x, §4.x, 1.41) asks for a hardened SDLC and a defensible security posture. Phase
4 is the hardening pass. The temptation in a hardening pass is to produce a list of things
that were done, because a list of things that were done looks complete.

The useful artefact is the opposite: what was done, **and what was deliberately not done, and
why**. A gap the client knows about is a risk decision. A gap nobody wrote down is a
surprise at penetration-test time — and the client's auditor will find it either way.

## Decision

### Applied

**Security headers on every response, from middleware.** Not per-route: a per-route approach
forgets the 404 and the error page, which is exactly where you would rather it did not.
`X-Frame-Options: DENY` and `frame-ancestors 'none'` (the OAT is never embedded);
`nosniff`; `Referrer-Policy: same-origin` (an OAT URL carries an asset id, which should not
travel to a third party); a `Permissions-Policy` denying camera/mic/geolocation/payment/USB,
none of which we use — so a future dependency cannot quietly start using one.

**A restrictive CSP.** `default-src 'self'`, no third-party anything. The OAT loads no CDN
scripts, no remote fonts, no external images by design — a register of laboratory assets has
no business talking to a CDN, and `'self'` means a future dependency that tries is blocked
rather than merely discouraged. `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`.

**HSTS set unconditionally**, not gated on `request.protocol === 'https'`. Behind a
TLS-terminating proxy the app sees plain HTTP, so a conditional check would silently never
fire. That is the same proxy blindness that produced ADR-0012 and the localhost-redirect bug;
having been caught by it twice, we do not write that check again. Browsers ignore HSTS on
non-secure responses, so it is harmless when there is no proxy.

**Sign-in rate limiting.** 10 attempts per 15 minutes per email. scrypt makes each attempt
cost ~400ms, which is a speed bump and not a limit: a modest word list and a weekend still
buys tens of thousands of tries, and this estate's emails are `firstname@lablink.example` —
the email half is not a secret. Every attempt counts, not just failures, or an attacker
interleaves a known-good credential to keep their bucket clear. Cleared on success, so a user
who fat-fingers their password twice is not locked out by their own success.

**Authentication events in the audit log.** `AUTH_SIGN_IN_SUCCEEDED`, `AUTH_SIGN_IN_FAILED`,
`AUTH_SIGNED_OUT`, `AUTH_TOKEN_REJECTED`. This was a real gap: the audit trail covered "who
changed this asset" but not "who tried to get in". A failed sign-in is the single most useful
line in a security log — one is a typo, two hundred is an attack, and neither was visible.
The attempted email is recorded even when no such account exists, because _that is the
signal_; the failure reason is deliberately uninformative, so the log cannot become a way to
discover which accounts are real.

**A SIEM export** (`/api/audit/export`): NDJSON, cursor-paginated, `audit:read` only.

**A route/page disclosure test** that discovers routes from the filesystem and fails when a
new one appears without a stated expectation.

### Known gaps — named deliberately

**1. CSP allows `'unsafe-inline'` for scripts.** Next's App Router inlines the RSC payload and
bootstrap into the HTML. The correct fix is a per-request nonce, which Next supports and which
forces every page onto dynamic rendering. We have not measured that cost against this estate's
traffic, and guessing at it would be worse than saying so. `'unsafe-eval'` is **not** allowed.
Revisit with the design-system work, when the pages are being touched anyway.

**2. Rate limiting is in-memory and per-process.** With N replicas an attacker gets N× the
attempts, and a restart forgets everything. Redis would fix it and ADR-0005 rejected Redis as
a datastore we would have to run, secure and back up — that reasoning has not changed for a
counter with a 15-minute memory. Postgres could hold it, but a write per failed sign-in lets
an attacker generate our database load for free. **This is sized for opportunistic password
spray from one source, which is what actually happens.** A determined distributed attack is
the load balancer's problem (A5) and belongs in front of the app. Stated so nobody mistakes
the speed bump for a wall.

**3. No CSRF token on server actions beyond Next's own origin check.** Next compares `origin`
against `x-forwarded-host` and aborts on mismatch — which is real protection, and which we
had to configure carefully to work behind a proxy (`OAT_ALLOWED_ORIGINS`). Sessions are
`SameSite=Lax` cookies. This is the framework's designed posture; adding a second token
mechanism on top would be duplicated machinery without a named threat it addresses.

**4. No account lockout, only rate limiting.** Deliberate: lockout is a denial-of-service
vector against a known email list, and this estate's emails are guessable. An attacker who
cannot guess a password can still lock out every user in the building.

**5. The database user is not least-privilege.** Prisma migrations need DDL. Production should
run migrations as a migrator role and the app as a role with DML only. That is a deploy-time
split (A5), documented in the runbook rather than encoded here — we do not know the hosting
shape yet, and inventing one would be fiction.

**6. No dependency CVE scan in CI.** The licence gate is not a vulnerability gate. `pnpm audit`
belongs in CI; it is not there yet, and it will produce findings that need triage rather than
a green tick. Recorded rather than bolted on at the end of a phase.

**7. Secrets are environment variables.** Correct for compose; a real deployment should use
the platform's secret manager. Again a deploy-time decision (A5), in the runbook.

## Consequences

- The posture is defensible and, more importantly, **legible**: an auditor gets the gaps from
  us rather than finding them.
- Six named gaps are follow-on work with a stated rationale, not oversights.
- The two most likely real attacks on this system — password spray against known emails, and
  a stolen session — are addressed (rate limiting + audit; server-side revocation, ADR-0011
  and ADR-0016).
- Nothing here substitutes for a penetration test before go-live. This is the floor.
