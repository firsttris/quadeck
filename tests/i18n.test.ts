import { afterEach, describe, expect, it } from 'vitest'
import { currentLang, langOfRequest, localize, localizeDeep, setLangResolver, tr } from '~/shared/i18n'
import { messages } from '~/i18n'

const g = globalThis as unknown as { __quadeckLang?: unknown }
afterEach(() => {
  delete g.__quadeckLang
})

/** German needs a word here that English does not ("um 6 Uhr" / "at 6"). */
const EMPTY_IN_EN = ['t.notifications.rules.oclock']

describe('i18n', () => {
  it('answers in the viewer language, or keeps both when nobody is asking', () => {
    setLangResolver(() => 'en')
    expect(tr('Gespeichert', 'Saved')).toBe('Saved')
    setLangResolver(() => undefined)
    const both = `Paket: ${tr('Datei fehlt', 'File missing')} (404)`
    expect(localize(both, 'de')).toBe('Paket: Datei fehlt (404)')
    expect(localize(both, 'en')).toBe('Paket: File missing (404)')
    expect(currentLang()).toBe('de')
  })

  it('localizes nested JSON and leaves other values alone', () => {
    setLangResolver(() => undefined)
    const data = { error: tr('kaputt', 'broken'), list: [tr('a', 'b'), 3, null], n: 1, ok: true }
    expect(localizeDeep(data, 'en')).toEqual({ error: 'broken', list: ['b', 3, null], n: 1, ok: true })
    const plain = { a: 'x', b: [1] }
    expect(localizeDeep(plain, 'en')).toBe(plain)
  })

  it('picks the language from the cookie, then from the browser', () => {
    expect(langOfRequest('a=1; qd_lang=en', 'de-DE,de')).toBe('en')
    expect(langOfRequest(null, 'de-DE,de;q=0.9,en;q=0.8')).toBe('de')
    expect(langOfRequest(null, 'fr-FR,fr')).toBe('en')
    expect(langOfRequest('qd_lang=xx', 'de')).toBe('de')
  })

  it('has every German text in English too, and none of them empty', () => {
    const walk = (de: unknown, en: unknown, path: string): string[] => {
      if (typeof de === 'function') return typeof en === 'function' ? [] : [path]
      if (typeof de === 'string') return typeof en === 'string' && (en.trim() || !/\p{L}/u.test(de) || EMPTY_IN_EN.includes(path)) ? [] : [path]
      if (de && typeof de === 'object') return Object.keys(de).flatMap((k) => walk((de as Record<string, unknown>)[k], (en as Record<string, unknown> | undefined)?.[k], `${path}.${k}`))
      return []
    }
    expect(walk(messages.de, messages.en, 't')).toEqual([])
  })
})
