/**
 * Display formatting.
 *
 * All timestamps render in Asia/Kuala_Lumpur (assumption A6): Lablink is a single Malaysian
 * entity, and a lab manager comparing an idle time against their own shift needs local time,
 * not the server's.
 */
export const TIMEZONE = 'Asia/Kuala_Lumpur'

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  dateStyle: 'medium',
  timeStyle: 'short',
})

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—'
  const date = typeof value === 'string' ? new Date(value) : value
  return DATE_TIME.format(date)
}

/** Humanise a duration in minutes: "45m", "3h 20m", "6d 4h". */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return '—'

  const mins = Math.floor(minutes)
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  const rest = mins % 60

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
  return `${rest}m`
}

/** Minutes elapsed since `since`, or null when it is absent. */
export function minutesSince(since: Date | string | null | undefined, now: Date = new Date()): number | null {
  if (!since) return null
  const date = typeof since === 'string' ? new Date(since) : since
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60_000))
}

const CLASS_LABELS: Record<string, string> = {
  LAB_INSTRUMENT: 'Lab instrument',
  IT: 'IT',
  PRINTER: 'Printer',
  SCANNER: 'Scanner',
  REUSABLE_COMPONENT: 'Reusable component',
  OTHER: 'Other',
}

export function formatAssetClass(assetClass: string): string {
  return CLASS_LABELS[assetClass] ?? assetClass
}
