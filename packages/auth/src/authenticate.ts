import type { PrismaClient } from '@oat/db'
import { burnTime, verifyPassword } from './password'
import type { Principal } from './rbac'

/**
 * Credential verification and token revalidation.
 *
 * Kept out of the Auth.js config so it is testable without a Next request context, and so
 * swapping to OIDC (SAP IAS) replaces the provider without touching this logic.
 */

/**
 * Verify an email/password pair.
 *
 * Returns null for every failure — wrong password, unknown email, deactivated account — and
 * never says which. Distinguishing them hands an attacker a user-enumeration oracle, and
 * "no such user" is exactly the message that makes a phishing list cheap to build.
 */
export async function verifyCredentials(
  prisma: PrismaClient,
  email: string,
  password: string,
): Promise<Principal | null> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    select: { id: true, email: true, passwordHash: true, roles: true, siteId: true, active: true },
  })

  if (!user?.passwordHash) {
    // No such user, or a federated user with no local password. Spend the same time a real
    // Argon2 verify would, so response timing does not reveal which accounts exist.
    await burnTime()
    return null
  }

  if (!user.active) {
    await burnTime()
    return null
  }

  if (!(await verifyPassword(password, user.passwordHash))) return null

  return { id: user.id, email: user.email, roles: user.roles, siteId: user.siteId }
}

/**
 * Re-read the user behind a token and confirm it is still honoured.
 *
 * Auth.js issues stateless JWTs with the Credentials provider, so a token cannot be
 * withdrawn once minted. Revalidating on each request restores revocation: deactivating a
 * user or bumping `tokenVersion` takes effect immediately rather than at token expiry
 * (ADR-0011).
 *
 * Costs one indexed read per authenticated request — deliberate, and cheap at this scale.
 */
export async function revalidate(
  prisma: PrismaClient,
  userId: string,
  tokenVersion: number,
): Promise<Principal | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, roles: true, siteId: true, active: true, tokenVersion: true },
  })

  if (!user || !user.active) return null

  // The token was minted before someone bumped the version — every token issued to this
  // user before that bump is now void.
  if (user.tokenVersion !== tokenVersion) return null

  // Roles are read fresh, not trusted from the token: a role revoked a minute ago must not
  // survive in a token minted an hour ago.
  return { id: user.id, email: user.email, roles: user.roles, siteId: user.siteId }
}

/** Invalidate every outstanding token for a user. */
export async function revokeSessions(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } })
}
