import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeLayout } from '~/components/EditableGrid'

process.env.QUADECK_DATA_DIR = mkdtempSync(join(tmpdir(), 'quadeck-layout-'))
const layout = await import('~/server/layout')

const spec = { rowHeight: 20, margin: [16, 16] as [number, number] }

describe('mergeLayout', () => {
  const defaults = [
    { i: 'cpu', x: 0, y: 0, w: 3, h: 4 },
    { i: 'services', x: 0, y: 4, w: 8, minH: 3 }, // automatic height
  ]

  it('uses defaults and measures automatic heights', () => {
    const l = mergeLayout(defaults, undefined, { services: 500 }, spec)
    expect(l[0]).toMatchObject({ i: 'cpu', x: 0, y: 0, w: 3, h: 4, auto: false })
    // 500 px content → ceil((500 + 16) / 36) = 15 rows
    expect(l[1]).toMatchObject({ i: 'services', h: 15, auto: true })
  })

  it('keeps saved positions; h = 0 stays automatic, a saved height is fixed', () => {
    const saved = [
      { i: 'services', x: 4, y: 0, w: 8, h: 0 },
      { i: 'cpu', x: 0, y: 0, w: 4, h: 6 },
    ]
    const l = mergeLayout(defaults, saved, { services: 140 }, spec)
    expect(l.find((x) => x.i === 'services')).toMatchObject({ x: 4, w: 8, h: 5, auto: true })
    expect(l.find((x) => x.i === 'cpu')).toMatchObject({ w: 4, h: 6, auto: false })
    const fixed = mergeLayout(defaults, [{ i: 'services', x: 0, y: 0, w: 8, h: 9 }], { services: 900 }, spec)
    expect(fixed.find((x) => x.i === 'services')).toMatchObject({ h: 9, auto: false })
  })

  it('places items without a saved position below the saved ones', () => {
    const l = mergeLayout(defaults, [{ i: 'services', x: 0, y: 0, w: 8, h: 0 }], {}, spec)
    expect(l.find((x) => x.i === 'cpu')!.y).toBeGreaterThanOrEqual(1000)
  })
})

describe('layout storage', () => {
  it('validates, upserts per scope and breakpoint, hides cards and resets', () => {
    expect(() => layout.parseSave({ scope: 'evil', breakpoint: 'lg', items: [] })).toThrow()
    expect(() => layout.parseSave({ scope: 'page', breakpoint: 'lg', items: [{ i: 'x', x: -1, y: 0, w: 1, h: 1 }] })).toThrow()
    expect(() => layout.parseSave({ scope: 'page', breakpoint: 'lg', items: [{ i: 'a b', x: 0, y: 0, w: 1, h: 1 }] })).toThrow()
    const ok = layout.parseSave({ scope: 'tiles', breakpoint: 'md', items: [{ i: 'ct:jellyfin', x: 2, y: 0, w: 2, h: 2 }] })
    layout.saveLayout(ok.scope, ok.breakpoint, ok.items)
    layout.saveLayout('tiles', 'md', [{ i: 'manual:3', x: 0, y: 0, w: 1, h: 1 }])
    layout.saveLayout('tiles', 'md', [{ i: 'ct:jellyfin', x: 0, y: 1, w: 3, h: 2 }])
    layout.setCardHidden('storage', true)
    const got = layout.getLayout()
    expect(got.layouts.tiles.md).toEqual(
      expect.arrayContaining([
        { i: 'ct:jellyfin', x: 0, y: 1, w: 3, h: 2 },
        { i: 'manual:3', x: 0, y: 0, w: 1, h: 1 },
      ]),
    )
    expect(got.hidden).toEqual(['storage'])
    layout.setCardHidden('storage', false)
    expect(layout.getLayout().hidden).toEqual([])
    layout.resetLayout()
    expect(layout.getLayout()).toEqual({ layouts: { page: {}, tiles: {} }, hidden: [], widgets: [] })
  })
})

describe('widgets from the catalog', () => {
  it('adds notes with their own ids and settings, updates and removes them with their positions', () => {
    const a = layout.addWidget('note', { title: '  Gäste-WLAN ', text: 'Passwort im Vaultwarden\r\nhttps://vault.home' })
    const b = layout.addWidget('note', {})
    expect(a.id).toMatch(/^note-[0-9a-f]{12}$/)
    expect(a.id).not.toBe(b.id)
    expect(a.config).toEqual({ title: 'Gäste-WLAN', text: 'Passwort im Vaultwarden\nhttps://vault.home' })
    expect(b.config).toEqual({ title: '', text: '' })
    layout.saveLayout('page', 'lg', [{ i: a.id, x: 0, y: 3, w: 4, h: 0 }])
    layout.saveLayout('page', 'xs', [{ i: a.id, x: 0, y: 9, w: 1, h: 0 }])
    expect(layout.getLayout().widgets.map((w) => w.id)).toEqual([a.id, b.id])

    expect(layout.updateWidget(b.id, { title: 'Wartung', text: 'Disk2 tauschen' }).config).toEqual({ title: 'Wartung', text: 'Disk2 tauschen' })
    expect(layout.getLayout().widgets.find((w) => w.id === b.id)!.config).toEqual({ title: 'Wartung', text: 'Disk2 tauschen' })

    layout.removeWidget(a.id)
    const after = layout.getLayout()
    expect(after.widgets.map((w) => w.id)).toEqual([b.id])
    expect(after.layouts.page.lg ?? []).not.toContainEqual(expect.objectContaining({ i: a.id }))
    expect(after.layouts.page.xs ?? []).not.toContainEqual(expect.objectContaining({ i: a.id }))
    // the reset only moves things back: added widgets and their text stay
    layout.resetLayout()
    expect(layout.getLayout().widgets.map((w) => w.id)).toEqual([b.id])
    layout.removeWidget(b.id)
  })

  it('refuses unknown kinds, oversized text, foreign ids and built-in cards', () => {
    expect(() => layout.addWidget('cpu', {})).toThrow()
    expect(() => layout.addWidget('evil', {})).toThrow()
    expect(() => layout.addWidget('note', { text: 'x'.repeat(4001) })).toThrow()
    expect(() => layout.addWidget('note', { title: 'x'.repeat(81) })).toThrow()
    expect(() => layout.updateWidget('storage', { text: 'x' })).toThrow()
    expect(() => layout.updateWidget('note-000000000000', { text: 'x' })).toThrow()
    expect(() => layout.removeWidget('../x')).toThrow()
    // a card's hidden flag is not a widget
    layout.setCardHidden('timers', true)
    expect(() => layout.removeWidget('timers')).toThrow()
    expect(layout.getLayout().widgets).toEqual([])
    layout.setCardHidden('timers', false)
  })
})

describe('mergeLayout minimum height', () => {
  it('raises saved heights below minH (cards that grew since the layout was saved)', () => {
    const spec = { rowHeight: 20, margin: [16, 16] as [number, number] }
    const out = mergeLayout([{ i: 'cpu', x: 0, y: 0, w: 3, minH: 6 }], [{ i: 'cpu', x: 0, y: 0, w: 3, h: 4 }], {}, spec)
    expect(out[0]!.h).toBe(6)
  })
})
