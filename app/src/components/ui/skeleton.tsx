import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * A pulsing placeholder. Rendered by route `loading.tsx` files while a server component fetches,
 * so a slow first paint — a serverless cold start, especially — reads as "loading", never as a
 * frozen or blank screen.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} aria-hidden {...props} />
}

/** A skeleton stand-in for a data table: a header strip and a few body rows. */
export function TableSkeleton({ rows = 6, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="rounded-lg border" aria-busy role="status" aria-label="Loading">
      <div className="flex gap-4 border-b px-4 py-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b px-4 py-3 last:border-0">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  )
}
