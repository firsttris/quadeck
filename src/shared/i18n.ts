// Language handling shared by server, helper and browser. The texts live in
// messages/{de,en}.json (Paraglide, compiled to src/paraglide).
//
// Components call the generated functions directly: m.units_title(). Code
// outside of components – server errors, messages of the root helper, notes
// computed in src/shared – uses msg('units_title', inputs): inside a request
// (or in the browser) it returns the viewer's language right away; where no
// viewer is known (background jobs, the root helper) it returns the key and
// its inputs, marked as \u0002["key",{…}]\u0003, and the response, the event
// stream or the notification renders it in the right language later.

import { m as messages } from '~/paraglide/messages'
import { overwriteGetLocale } from '~/paraglide/runtime'

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

// Paraglide's m.*() ask getLocale(): answer with the same source as everything else.
overwriteGetLocale(() => resolver() ?? 'de')

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

/**
 * A text from a namespace file (src/i18n/<ns>.ts) in code outside of
 * components – server, root helper, src/shared. Same rules as tr(): the
 * viewer's language inside a request, both languages where nobody is asking.
 *   msg(proxy, (m) => m.errors.exists(address, line))
 */
export function legacyMsg<T>(ns: { de: T; en: T }, pick: (m: T) => string): string {
  return tr(pick(ns.de), pick(ns.en))
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

type Messages = typeof messages
export type MsgKey = keyof Messages
type Inputs<K extends MsgKey> = Parameters<Messages[K]>[0]

/** A message by key, for code outside of components; see the top of this file. */
export function msg<K extends MsgKey>(key: K, ...args: undefined extends Inputs<K> ? [inputs?: Inputs<K>] : [inputs: Inputs<K>]): string {
  const lang = resolver()
  const inputs = (args[0] ?? {}) as Record<string, unknown>
  if (lang) return render(key, inputs, lang)
  return `\u0002${JSON.stringify([key, inputs])}\u0003`
}

function render(key: string, inputs: Record<string, unknown>, lang: Lang): string {
  const fn = (messages as unknown as Record<string, (i: unknown, o: { locale: Lang }) => string>)[key]
  if (!fn) return key
  // Inputs can be marked messages themselves (a reason inside an error).
  const resolved = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, typeof v === 'string' ? localize(v, lang) : v]))
  return fn(resolved, { locale: lang })
}

const MARKED = /\u0002([^\u0003]*?)(?:\u001f([^\u0003]*))?(?:\u0003|$)/g

/** Renders marked messages in one language; plain text stays as it is. */
export function localize(text: string, lang: Lang): string {
  if (!text.includes('\u0002')) return text
  return text.replace(MARKED, (_, body: string, en?: string) => {
    if (en === undefined && body.startsWith('[')) {
      try {
        const [key, inputs] = JSON.parse(body) as [string, Record<string, unknown>]
        return render(key, inputs ?? {}, lang)
      } catch {
        return body
      }
    }
    // Older entries (stored logs) carry both texts: de \u001f en.
    return lang === 'en' ? (en ?? body) : body
  })
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
