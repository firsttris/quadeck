import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isTheme, resolveTheme, THEME_INIT_SCRIPT, THEME_SWATCH, THEMES } from '~/lib/theme'

const css = readFileSync('src/styles.css', 'utf8')

/** The variables of the default palette (@theme) and of each theme block. */
function palettes() {
  const vars = (block: string) => Object.fromEntries([...block.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6});/g)].map((mm) => [mm[1]!, mm[2]!]))
  const out: Record<string, Record<string, string>> = { quadeck: vars(/@theme \{([^}]*)\}/.exec(css)![1]!) }
  for (const mm of css.matchAll(/:root\[data-theme='(\w+)'\] \{([^}]*)\}/g)) out[mm[1]!] = vars(mm[2]!)
  return out
}

/** WCAG contrast ratio of two #rrggbb colors. */
function contrast(a: string, b: string) {
  const lum = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}

describe('color themes', () => {
  it('the stored choice wins, anything else is the default', () => {
    expect(resolveTheme('nord')).toBe('nord')
    expect(resolveTheme(null)).toBe('quadeck')
    expect(resolveTheme('pink')).toBe('quadeck')
    expect(isTheme('toString')).toBe(false)
  })

  it('the init script does the same before the first paint, also with blocked storage', () => {
    const run = (getItem: () => string | null) => {
      const html = { dataset: {} as Record<string, string> }
      new Function('localStorage', 'document', THEME_INIT_SCRIPT)({ getItem }, { documentElement: html })
      return html.dataset.theme
    }
    for (const stored of [...THEMES, null, 'pink', 'toString', '']) expect(run(() => stored)).toBe(resolveTheme(stored))
    expect(
      run(() => {
        throw new Error('blocked')
      }),
    ).toBe('quadeck')
  })

  it('every theme sets the same variables as the default, and the swatches show its real colors', () => {
    const p = palettes()
    expect(Object.keys(p).sort()).toEqual([...THEMES].sort())
    const names = Object.keys(p.nord!).sort()
    expect(names).toContain('accent-2')
    for (const t of THEMES) {
      expect(Object.keys(p[t]!).sort(), t).toEqual(expect.arrayContaining(names))
      expect(THEME_SWATCH[t], t).toEqual({ accent: p[t]!.accent, bg: p[t]!.panel })
    }
  })

  it('text, accent and status colors stay readable on every theme', () => {
    const p = palettes()
    const status = p.quadeck!
    for (const t of THEMES) {
      const c = { ...status, ...p[t] }
      // links and the current page in the accent; body text; secondary text
      expect(contrast(c.accent!, c.panel!), `${t} accent`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(c.fg!, c.panel!), `${t} fg`).toBeGreaterThanOrEqual(10)
      expect(contrast(c.muted!, c.panel!), `${t} muted`).toBeGreaterThanOrEqual(4)
      for (const s of ['ok', 'warn', 'bad']) expect(contrast(c[s]!, c.panel!), `${t} ${s}`).toBeGreaterThanOrEqual(4)
      // the second chart color differs from the accent
      expect(c['accent-2']).not.toBe(c.accent)
      // the status colors are never redefined
      for (const s of ['ok', 'warn', 'bad']) expect(p[t]![s], `${t} ${s}`).toBe(t === 'quadeck' ? status[s] : undefined)
    }
  })

  it('components use the theme variables, not the default palette', () => {
    const fixed = /#(7cc4b8|b4a0ff|0b0f14|0e1319|141a22|11161d|161c24|1c2430|2a323d|4f8fbf)\b|rgba\(124, ?196, ?184/i
    const offenders = globSync('src/{components,routes}/**/*.tsx').filter((f) => fixed.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
