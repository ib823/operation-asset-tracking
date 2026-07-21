import Link from 'next/link'

/**
 * Branded not-found. Renders inside the root layout (nav + app shell), so an unknown asset id
 * or route lands somewhere recognisable with a way back — not Next's bare default page.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <p className="text-sm font-medium text-muted-foreground">404 — not found</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">We couldn&apos;t find that</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The asset or page you were looking for doesn&apos;t exist, or you may not have access to it.
      </p>
      <div className="mt-6 flex items-center justify-center gap-3 text-sm">
        <Link
          href="/assets"
          className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground hover:opacity-90"
        >
          ← Back to assets
        </Link>
        <Link href="/" className="rounded-md border px-4 py-2 font-medium hover:bg-muted">
          Go to dashboard
        </Link>
      </div>
    </div>
  )
}
