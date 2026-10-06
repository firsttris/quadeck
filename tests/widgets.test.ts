import { describe, expect, it } from 'vitest'
import { defaultConfig, INSTANCE_ID, linkify, parseWidgetConfig, WIDGETS, BUILTIN_CARDS, INSTANCE_KINDS } from '~/shared/widgets'

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
})
