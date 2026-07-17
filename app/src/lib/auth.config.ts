import type { NextAuthConfig } from 'next-auth'

/**
 * The Edge-safe half of the Auth.js config.
 *
 * Middleware runs on the Edge runtime, which cannot load native modules — and the full
 * config reaches Prisma's engine and argon2's `.node` binary through `@oat/auth`. Importing
 * that from middleware fails the build outright.
 *
 * So the config is split, per Auth.js's own guidance:
 *
 *   auth.config.ts (this file)  no providers, no DB. Enough for middleware to decode a JWT
 *                              and answer "is there a session?".
 *   auth.ts                     the full config: credentials provider, revalidation, roles.
 *                               Node runtime only.
 *
 * Both share the same secret and cookie, so the token minted by one is readable by the other.
 *
 * This file must import NOTHING that touches the database, argon2, or `@oat/auth`. Keeping
 * it dependency-free is the whole point.
 */
export const authConfig: NextAuthConfig = {
  session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
  pages: { signIn: '/signin' },
  // Populated in auth.ts. Middleware never signs anyone in — it only reads an existing token.
  providers: [],
}
