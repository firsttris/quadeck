import { describe, expect, it } from 'vitest'
import { filterPalette, paletteItems } from '~/lib/palette'
import type { Snapshot, Unit } from '~/shared/types'

const unit = (name: string, o: Partial<Unit> = {}): Unit => ({ name, description: name, load: 'loaded', active: 'active', sub: 'running', kind: 'quadlet', ...o })
const snap = {
  services: [
    {
      name: 'Medien',
      note: '',
      items: [{ key: 'ct:jellyfin', name: 'Jellyfin', url: 'https://jf.home', host: 'jf.home', group: 'Medien', icon: { kind: 'glyph', glyph: 'play' }, iconFallback: 'play', color: '#fff', health: 'ok', source: 'caddy', container: 'jellyfin' }],
    },
  ],
  units: [unit('jellyfin.service'), unit('broken.service', { active: 'failed', sub: 'failed', kind: 'service' }), unit('systemd-udevd.service', { kind: 'service', sub: 'running' }), unit('foo.timer', { kind: 'timer', sub: 'waiting' })],
} as unknown as Snapshot

describe('command palette', () => {
  const items = paletteItems(snap, false)

  it('offers pages, services, unit actions and journals', () => {
    expect(items.find((i) => i.label === 'Jellyfin')!.action).toEqual({ kind: 'open', url: 'https://jf.home' })
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['jellyfin.service neu starten', 'jellyfin.service stoppen', 'broken.service neu starten', 'Journal: broken.service']))
    expect(items.some((i) => i.label.includes('foo.timer'))).toBe(false)
  })

  it('has no unit actions in read-only mode', () => {
    expect(paletteItems(snap, true).some((i) => i.section === 'Units')).toBe(false)
  })

  it('filters by all words and ranks the service first', () => {
    const r = filterPalette(items, 'jelly')
    expect(r[0]!.label).toBe('Jellyfin')
    expect(r.map((i) => i.label)).toContain('jellyfin.service neu starten')
    expect(filterPalette(items, 'jelly stopp').map((i) => i.label)).toEqual(['jellyfin.service stoppen'])
    expect(filterPalette(items, 'xyz')).toEqual([])
    expect(filterPalette(items, '').every((i) => i.section === 'Seiten' || i.section === 'Services')).toBe(true)
  })
})
