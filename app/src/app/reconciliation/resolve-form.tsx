'use client'

import { useState, useTransition } from 'react'
import { dismissItem, linkItem } from './actions'

/**
 * Link-or-dismiss controls for one queue item.
 *
 * A client component only because it needs local state for the pending/result message; the
 * decisions themselves happen in server actions, which enforce their own permissions.
 */
export function ResolveForm({ itemId }: { itemId: string }) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [mode, setMode] = useState<'link' | 'dismiss'>('link')

  function run(action: () => Promise<{ ok: boolean; message: string }>) {
    startTransition(async () => setResult(await action()))
  }

  if (result?.ok) {
    return (
      <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
        {result.message}
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-1 text-xs">
        {(['link', 'dismiss'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setMode(option)}
            className={`rounded px-2 py-0.5 capitalize ${
              mode === option ? 'bg-secondary font-medium' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <form
        action={(formData) => {
          const value = String(formData.get('value') ?? '')
          run(() => (mode === 'link' ? linkItem(itemId, value) : dismissItem(itemId, value)))
        }}
        className="flex gap-2"
      >
        <input
          name="value"
          required
          disabled={pending}
          placeholder={mode === 'link' ? 'Asset tag, e.g. LAB-0001' : 'Reason for dismissing'}
          aria-label={mode === 'link' ? 'Asset tag to link' : 'Reason for dismissing'}
          className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? '…' : mode === 'link' ? 'Link' : 'Dismiss'}
        </button>
      </form>

      {result && !result.ok ? (
        <p role="alert" className="text-xs text-destructive">
          {result.message}
        </p>
      ) : null}
    </div>
  )
}
