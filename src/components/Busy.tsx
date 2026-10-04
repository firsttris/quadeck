// Feedback while something runs on the server: a spinner, a button that shows it is working
// (and can't be clicked twice), and a hook that remembers which row or action is running.

import { useCallback, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

/** A small spinning ring in the current text colour (static with reduced motion; the label says it). */
export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`spinner ${className}`} aria-hidden="true" />
}

/**
 * A button that, while `busy`, shows a spinner and `busyLabel`, is disabled and marked aria-busy.
 * Defaults to type="button".
 */
export function BusyButton({ busy = false, busyLabel, children, disabled, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; busyLabel?: ReactNode }) {
  return (
    <button type={type} {...rest} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy && <Spinner />}
      {busy && busyLabel !== undefined ? busyLabel : children}
    </button>
  )
}

/**
 * Which action is running (a row id, "save", …). `run` ignores a second start while one runs,
 * so double clicks never send a request twice.
 */
export function useBusy<K extends string = string>() {
  const [busy, setBusy] = useState<K | null>(null)
  const running = useRef(false)
  const run = useCallback(async <T,>(key: K, fn: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined
    running.current = true
    setBusy(key)
    try {
      return await fn()
    } finally {
      running.current = false
      setBusy(null)
    }
  }, [])
  return { busy, run, is: (key: K) => busy === key }
}
