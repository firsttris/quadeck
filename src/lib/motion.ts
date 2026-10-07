// How much moves: off, subtle (default) or strong, per browser (localStorage), set on <html
// data-motion> before the first paint. Without a choice, the system's "reduce motion" means off.
// Same three levels as in SnapRAID UI and the CCU add-on.

import { useSyncExternalStore } from 'react'

export const MOTION_LEVELS = ['off', 'subtle', 'strong'] as const
export type Motion = (typeof MOTION_LEVELS)[number]

const KEY = 'quadeck-motion'
const REDUCED = '(prefers-reduced-motion: reduce)'

/** Runs in <head>: no animation starts before the level applies. Keep in sync with resolveMotion. */
export const MOTION_INIT_SCRIPT = `(function(){var q;try{q=localStorage.getItem('${KEY}')}catch(e){}document.documentElement.dataset.motion=q==='off'||q==='subtle'||q==='strong'?q:window.matchMedia('${REDUCED}').matches?'off':'subtle'})()`

export const isMotion = (v: unknown): v is Motion => typeof v === 'string' && (MOTION_LEVELS as readonly string[]).includes(v)

/** The stored choice wins; without one, "reduce motion" in the system means off. */
export const resolveMotion = (stored: string | null, reduced: boolean): Motion => (isMotion(stored) ? stored : reduced ? 'off' : 'subtle')

const read = (): string | null => {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null // storage blocked: follow the system
  }
}

const listeners = new Set<() => void>()
let current: Motion | null = null

const snapshot = (): Motion => (current ??= resolveMotion(read(), window.matchMedia(REDUCED).matches))

export function setMotion(level: Motion) {
  try {
    localStorage.setItem(KEY, level)
  } catch {
    // only a convenience
  }
  current = level
  document.documentElement.dataset.motion = level
  for (const l of listeners) l()
}

export function useMotion(): Motion {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    snapshot,
    () => 'subtle', // server render: the init script already set the real level on <html>
  )
}
