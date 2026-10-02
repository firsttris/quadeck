// Language handling shared by server, helper and browser.
//
// Texts in components come from `useT()` (src/i18n). Texts built outside of
// components – server errors, messages of the root helper, notes computed in
// src/shared – use `tr(de, en)`: inside a request (or in the browser) it returns
// the viewer's language right away; where no viewer is known (background jobs,
// the root helper) it returns both, marked as \u0002 de \u001f en \u0003, and the
// response, the event stream or the notification picks the language later.

export type Lang = 'de' | 'en'
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'de', label: 'Deutsch' },
  { id: 'en', label: 'English' },
]
export const LANG_COOKIE = 'qd_lang'

export const isLang = (v: unknown): v is Lang => v === 'de' || v === 'en'

let clientLang: Lang = 'de'
// On globalThis: main.ts and the bundled server routes each have their own copy of this module.
const g = globalThis as unknown as { __quadeckLang?: () => Lang | undefined }
/** undefined = no viewer known: keep both languages. */
const resolver = (): Lang | undefined => (g.__quadeckLang ? g.__quadeckLang() : clientLang)

/** Server/helper: where the viewer's language comes from (undefined = unknown, keep both). */
export function setLangResolver(fn: () => Lang | undefined) {
  g.__quadeckLang = fn
}

/** Browser: the language the page was rendered in. */
export function setClientLang(lang: Lang) {
  clientLang = lang
}

export function currentLang(): Lang {
  return resolver() ?? 'de'
}

/** Intl locale for a language (24 h clock in English, too). */
export const localeOf = (lang: Lang = currentLang()) => (lang === 'en' ? 'en-GB' : 'de-DE')

/** A text in both languages; see above. */
export function tr(de: string, en: string): string {
  const lang = resolver()
  if (lang) return lang === 'en' ? en : de
  return `\u0002${de}\u001f${en}\u0003`
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const MARKED = /\u0002([^\u0003]*?)(?:\u001f([^\u0003]*))?(?:\u0003|$)/g

/** Picks one language out of marked text; plain text stays as it is. */
export function localize(text: string, lang: Lang): string {
  if (!text.includes('\u0002')) return text
  return text.replace(MARKED, (_, de: string, en?: string) => (lang === 'en' ? (en ?? de) : de))
}

/** localize() for every string inside a JSON-like value. */
export function localizeDeep<T>(value: T, lang: Lang): T {
  if (typeof value === 'string') return localize(value, lang) as T
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((v) => {
      const l = localizeDeep(v, lang)
      if (l !== v) changed = true
      return l
    })
    return (changed ? out : value) as T
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const l = localizeDeep(v, lang)
      if (l !== v) changed = true
      out[k] = l
    }
    return (changed ? out : value) as T
  }
  return value
}

/** Language of a request: the cookie, else the browser's preference. */
export function langOfRequest(cookieHeader: string | null | undefined, acceptLanguage: string | null | undefined): Lang {
  const m = /(?:^|;\s*)qd_lang=(de|en)(?:;|$)/.exec(cookieHeader ?? '')
  if (m) return m[1] as Lang
  // Like the browser: the first preferred language; German if that is German, else English.
  return (acceptLanguage ?? '').trim().toLowerCase().startsWith('de') ? 'de' : 'en'
}
