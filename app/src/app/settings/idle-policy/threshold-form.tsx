'use client'

import { useState, useTransition } from 'react'
import { clearThreshold, setThreshold } from './actions'

/** Set or clear one threshold. Client-side only for the pending/result message; the decision
 *  happens in a server action that enforces its own permission. */
export function ThresholdForm({
  scope,
  configKey,
  current,
  isDefault,
  defaultMinutes,
}: {
  scope: 'CLASS' | 'SUB_TYPE' | 'ASSET'
  configKey: string
  current: number
  isDefault: boolean
  defaultMinutes: number
}) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  return (
    <div className="space-y-1">
      <form
        action={(formData) => {
          const minutes = Number(formData.get('minutes'))
          startTransition(async () => setResult(await setThreshold(scope, configKey, minutes)))
        }}
        className="flex items-center gap-2"
      >
        <input
          name="minutes"
          type="number"
          min={1}
          defaultValue={current}
          disabled={pending}
          aria-label={`Idle threshold in minutes for ${configKey}`}
          className="h-8 w-24 rounded-md border border-input bg-background px-2 text-sm tabular-nums"
        />
        <span className="text-xs text-muted-foreground">min</span>

        <button
          type="submit"
          disabled={pending}
          className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? '…' : 'Save'}
        </button>

        {!isDefault ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => startTransition(async () => setResult(await clearThreshold(scope, configKey)))}
            className="h-8 rounded-md px-2 text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50"
          >
            Reset to {defaultMinutes}
          </button>
        ) : null}
      </form>

      {result ? (
        <p
          role="status"
          className={`text-xs ${result.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}`}
        >
          {result.message}
        </p>
      ) : null}
    </div>
  )
}
