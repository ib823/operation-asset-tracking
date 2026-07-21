import type { Metadata } from 'next'
import Link from 'next/link'
import { can, type Permission } from '@oat/auth'
import { prisma } from '@oat/db'
import { revokeSessions } from '@oat/auth/server'
import { redirect } from 'next/navigation'
import { currentPrincipal, signOut } from '@/lib/auth'
import './globals.css'

export const metadata: Metadata = {
  title: 'Lablink OAT — Operational Asset Tracker',
  description: 'Operational location, status, idle time and utilisation for Lablink laboratory assets.',
}

/**
 * Nav is filtered by permission so people are not shown doors they cannot open.
 *
 * This is presentation, not access control — every page and route enforces its own
 * permission (ADR-0012). Hiding a link stops confusion; it stops nothing else.
 */
const NAV: Array<{ href: string; label: string; permission: Permission }> = [
  { href: '/', label: 'Dashboard', permission: 'asset:read' },
  { href: '/assets', label: 'Assets', permission: 'asset:read' },
  { href: '/alerts', label: 'Alerts', permission: 'utilisation:read' },
  { href: '/reconciliation', label: 'Reconciliation', permission: 'reconciliation:read' },
  { href: '/settings/idle-policy', label: 'Idle policy', permission: 'utilisation:read' },
]

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const principal = await currentPrincipal()
  const links = principal ? NAV.filter((item) => can(principal, item.permission)) : []

  return (
    <html lang="en">
      <body className="min-h-screen bg-background antialiased">
        <header className="border-b">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
            <Link href="/" className="shrink-0 font-semibold tracking-tight">
              Lablink <span className="text-primary">OAT</span>
            </Link>

            {/* The nav may shrink and scroll on a cramped viewport; the account cluster on the
                right is `shrink-0`, so Sign out is never pushed off the edge. */}
            <nav className="flex min-w-0 gap-4 overflow-x-auto whitespace-nowrap text-sm" aria-label="Main">
              {links.map((item) => (
                <Link key={item.href} href={item.href} className="text-muted-foreground hover:text-foreground">
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="ml-auto flex shrink-0 items-center gap-4">
              {/* Stated plainly and permanently: the OAT is the operational layer, and SAP
                  remains the financial record. Users must never mistake this for the ledger. */}
              <span className="hidden max-w-md truncate text-xs text-muted-foreground xl:block">
                Operational layer · SAP FI-AA remains the financial system of record
              </span>

              {principal ? (
                <form
                  action={async () => {
                    'use server'
                    // Sign-out REVOKES the token server-side; clearing the cookie is a
                    // courtesy on top.
                    //
                    // Deleting the cookie alone is not reliable: a concurrent request that
                    // refreshes the rolling session re-writes it after the deletion, and the
                    // user lands on /signin with a live session. Measured at 4-in-8, then
                    // 2-in-8 after switching off `redirectTo` — a coin flip either way, and
                    // on a shared lab workstation the loser is the next person to hit Back.
                    //
                    // Bumping tokenVersion (ADR-0011) makes the outcome independent of that
                    // race: whatever happens to the cookie, the token no longer validates.
                    // See ADR-0016.
                    await revokeSessions(prisma, principal.id)
                    await signOut({ redirect: false })
                    redirect('/signin')
                  }}
                  className="flex items-center gap-3"
                >
                  <span
                    data-testid="current-user"
                    className="hidden max-w-[12rem] truncate text-xs text-muted-foreground sm:block"
                    title={principal.email}
                  >
                    {principal.email}
                  </span>
                  <button type="submit" className="text-xs text-muted-foreground underline hover:text-foreground">
                    Sign out
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-8">{children}</main>
      </body>
    </html>
  )
}
