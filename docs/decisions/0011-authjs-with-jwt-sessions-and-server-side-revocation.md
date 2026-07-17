# 11. Auth.js v5 (beta), JWT sessions, revocation restored server-side

Date: 2026-07-16
Status: Accepted

## Context

Phase 1 needs authentication and RBAC across the six RFP Appendix F roles, replacing the
interim bearer token in `app/src/lib/api-auth.ts`. The brief specifies Auth.js, with a clean
seam to swap to OIDC/SAML (SAP IAS) later.

Two facts complicate this.

**Auth.js v5 is still beta.** `latest` on npm is v4.24.14; v5 has been at `5.0.0-beta.x` for
roughly two years and is currently beta.31. Shipping a beta as the authentication layer of a
healthcare client's system deserves a deliberate decision, not a default.

**Auth.js's Credentials provider only supports the JWT session strategy.** Database sessions
are unavailable with credentials — an Auth.js design constraint, not a configuration choice.
This matters: a stateless JWT cannot be withdrawn before it expires. Deactivate a user and
their token keeps working until it lapses. For a system holding an asset register, "the
sacked employee's session works until Friday" is not acceptable.

Options considered:

1. **Auth.js v4.** Stable, but its App Router support is a compatibility shim and Next 15 /
   React 19 support is uncertain. Trading a beta for a legacy path on an unsupported stack.
2. **Roll our own session auth.** ~150 lines, full control, no beta. But it is
   security-critical code we would have to write, defend at handover, and maintain — and it
   would put the OIDC migration entirely on us. Reinventing authentication is how projects
   acquire their most expensive bugs.
3. **Auth.js v5 beta, with revocation restored.** The de facto App Router standard; the
   OIDC/SAML swap is adding a provider rather than a rewrite.

## Decision

**Auth.js v5 (`next-auth@5.0.0-beta.31`, ISC), Credentials provider, JWT strategy.**

Beta is accepted because the alternatives are worse: v4 is a shim on an unsupported stack,
and hand-rolling auth for a healthcare client is a liability we would carry to handover and
beyond. v5's API has been stable across recent betas, it is very widely deployed in
production, and the version is pinned. The risk is real but bounded, and it is reviewed at
each phase gate.

**Revocation is restored server-side, since JWTs cannot be withdrawn.** On every request the
`jwt` callback re-reads the user and rejects the token unless `active` is true and
`tokenVersion` still matches the value the token was minted with. Bumping `User.tokenVersion`
invalidates every outstanding token for that user immediately.

This deliberately gives up the JWT's main advantage — statelessness — and costs one indexed
read per request. That is the correct trade. The system is 32 sites and a few hundred users;
we are nowhere near the scale where that read matters, and immediate revocation is not
negotiable for a client's asset register.

**Passwords: scrypt, from the Node standard library.** No dependency at all.

We chose Argon2id first — it is OWASP's _preferred_ KDF — and implemented it with
`@node-rs/argon2` (MIT). It did not survive contact with the build:

- Every Argon2 binding for Node ships a native `.node` binary. webpack cannot parse one, so
  any route importing it failed the build outright.
- Next's `serverExternalPackages` did not help. The module webpack actually resolves is the
  **platform-specific** subpackage (`@node-rs/argon2-linux-x64-gnu`), whose _name_ varies by
  architecture — pinning it would have broken the arm64/x64 Docker builds this is handed
  over as.
- It is unreachable from the Edge runtime entirely.

scrypt is memory-hard, OWASP-listed, and has none of those problems: zero dependencies, no
binary, works in any Node runtime, nothing to configure in the bundler. Parameters are
OWASP's strongest listed scrypt profile (N=2^17 / 128 MiB, r=8, p=1), ~400ms per hash — paid
only at sign-in, never on a request.

This is a small step down from OWASP's first choice, taken deliberately. The brief's "prefer
the standard library, keep dependencies minimal" points the same way, and a dependency we do
not have is one the client never has to patch. Hashes are self-describing
(`scrypt$N$r$p$salt$key`), so parameters can be raised — or the scheme migrated to Argon2id
if a pure-WASM binding matures — without invalidating existing credentials.

**The OIDC seam.** `User.externalId` holds the IdP subject claim and `passwordHash` is
nullable, so an IAS-provisioned user simply never has one. Switching to SAP IAS is adding an
OIDC provider to the Auth.js config and mapping claims to roles — the RBAC layer, the
session shape, and every call site stay as they are.

## Consequences

- Revocation works: deactivating a user or bumping `tokenVersion` takes effect on the next
  request, not at token expiry.
- One database read per authenticated request. Acceptable at this scale; if it ever is not,
  a short-TTL cache is the answer, not statelessness.
- We carry beta risk. Pinned exactly; revisit at each phase gate. A v5 stable release should
  be a routine bump.
- Local credentials are a Phase 1 measure. Lablink will federate to SAP IAS; this design
  makes that a provider swap rather than a migration.
- The `Session` model drafted for this ADR was removed before it shipped: database sessions
  are unusable with Credentials, and a table nothing writes to is worse than no table.
