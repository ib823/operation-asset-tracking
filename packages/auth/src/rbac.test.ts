import type { Role } from '@oat/db'
import { describe, expect, it } from 'vitest'
import { can, ForbiddenError, permissionsFor, requirePermission, scopeToSite, type Principal } from './rbac'

function principal(roles: Role[], siteId: string | null = null): Principal {
  return { id: 'u1', email: 'user@lablink.example', roles, siteId }
}

describe('RBAC per RFP Appendix F', () => {
  it('grants Finance approval of SAP write-back', () => {
    expect(can(principal(['FINANCE']), 'sap:writeback:approve')).toBe(true)
  })

  it('does not let Finance run the labs', () => {
    // Finance consumes utilisation to make disposal decisions; it does not scan or assign.
    expect(can(principal(['FINANCE']), 'scan:submit')).toBe(false)
    expect(can(principal(['FINANCE']), 'asset:update')).toBe(false)
  })

  it('does not let Purchasing approve disposals', () => {
    // The separation that matters: raising a purchase must not carry the power to write off.
    expect(can(principal(['PURCHASING']), 'sap:writeback:approve')).toBe(false)
    expect(can(principal(['PURCHASING']), 'sap:writeback:propose')).toBe(false)
  })

  it('lets Branch staff do the operational work', () => {
    const branch = principal(['BRANCH'], 'site-1')
    expect(can(branch, 'scan:submit')).toBe(true)
    expect(can(branch, 'asset:assign')).toBe(true)
  })

  it('keeps Branch out of SAP and the platform', () => {
    const branch = principal(['BRANCH'], 'site-1')
    for (const permission of ['sap:sync', 'sap:writeback:approve', 'user:manage', 'connector:manage'] as const) {
      expect(can(branch, permission), permission).toBe(false)
    }
  })

  it('gives the HQ Lab Manager utilisation and the idle policy', () => {
    const hq = principal(['HQ_LAB_MANAGER'])
    expect(can(hq, 'utilisation:read')).toBe(true)
    expect(can(hq, 'idle-policy:manage')).toBe(true)
  })

  it('lets the HQ Lab Manager propose but not approve a disposal', () => {
    // Proposing is an operational judgement; approving is a financial one. Different people.
    const hq = principal(['HQ_LAB_MANAGER'])
    expect(can(hq, 'sap:writeback:propose')).toBe(true)
    expect(can(hq, 'sap:writeback:approve')).toBe(false)
  })

  it('lets IT run integrations but not make asset decisions', () => {
    const it = principal(['IT'])
    expect(can(it, 'connector:manage')).toBe(true)
    expect(can(it, 'sap:sync')).toBe(true)
    expect(can(it, 'asset:retire')).toBe(false)
    expect(can(it, 'sap:writeback:approve')).toBe(false)
  })

  it('gives Developer everything', () => {
    const dev = principal(['DEVELOPER'])
    for (const permission of [
      'asset:create',
      'sap:writeback:approve',
      'reconciliation:resolve',
      'user:manage',
    ] as const) {
      expect(can(dev, permission), permission).toBe(true)
    }
  })

  it('grants nothing to a user with no roles', () => {
    // An unassigned account is inert, not implicitly trusted.
    expect(permissionsFor([]).size).toBe(0)
    expect(can(principal([]), 'asset:read')).toBe(false)
  })

  it('unions permissions across multiple roles', () => {
    const both = principal(['BRANCH', 'FINANCE'], 'site-1')
    expect(can(both, 'scan:submit')).toBe(true)
    expect(can(both, 'sap:writeback:approve')).toBe(true)
  })

  it('lets every role read the register', () => {
    const roles: Role[] = ['FINANCE', 'PURCHASING', 'BRANCH', 'HQ_LAB_MANAGER', 'IT', 'DEVELOPER']
    for (const role of roles) {
      expect(can(principal([role]), 'asset:read'), role).toBe(true)
    }
  })
})

describe('requirePermission', () => {
  it('throws ForbiddenError naming the missing permission', () => {
    expect(() => requirePermission(principal(['BRANCH'], 's1'), 'sap:sync')).toThrow(ForbiddenError)
    expect(() => requirePermission(principal(['BRANCH'], 's1'), 'sap:sync')).toThrow(/sap:sync/)
  })

  it('passes silently when the permission is held', () => {
    expect(() => requirePermission(principal(['IT']), 'sap:sync')).not.toThrow()
  })
})

describe('scopeToSite', () => {
  it('confines a Branch user to their own site', () => {
    expect(scopeToSite(principal(['BRANCH'], 'site-1'))).toEqual({ kind: 'site', siteId: 'site-1' })
  })

  it('does not confine cross-site roles', () => {
    for (const role of ['FINANCE', 'HQ_LAB_MANAGER', 'IT', 'DEVELOPER'] as Role[]) {
      expect(scopeToSite(principal([role], 'site-1')), role).toEqual({ kind: 'all' })
    }
  })

  it('lifts the restriction when a Branch user also holds a cross-site role', () => {
    // Otherwise an HQ manager who also covers a branch would be silently blinded to 31 sites.
    expect(scopeToSite(principal(['BRANCH', 'HQ_LAB_MANAGER'], 'site-1'))).toEqual({ kind: 'all' })
  })

  it('fails CLOSED for a site-scoped user with no site', () => {
    // The dangerous case. If this returned "unrestricted", a misconfigured Branch user would
    // silently see all 32 sites — a data leak produced by a missing field.
    expect(scopeToSite(principal(['BRANCH'], null))).toEqual({ kind: 'none' })
  })
})
