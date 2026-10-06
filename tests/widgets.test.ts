import { describe, expect, it } from 'vitest'
import { defaultConfig, FRESH_DEFAULTS, INSTANCE_ID, linkify, parseWidgetConfig, topContainers, WIDGETS, BUILTIN_CARDS, INSTANCE_KINDS } from '~/shared/widgets'

describe('widget definitions', () => {
  it('every widget has its metadata; built-ins are single, notes can be added several times', () => {
    for (const k of [...BUILTIN_CARDS, ...INSTANCE_KINDS]) expect(WIDGETS[k]).toBeDefined()
    expect(BUILTIN_CARDS.every((k) => !WIDGETS[k].multi)).toBe(true)
    expect(WIDGETS.note).toMatchObject({ multi: true, configurable: true })
    expect(INSTANCE_ID.test('note-a1b2c3d4e5f6')).toBe(true)
    expect(INSTANCE_ID.test('cpu')).toBe(false)
  })

  it('note config: trimmed title, CRLF to LF, length limits, junk ignored', () => {
    expect(defaultConfig('note')).toEqual({ title: '', text: '' })
    expect(parseWidgetConfig('note', { title: ' A ', text: 'a\r\nb', evil: '<script>' })).toEqual({ title: 'A', text: 'a\nb' })
    expect(parseWidgetConfig('note', { title: 3, text: null })).toEqual({ title: '', text: '' })
    expect(() => parseWidgetConfig('note', { text: 'x'.repeat(4001) })).toThrow()
  })

  it('only http(s) URLs become links, trailing punctuation stays text', () => {
    expect(linkify('see https://vault.home/x, or http://192.168.178.1.')).toEqual([{ text: 'see ' }, { text: 'https://vault.home/x', href: 'https://vault.home/x' }, { text: ', or ' }, { text: 'http://192.168.178.1', href: 'http://192.168.178.1' }, { text: '.' }])
    expect(linkify('javascript:alert(1) and file:///etc/passwd')).toEqual([{ text: 'javascript:alert(1) and file:///etc/passwd' }])
    expect(linkify('')).toEqual([])
  })

  it('disk and container settings; single widgets have none', () => {
    expect(defaultConfig('disk')).toEqual({ mount: '' })
    expect(parseWidgetConfig('disk', { mount: '/mnt/disk1' })).toEqual({ mount: '/mnt/disk1' })
    expect(() => parseWidgetConfig('disk', { mount: 'mnt' })).toThrow()
    expect(() => parseWidgetConfig('disk', { mount: '/mnt/a\nb' })).toThrow()
    expect(parseWidgetConfig('containers', { metric: 'cpu' })).toEqual({ metric: 'cpu' })
    expect(parseWidgetConfig('containers', { metric: 'evil' })).toEqual({ metric: 'ram' })
    expect(parseWidgetConfig('updates', { x: 1 })).toEqual({})
    expect(FRESH_DEFAULTS.every((k) => !WIDGETS[k].multi)).toBe(true)
    expect(WIDGETS.disk.multi && WIDGETS.containers.multi).toBe(true)
  })

  it('busiest containers: running only, by CPU or memory, at most five', () => {
    const c = (name: string, cpu: number, mem: number, state = 'running') => ({ name, state, cpu, memUsage: mem })
    const list = [c('a', 5, 100), c('b', 50, 10), c('c', 1, 900), c('d', 99, 999, 'exited'), c('e', 2, 5), c('f', 3, 6), c('g', 4, 7)]
    expect(topContainers(list, 'cpu').map((x) => x.name)).toEqual(['b', 'a', 'g', 'f', 'e'])
    expect(topContainers(list, 'ram').map((x) => x.name)).toEqual(['c', 'a', 'b', 'g', 'f'])
    expect(topContainers([{ name: 'x', state: 'running' }], 'cpu')).toHaveLength(1)
  })
})
