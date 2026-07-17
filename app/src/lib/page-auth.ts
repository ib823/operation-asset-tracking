import { can, ForbiddenError, type Permission, type Principal } from '@oat/auth'
import { requirePrincipal } from './auth'

/**
 * Authenticate and authorise a page.
 *
 * Pages enforce their own access rather than trusting middleware, because middleware can
 * fail open — see the note on `requirePrincipal`. This is the boundary that actually holds.
 */
export async function requirePermission(permission: Permission, from?: string): Promise<Principal> {
  const principal = await requirePrincipal(from)

  // A signed-in user without the permission is an error, not a redirect: sending them back
  // to sign in would loop forever, since signing in again changes nothing.
  if (!can(principal, permission)) throw new ForbiddenError(permission)

  return principal
}
