'use client'

import { useState, useTransition } from 'react'
import { acknowledgeAlert } from './actions'

export function AcknowledgeButton({ alertId }: { alertId: string }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await acknowledgeAlert(alertId)
            setError(result.ok ? null : result.message)
          })
        }
        className="h-7 rounded-md border border-input px-2 text-xs hover:bg-secondary disabled:opacity-50"
      >
        {pending ? '…' : 'Acknowledge'}
      </button>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
