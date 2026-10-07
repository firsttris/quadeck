// Color theme: the accent color and the tint of the dark surfaces, per browser (localStorage),
// set on <html data-theme> before the first paint. The status colors (ok, warning, error) stay
// the same in every theme. The palettes are in styles.css; the default has no attribute rules.

import { useSyncExternalStore } from 'react'

export const THEMES = ['quadeck', 'nord', 'ocean', 'amethyst', 'copper'] as const
export type Theme = (typeof THEMES)[number]

/** Accent and background of each theme, for the swatches (same values as in styles.css). */
export const THEME_SWATCH: Record<Theme, { accent: string; bg: string }> = {
  quadeck: { accent: '#7cc4b8', bg: '#141a22' },
  nord: { accent: '#88c0d0', bg: '#1c2330' },
  ocean: { accent: '#6f9bff', bg: '#0c1931' },
  amethyst: { accent: '#b4a0ff', bg: '#1b1627' },
  copper: { accent: '#e39b6f', bg: '#1f1812' },
}

const KEY = 'quadeck-theme'

export const isTheme = (v: unknown): v is Theme => typeof v === 'string' && (THEMES as readonly string[]).includes(v)
export const resolveTheme = (stored: string | null): Theme => (isTheme(stored) ? stored : 'quadeck')

/** Runs in <head> so the page never flashes in the default colors. Keep in sync with resolveTheme. */
export const THEME_INIT_SCRIPT = `(function(){var q;try{q=localStorage.getItem('${KEY}')}catch(e){}document.documentElement.dataset.theme=${JSON.stringify(THEMES)}.indexOf(q)>=0?q:'quadeck'})()`

const read = (): string | null => {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

const listeners = new Set<() => void>()
let current: Theme | null = null

const snapshot = (): Theme => (current ??= resolveTheme(read()))

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // only a convenience
  }
  current = theme
  document.documentElement.dataset.theme = theme
  for (const l of listeners) l()
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    snapshot,
    () => 'quadeck',
  )
}
