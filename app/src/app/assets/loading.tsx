import { Skeleton, TableSkeleton } from '@/components/ui/skeleton'

export default function Loading() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="mt-2 h-4 w-56" />
      </div>
      <Skeleton className="h-9 w-full max-w-md" />
      <TableSkeleton rows={8} cols={8} />
    </div>
  )
}
