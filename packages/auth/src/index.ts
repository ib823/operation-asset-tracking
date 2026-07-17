/**
 * Pure authorisation policy: roles, permissions, site scoping, audit.
 *
 * Deliberately free of crypto and IO. Password hashing and credential verification live in
 * `@oat/auth/server`, because they pull argon2's native `.node` binary — which webpack
 * cannot bundle, and which has no business being reachable from a route that only wants to
 * ask "may this user read assets?".
 *
 * The split is also honest about the layering: this half is a pure function of a principal,
 * and is testable without a database or a hash.
 */
export * from './rbac'
export * from './audit'
