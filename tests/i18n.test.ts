import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { currentLang, langOfRequest, localize, localizeDeep, msg, setLangResolver } from '~/shared/i18n'

const g = globalThis as unknown as { __quadeckLang?: unknown }
afterEach(() => {
  delete g.__quadeckLang
})

const de = JSON.parse(readFileSync('messages/de.json', 'utf8')) as Record<string, unknown>
const en = JSON.parse(readFileSync('messages/en.json', 'utf8')) as Record<string, unknown>
const keys = Object.keys(de).filter((k) => k !== '$schema')

describe('msg()', () => {
  it('answers in the viewer language, or keeps key and inputs when nobody is asking', () => {
    setLangResolver(() => 'en')
    expect(msg('common_save')).toBe('Save')
    setLangResolver(() => 'de')
    expect(msg('proxy_errors_exists', { a: 'x.example.com', line: 6 })).toBe('x.example.com gibt es schon (Zeile 6)')
    setLangResolver(() => undefined)
    const marked = `Paket: ${msg('proxy_errors_exists', { a: 'x.example.com', line: 6 })} (404)`
    expect(marked).toContain('\u0002["proxy_errors_exists"')
    expect(localize(marked, 'de')).toBe('Paket: x.example.com gibt es schon (Zeile 6) (404)')
    expect(localize(marked, 'en')).toBe('Paket: x.example.com exists already (line 6) (404)')
    expect(currentLang()).toBe('de')
  })

  it('renders messages inside inputs, numbers per language, plurals and variants', () => {
    setLangResolver(() => undefined)
    const nested = msg('packages_error', { message: msg('fstab_noFileSystem') })
    expect(localize(nested, 'de')).toBe('Fehler: kein Dateisystem')
    expect(localize(nested, 'en')).toBe('Error: no file system')
    expect(localize(msg('common_gib', { value: 1.5 }), 'de')).toBe('1,5 GiB')
    expect(localize(msg('common_gib', { value: 1.5 }), 'en')).toBe('1.5 GiB')
    expect(localize(msg('common_items', { n: 1 }), 'en')).toBe('1 entry')
    expect(localize(msg('common_items', { n: 3 }), 'de')).toBe('3 Einträge')
    expect(localize(msg('timers_editor_saved', { name: 'b', enabled: 'true' }), 'de')).toBe('b.timer gespeichert und aktiviert')
    expect(localize(msg('timers_editor_saved', { name: 'b', enabled: 'false' }), 'en')).toBe('b.timer saved')
  })

  it('still reads entries stored by the previous version (both texts side by side)', () => {
    expect(localize('\u0002Gespeichert\u001fSaved\u0003', 'en')).toBe('Saved')
    expect(localize('unrar: CRC failed', 'en')).toBe('unrar: CRC failed')
  })

  it('localizes nested JSON and leaves other values alone', () => {
    setLangResolver(() => undefined)
    const data = { error: msg('common_save'), list: [msg('common_cancel'), 3, null], n: 1, ok: true }
    expect(localizeDeep(data, 'en')).toEqual({ error: 'Save', list: ['Cancel', 3, null], n: 1, ok: true })
    const plain = { a: 'x', b: [1] }
    expect(localizeDeep(plain, 'en')).toBe(plain)
  })

  it('picks the language from the cookie, then from the browser', () => {
    expect(langOfRequest('a=1; qd_lang=en', 'de-DE,de')).toBe('en')
    expect(langOfRequest(null, 'de-DE,de;q=0.9,en;q=0.8')).toBe('de')
    expect(langOfRequest(null, 'fr-FR,fr')).toBe('en')
    expect(langOfRequest('qd_lang=xx', 'de')).toBe('de')
  })
})

/** Placeholders a message uses, over all variants. */
const placeholders = (v: unknown) => new Set([...JSON.stringify(v).matchAll(/(?<!\\\\)\{(\w+)\}/g)].map((m) => m[1]!))
/** English needs no word here that German has (“um 6 Uhr” / “at 6”), or German needs a lower-cased copy. */
const EMPTY_IN_EN = ['notifications_rules_oclock', 'quadlets_editor_thenAfter']
const OWN_PLACEHOLDERS = ['shell_actions_confirmTitle']

describe('messages/*.json', () => {
  it('has every message in both languages, none empty, with the same placeholders', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort())
    const empty = keys.filter((k) => !EMPTY_IN_EN.includes(k) && [de[k], en[k]].some((v) => typeof v === 'string' && !v.trim() && /\p{L}/u.test(String(de[k]))))
    expect(empty).toEqual([])
    const differ = keys.filter((k) => !OWN_PLACEHOLDERS.includes(k) && JSON.stringify([...placeholders(de[k])].sort()) !== JSON.stringify([...placeholders(en[k])].sort()))
    expect(differ).toEqual([])
  })

  it('every message is used, every used key exists', () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'paraglide' ? [] : files(join(dir, e.name))) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []))
    const sources = files('src').map((f) => readFileSync(f, 'utf8'))
    const code = sources.join('\n')
    // m.key() calls only count in files that import the Paraglide messages as m (elsewhere m is often a regex match)
    const mCode = sources.filter((s) => s.includes("import { m } from '~/paraglide/messages'")).join('\n')
    const used = new Set([...code.matchAll(/\bm\.(\w+)\b/g), ...code.matchAll(/'([a-z][A-Za-z0-9]*_[A-Za-z0-9_]+)'/g)].map((m) => m[1]!))
    expect(keys.filter((k) => !used.has(k))).toEqual([])
    expect([...mCode.matchAll(/\bm\.(\w+)\(/g)].map((m) => m[1]!).filter((k) => !(k in de))).toEqual([])
  })
})
