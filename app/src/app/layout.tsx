import type { Metadata } from 'next'
import Link from 'next/link'
import { can, type Permission } from '@oat/auth'
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
  { href: '/reconciliation', label: 'Reconciliation', permission: 'reconciliation:read' },
]

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const principal = await currentPrincipal()
  const links = principal ? NAV.filter((item) => can(principal, item.permission)) : []

  return (
    <html lang="en">
      <body className="min-h-screen bg-background antialiased">
        <header className="border-b">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
            <Link href="/" className="font-semibold tracking-tight">
              Lablink <span className="text-primary">OAT</span>
            </Link>

            <nav className="flex gap-4 text-sm" aria-label="Main">
              {links.map((item) => (
                <Link key={item.href} href={item.href} className="text-muted-foreground hover:text-foreground">
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="ml-auto flex items-center gap-4">
              {/* Stated plainly and permanently: the OAT is the operational layer, and SAP
                  remains the financial record. Users must never mistake this for the ledger. */}
              <span className="hidden text-xs text-muted-foreground lg:block">
                Operational layer · SAP FI-AA remains the financial system of record
              </span>

              {principal ? (
                <form
                  action={async () => {
                    'use server'
                    await signOut({ redirectTo: '/signin' })
                  }}
                  className="flex items-center gap-3"
                >
                  <span data-testid="current-user" className="text-xs text-muted-foreground">
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
