import { describe, expect, it } from 'vitest'
import { followServer } from '~/lib/draft'

describe('form drafts against polled server values', () => {
  const server = { threshold: 90, rules: { disk: true } }

  it('ignores a poll that returns the same value as a new object', () => {
    expect(followServer(server, structuredClone(server), { ...server, threshold: 80 })).toBeUndefined()
  })

  it('keeps unsaved edits when the server value changes', () => {
    const edited = { ...server, threshold: 80 }
    const changed = { ...server, rules: { disk: false } }
    expect(followServer(server, changed, edited)).toEqual({ base: changed, draft: edited })
  })

  it('follows the server while nothing was edited', () => {
    const changed = { ...server, threshold: 95 }
    expect(followServer(server, changed, structuredClone(server))).toEqual({ base: changed, draft: changed })
  })

  it('uses the given comparison', () => {
    const sameThreshold = (a: typeof server, b: typeof server) => a.threshold === b.threshold
    expect(followServer(server, { ...server, rules: { disk: false } }, server, sameThreshold)).toBeUndefined()
  })
})
