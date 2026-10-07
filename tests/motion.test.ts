import { describe, expect, it } from 'vitest'
import { isMotion, MOTION_INIT_SCRIPT, resolveMotion } from '~/lib/motion'

describe('motion level', () => {
  it('the stored choice wins; without one, "reduce motion" means off, else subtle', () => {
    expect(resolveMotion('strong', true)).toBe('strong')
    expect(resolveMotion('off', false)).toBe('off')
    expect(resolveMotion(null, true)).toBe('off')
    expect(resolveMotion(null, false)).toBe('subtle')
    expect(resolveMotion('wild', false)).toBe('subtle')
    expect(isMotion('subtle')).toBe(true)
    expect(isMotion('toString')).toBe(false)
  })

  it('the init script does the same before the first paint', () => {
    const run = (stored: string | null, reduced: boolean) => {
      const html = { dataset: {} as Record<string, string> }
      const fn = new Function('localStorage', 'document', 'window', MOTION_INIT_SCRIPT)
      fn({ getItem: () => stored }, { documentElement: html }, { matchMedia: () => ({ matches: reduced }) })
      return html.dataset.motion
    }
    for (const [stored, reduced] of [['strong', true], ['off', false], [null, true], [null, false], ['wild', false]] as const) expect(run(stored, reduced)).toBe(resolveMotion(stored, reduced))
    // blocked storage: the system decides
    const html = { dataset: {} as Record<string, string> }
    new Function('localStorage', 'document', 'window', MOTION_INIT_SCRIPT)(
      {
        getItem: () => {
          throw new Error('blocked')
        },
      },
      { documentElement: html },
      { matchMedia: () => ({ matches: false }) },
    )
    expect(html.dataset.motion).toBe('subtle')
  })
})
