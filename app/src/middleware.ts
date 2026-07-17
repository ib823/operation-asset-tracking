import NextAuth from 'next-auth'
import { NextResponse } from 'next/server'
import { authConfig } from '@/lib/auth.config'

/**
 * Require a session for everything except the sign-in page, the auth endpoints, and health.
 *
 * A default-deny allowlist rather than per-page opt-in: a page added next year is protected
 * by default, and forgetting to opt in fails closed instead of exposing the register.
 *
 * This is a COARSE gate — it proves only that a valid token exists. It deliberately does not
 * revalidate against the database (it cannot: Edge runtime, no Prisma), so every route still
 * enforces its own permission and site scope. "Authenticated" is not "authorised", and the
 * revocation check lives in the `jwt` callback on the Node side (ADR-0011).
 */
const { auth } = NextAuth(authConfig)

/**
 * Paths middleware lets through to their OWN guard.
 *
 * Not "public" — most of these are strictly controlled; they just authenticate themselves
 * rather than by session:
 *
 *   /signin, /api/auth   the sign-in flow, which by definition has no session yet
 *   /api/health          a probe; leaks nothing beyond "the database answers"
 *   /api/admin           service-token only (the scheduler's idle sweep)
 *   /api/connectors      service-token only (connector polls)
 *
 * The last two matter: their callers are machines with no session, so a session check here
 * would make them permanently unreachable — which is exactly what it did until this was
 * fixed. They enforce `requireServiceToken` themselves, and fail closed when it is unset.
 */
const SELF_GUARDED = ['/signin', '/api/auth', '/api/health', '/api/admin', '/api/connectors']

export default auth((request) => {
  const { pathname } = request.nextUrl

  if (SELF_GUARDED.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next()
  }

  if (request.auth) return NextResponse.next()

  // API callers get a 401 they can act on; humans get sent to sign in, and back to where
  // they were going.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const signin = new URL('/signin', request.nextUrl.origin)
  signin.searchParams.set('from', pathname)
  return NextResponse.redirect(signin)
})

export const config = {
  // Skip Next internals and static files; everything else goes through the gate.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
