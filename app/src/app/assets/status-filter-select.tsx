'use client'

// The status <select>, extracted into a client component only so choosing a status submits the
// enclosing GET form immediately — no "Filter" click needed. Everything else stays server-side:
// the form is still a plain GET (shareable, filtered URL) and the Filter button remains as a
// no-JS fallback. requestSubmit() (not form.submit()) so the button's native submit path is
// used — it fires validation and behaves exactly like a click.
export function StatusFilterSelect({ defaultValue }: { defaultValue: string }) {
  return (
    <select
      name="status"
      defaultValue={defaultValue}
      onChange={(e) => e.currentTarget.form?.requestSubmit()}
      aria-label="Filter by status"
      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
    >
      <option value="">All statuses</option>
      <option value="IN_USE">In use</option>
      <option value="IDLE">Idle</option>
      <option value="UNDER_REPAIR">Under repair</option>
      <option value="RETIRED">Retired</option>
    </select>
  )
}
