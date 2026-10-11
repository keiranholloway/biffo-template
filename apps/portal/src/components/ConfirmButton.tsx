'use client'

import { useState, type ReactNode } from 'react'

/**
 * A destructive-action button that needs a second, explicit in-page step.
 * The first click swaps the button for "<prompt> [confirm] [Cancel]"; only the
 * confirm control calls `onConfirm`. Not a native browser dialog.
 */
export function ConfirmButton({
  children,
  ariaLabel,
  prompt,
  confirmLabel,
  onConfirm,
  disabled = false,
  title,
  className,
  confirmClassName = 'rounded border border-rose-300 bg-rose-600 px-2 py-1 text-xs text-white hover:bg-rose-700',
}: {
  children: ReactNode
  ariaLabel?: string
  /** Names the record and the consequence, e.g. "Delete alice@x? This cannot be undone." */
  prompt: string
  confirmLabel: string
  onConfirm: () => void
  disabled?: boolean
  title?: string | undefined
  className?: string
  confirmClassName?: string
}) {
  const [armed, setArmed] = useState(false)

  if (!armed) {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        disabled={disabled}
        title={title}
        onClick={() => {
          setArmed(true)
        }}
        className={className}
      >
        {children}
      </button>
    )
  }

  return (
    <span role="group" aria-label={prompt} className="flex flex-wrap items-center gap-1">
      <span className="text-xs text-rose-700">{prompt}</span>
      <button
        type="button"
        onClick={() => {
          setArmed(false)
          onConfirm()
        }}
        className={confirmClassName}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={() => {
          setArmed(false)
        }}
        className="rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
      >
        Cancel
      </button>
    </span>
  )
}
