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
    const row = () =>
      db()
        .select()
        .from(schema.serviceOverrides)
        .all()
        .find((r) => r.serviceKey === 'ct:a')
    expect(row()).toMatchObject({ name: 'A', pinned: true, hidden: true })
    ov.saveOverride(ov.validateOverride({ key: 'ct:a', name: '', pinned: false }))
    expect(row()).toMatchObject({ name: null, pinned: false, hidden: false })
    ov.deleteOverride('ct:a')
    expect(row()).toBeUndefined()
  })

  it('moves a service to another group without touching its other fields', () => {
    const row = (key: string) =>
      db()
        .select()
        .from(schema.serviceOverrides)
        .all()
        .find((r) => r.serviceKey === key)
    ov.saveOverride(ov.validateOverride({ key: 'ct:b', name: 'B', icon: 'jellyfin', pinned: true }))
    ov.setGroup('ct:b', ' Medien ')
    expect(row('ct:b')).toMatchObject({ name: 'B', icon: 'jellyfin', pinned: true, hidden: false, group: 'Medien' })
    // No override yet: one is created with only the group.
    ov.setGroup('ct:c', 'Tools')
    expect(row('ct:c')).toMatchObject({ name: null, group: 'Tools', pinned: false })
    // Manual links keep their group in their own row.
    const link = db().insert(schema.manualServices).values({ name: 'NAS', url: 'http://nas.local/', group: 'Links' }).returning().get()
    ov.setGroup(`manual:${link.id}`, 'Netzwerk')
    expect(
      db()
        .select()
        .from(schema.manualServices)
        .all()
        .find((l) => l.id === link.id),
    ).toMatchObject({ name: 'NAS', url: 'http://nas.local/', group: 'Netzwerk' })
    expect(row(`manual:${link.id}`)).toBeUndefined()
    expect(() => ov.setGroup('manual:99999', 'X')).toThrow()
    expect(() => ov.setGroup('ct:b', '  ')).toThrow()
    expect(() => ov.setGroup('bad key', 'X')).toThrow()
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
