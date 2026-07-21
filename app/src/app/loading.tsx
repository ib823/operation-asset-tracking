import { Skeleton } from '@/components/ui/skeleton'

/** Dashboard loading state — shown while the server renders live counts (never a blank screen). */
export default function Loading() {
  return (
    <div className="space-y-8" role="status" aria-label="Loading dashboard">
      <div>
        <Skeleton className="h-8 w-40" />
        <Skeleton className="mt-2 h-4 w-64" />
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-56 w-full" />
      <span className="sr-only">Loading…</span>
    </div>
  )
}
