import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'Lablink OAT — Operational Asset Tracker',
  description: 'Operational location, status, idle time and utilisation for Lablink laboratory assets.',
}

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/assets', label: 'Assets' },
]

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background antialiased">
        <header className="border-b">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
            <Link href="/" className="font-semibold tracking-tight">
              Lablink <span className="text-primary">OAT</span>
            </Link>
            <nav className="flex gap-4 text-sm" aria-label="Main">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="text-muted-foreground hover:text-foreground">
                  {item.label}
                </Link>
              ))}
            </nav>
            {/* Stated plainly and permanently: the OAT is the operational layer, and SAP
                remains the financial record. Users must never mistake this for the ledger. */}
            <span className="ml-auto hidden text-xs text-muted-foreground sm:block">
              Operational layer · SAP FI-AA remains the financial system of record
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-8">{children}</main>
      </body>
    </html>
  )
}
