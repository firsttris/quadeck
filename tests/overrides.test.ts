import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseIconIndex, searchIcons } from '~/server/icons'

process.env.QUADECK_DATA_DIR = mkdtempSync(join(tmpdir(), 'quadeck-ov-'))
const ov = await import('~/server/overrides')
const { db, schema } = await import('~/server/db')

describe('service overrides', () => {
  it('validates input', () => {
    expect(ov.validateOverride({ key: 'ct:jellyfin', name: ' Kino ', group: '', url: '', icon: 'Jellyfin', pinned: true })).toEqual({
      key: 'ct:jellyfin',
      name: 'Kino',
      group: undefined,
      url: undefined,
      icon: 'jellyfin',
      hidden: false,
      pinned: true,
    })
    expect(() => ov.validateOverride({ key: 'bad key' })).toThrow()
    expect(() => ov.validateOverride({ key: 'manual:1' })).toThrow(/direkt/)
    expect(() => ov.validateOverride({ key: 'ct:a', url: 'javascript:alert(1)' })).toThrow(/http/)
    expect(() => ov.validateOverride({ key: 'ct:a', icon: '../x' })).toThrow(/Icon/)
    expect(ov.validateOverride({ key: 'ct:a', icon: 'glyph:play' }).icon).toBe('glyph:play')
  })

  it('upserts, toggles hidden without touching other fields, and deletes', () => {
    ov.saveOverride(ov.validateOverride({ key: 'ct:a', name: 'A', pinned: true }))
    ov.setHidden('ct:a', true)
    const row = () => db().select().from(schema.serviceOverrides).all().find((r) => r.serviceKey === 'ct:a')
    expect(row()).toMatchObject({ name: 'A', pinned: true, hidden: true })
    ov.saveOverride(ov.validateOverride({ key: 'ct:a', name: '', pinned: false }))
    expect(row()).toMatchObject({ name: null, pinned: false, hidden: false })
    ov.deleteOverride('ct:a')
    expect(row()).toBeUndefined()
  })
})

describe('icon search', () => {
  it('ranks prefix matches, then substrings, then aliases', () => {
    const idx = parseIconIndex({ svg: ['jellyfin.svg', 'jellyseerr.svg', 'my-jelly.svg', 'home-assistant.svg'] }, { 'home-assistant': { aliases: ['hass'] } })
    expect(searchIcons(idx, 'jelly')).toEqual(['jellyfin', 'jellyseerr', 'my-jelly'])
    expect(searchIcons(idx, 'hass')).toEqual(['home-assistant'])
    expect(searchIcons(idx, '', 2)).toHaveLength(2)
  })
})
