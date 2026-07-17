import type { Principal } from '@oat/auth'
import { revalidate, verifyCredentials } from '@oat/auth/server'
import type { Role } from '@oat/db'
import { prisma } from '@oat/db'
import NextAuth, { type DefaultSession } from 'next-auth'
import { redirect } from 'next/navigation'
import Credentials from 'next-auth/providers/credentials'
import { authConfig } from './auth.config'

/**
 * Auth.js configuration (ADR-0011).
 *
 * Credentials + JWT strategy — Auth.js does not support database sessions with credentials.
 * Revocation is restored in the `jwt` callback, which re-reads the user on every request.
 *
 * The OIDC/SAP IAS seam: add an OIDC provider to `providers` and map its claims to roles.
 * The RBAC layer, the session shape, and every call site stay exactly as they are.
 */

declare module 'next-auth' {
  interface Session {
    /**
     * Extends Auth.js's default user rather than replacing it: the declaration merges, so a
     * bare object literal here would intersect with AdapterUser and demand adapter-only
     * fields we do not have.
     */
    user: {
      id: string
      roles: Role[]
      siteId: string | null
    } & DefaultSession['user']
  }

  /**
   * What `authorize` returns and the `jwt` callback receives.
   *
   * Auth.js's built-in User extends AdapterUser (with `emailVerified`), which only applies
   * to database-adapter flows. We use credentials + JWT and have no adapter, so those fields
   * are declared optional here rather than faked with nulls in `authorize`.
   */
  interface User {
    roles?: Role[]
    siteId?: string | null
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(raw) {
        const email = typeof raw?.email === 'string' ? raw.email : ''
        const password = typeof raw?.password === 'string' ? raw.password : ''
        if (!email || !password) return null

        const principal = await verifyCredentials(prisma, email, password)
        if (!principal) return null

        return {
          id: principal.id,
          email: principal.email,
          roles: principal.roles,
          siteId: principal.siteId,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // Sign-in: stamp the identity and the token version it was minted against.
      if (user?.id) {
        const row = await prisma.user.findUnique({
          where: { id: user.id },
          select: { tokenVersion: true },
        })
        token.sub = user.id
        token.tokenVersion = row?.tokenVersion ?? 0
        return token
      }

      // Every subsequent request: re-read the user. A JWT cannot be withdrawn once minted,
      // so this is what makes deactivation and role changes take effect immediately rather
      // than at token expiry. Costs one indexed read; deliberate (ADR-0011).
      if (!token.sub) return null

      const principal = await revalidate(prisma, token.sub, (token.tokenVersion as number) ?? -1)
      // Returning null invalidates the session — the user is gone, deactivated, or their
      // tokens were revoked.
      if (!principal) return null

      token.email = principal.email
      token.roles = principal.roles
      token.siteId = principal.siteId
      return token
    },

    session({ session, token }) {
      session.user = {
        ...session.user,
        id: token.sub as string,
        email: token.email as string,
        roles: (token.roles as Role[]) ?? [],
        siteId: (token.siteId as string | null) ?? null,
      }
      return session
    },
  },
})

/**
 * The authenticated principal for a page, or redirect to sign-in.
 *
 * Every protected page calls this, even though middleware already gates them. That is
 * deliberate defence in depth, not redundancy — we learned the hard way that middleware can
 * fail OPEN.
 *
 * During Phase 1 a missing `AUTH_TRUST_HOST` made Auth.js throw `UntrustedHost` inside
 * middleware; Next swallowed the error and rendered the page anyway, serving the whole asset
 * register to an unauthenticated caller. The middleware was present, correct, and useless.
 *
 * A page that checks for itself cannot be bypassed by a misconfigured gate in front of it.
 * Middleware is an optimisation (one redirect, no render); this is the actual boundary.
 */
export async function requirePrincipal(from?: string): Promise<Principal> {
  const principal = await currentPrincipal()
  if (principal) return principal

  const target = from ? `/signin?from=${encodeURIComponent(from)}` : '/signin'
  redirect(target)
}

/** The authenticated principal, or null. */
export async function currentPrincipal(): Promise<Principal | null> {
  const session = await auth()

  // Auth.js types email as optional on its default user. A session without an id or email is
  // not a principal we can audit, so treat it as unauthenticated rather than casting the
  // problem away — the audit trail is the reason this identity exists at all.
  if (!session?.user?.id || !session.user.email) return null

  return {
    id: session.user.id,
    email: session.user.email,
    roles: session.user.roles,
    siteId: session.user.siteId,
  }
}
