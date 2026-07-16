import type { AssetStatus } from '@oat/db'
import { cn } from '@/lib/utils'

/**
 * Status colours.
 *
 * Colour is an accent, never the only carrier of meaning — the label is always rendered,
 * so the badge stays readable to a colour-blind user and in a printed stocktake sheet.
 */
const STYLES: Record<AssetStatus, string> = {
  IN_USE:
    'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-400/30',
  IDLE: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-400/30',
  UNDER_REPAIR: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-400/30',
  RETIRED: 'bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-400/30',
}

const LABELS: Record<AssetStatus, string> = {
  IN_USE: 'In use',
  IDLE: 'Idle',
  UNDER_REPAIR: 'Under repair',
  RETIRED: 'Retired',
}

export function StatusBadge({ status, className }: { status: AssetStatus; className?: string }) {
  return (
    <span
      data-testid="status-badge"
      data-status={status}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        STYLES[status],
        className,
      )}
    >
      {LABELS[status]}
    </span>
  )
}

export function statusLabel(status: AssetStatus): string {
  return LABELS[status]
}
