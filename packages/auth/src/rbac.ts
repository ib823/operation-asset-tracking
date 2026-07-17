import type { Role } from '@oat/db'

/**
 * RBAC per RFP Appendix F.
 *
 * Permissions are compiled in, not stored: the role set comes from the RFP, so granting
 * yourself a permission should be a reviewed diff, not an UPDATE nobody sees. This is also
 * what makes the matrix below reviewable by the client in one screen.
 */

/**
 * A permission is a capability, named for what it lets you do — not for the endpoint that
 * happens to expose it today. Routes get renamed; capabilities do not.
 */
export type Permission =
  // Register
  | 'asset:read'
  | 'asset:create'
  | 'asset:update'
  | 'asset:retire'
  // Operational capture — the fallback floor
  | 'scan:submit'
  | 'asset:assign'
  // Reporting
  | 'utilisation:read'
  | 'idle-policy:manage'
  // SAP
  | 'sap:sync'
  | 'sap:writeback:propose'
  | 'sap:writeback:approve'
  | 'reconciliation:read'
  | 'reconciliation:resolve'
  // Platform
  | 'connector:manage'
  | 'user:manage'
  | 'audit:read'

/**
 * Role → permissions, per RFP Appendix F.
 *
 * Read across a row to check a role against the RFP. Deliberately explicit rather than
 * derived from a hierarchy: role hierarchies invite "X is just Y plus a bit", and that is
 * how Purchasing quietly acquires the ability to approve disposals.
 */
const MATRIX: Record<Role, readonly Permission[]> = {
  /**
   * Finance owns the financial record and therefore approves what reaches SAP. Read-only on
   * operations: they consume utilisation to make disposal decisions but do not run the labs.
   */
  FINANCE: [
    'asset:read',
    'utilisation:read',
    'sap:writeback:propose',
    'sap:writeback:approve',
    'reconciliation:read',
    'reconciliation:resolve',
    'audit:read',
  ],

  /** Purchasing needs acquisition and vendor detail. No approval rights, no operations. */
  PURCHASING: ['asset:read', 'asset:create', 'asset:update'],

  /**
   * Branch staff work their own site: scan, move, assign, flag for repair. Scoped to
   * `user.siteId` — see `scopeToSite`. No cross-site visibility, no SAP.
   */
  BRANCH: ['asset:read', 'asset:update', 'scan:submit', 'asset:assign'],

  /**
   * The HQ Lab Manager is the primary consumer of the OAT: utilisation and idle across all
   * 32 sites, and ownership of what "idle" means per class (ADR-0008).
   */
  HQ_LAB_MANAGER: [
    'asset:read',
    'asset:update',
    'scan:submit',
    'asset:assign',
    'asset:retire',
    'utilisation:read',
    'idle-policy:manage',
    'sap:writeback:propose',
    'reconciliation:read',
  ],

  /** IT runs the integrations, not the asset decisions. */
  IT: ['asset:read', 'utilisation:read', 'connector:manage', 'sap:sync', 'user:manage', 'audit:read'],

  /** Developer: everything, including the reconciliation queue. */
  DEVELOPER: [
    'asset:read',
    'asset:create',
    'asset:update',
    'asset:retire',
    'scan:submit',
    'asset:assign',
    'utilisation:read',
    'idle-policy:manage',
    'sap:sync',
    'sap:writeback:propose',
    'sap:writeback:approve',
    'reconciliation:read',
    'reconciliation:resolve',
    'connector:manage',
    'user:manage',
    'audit:read',
  ],
}

/** The authenticated caller, as every permission check sees them. */
export interface Principal {
  id: string
  email: string
  roles: Role[]
  /** Set for BRANCH users; null for roles that span sites. */
  siteId: string | null
}

export function permissionsFor(roles: readonly Role[]): Set<Permission> {
  const granted = new Set<Permission>()
  for (const role of roles) {
    for (const permission of MATRIX[role] ?? []) granted.add(permission)
  }
  return granted
}

export function can(principal: Principal, permission: Permission): boolean {
  // A user with no roles has no permissions — an unassigned account is inert rather than
  // implicitly trusted.
  return permissionsFor(principal.roles).has(permission)
}

/** Thrown when a principal lacks a permission. Mapped to 403 at the API edge. */
export class ForbiddenError extends Error {
  constructor(readonly permission: Permission) {
    super(`Missing permission: ${permission}`)
    this.name = 'ForbiddenError'
  }
}

export function requirePermission(principal: Principal, permission: Permission): void {
  if (!can(principal, permission)) throw new ForbiddenError(permission)
}

/**
 * How much of the estate a principal may see.
 *
 * A three-way result, not `string | null`. Null would have to mean both "unrestricted" and
 * "restricted, but to nowhere", and callers reading it as a query filter would treat the
 * second as the first — so a BRANCH user misconfigured without a site would silently see all
 * 32 sites. Making the deny case its own variant means the compiler forces every caller to
 * handle it.
 */
export type SiteScope = { kind: 'all' } | { kind: 'site'; siteId: string } | { kind: 'none' }

/**
 * Site scoping is enforced by narrowing the query, not by filtering results afterwards: a
 * forgotten post-filter leaks data, whereas a query that never selects another site's rows
 * cannot.
 */
export function scopeToSite(principal: Principal): SiteScope {
  // Any cross-site role lifts the restriction, so a user who is both BRANCH and
  // HQ_LAB_MANAGER is not accidentally blinded to the other 31 sites.
  const crossSite: Role[] = ['FINANCE', 'HQ_LAB_MANAGER', 'IT', 'DEVELOPER', 'PURCHASING']
  if (principal.roles.some((role) => crossSite.includes(role))) return { kind: 'all' }

  if (principal.siteId) return { kind: 'site', siteId: principal.siteId }

  // A site-scoped role with no site. Fail closed: show nothing, rather than everything.
  return { kind: 'none' }
}
