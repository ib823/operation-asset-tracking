import { Skeleton, TableSkeleton } from '@/components/ui/skeleton'

export default function Loading() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <TableSkeleton rows={5} cols={7} />
    </div>
  )
}
