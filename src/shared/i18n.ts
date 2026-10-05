// Language handling shared by server, helper and browser. The texts live in
// messages/{de,en}.json (Paraglide, compiled to src/paraglide).
//
// Components call the generated functions directly: m.units_title(). Code
// outside of components – server errors, messages of the root helper, notes
// computed in src/shared – uses msg(m.units_title, inputs): inside a request
// (or in the browser) it returns the viewer's language right away; where no
// viewer is known (background jobs, the root helper) it returns the key and
// its inputs, marked as \u0002["key",{…}]\u0003, and the response, the event
// stream or the notification renders it in the right language later.
//
// Messages are always named statically (m.key), so the browser bundle only
// carries the ones its pages use. The table from key to message, needed for
// the marks, lives on the server only (registerMessages in src/server/lang.ts).

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
/** undefined = no viewer known: messages stay language-neutral (key and inputs). */
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

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** A compiled Paraglide message, e.g. m.units_title. */
export type Message = (inputs: any, options?: { locale?: Lang }) => string
type Inputs<F extends Message> = Parameters<F>[0]

// On globalThis, like the language: every copy of this module shares the server's table.
const table = globalThis as unknown as { __quadeckMessages?: { byKey: Map<string, Message>; keyOf: Map<Message, string> } }

/** Server: every message by key, so msg() can mark messages and localize() render the marks. */
export function registerMessages(all: Record<string, Message>) {
  const t = (table.__quadeckMessages ??= { byKey: new Map(), keyOf: new Map() })
  for (const [key, fn] of Object.entries(all)) {
    t.byKey.set(key, fn)
    t.keyOf.set(fn, key)
  }
}

/** A message for code outside of components; see the top of this file. */
export function msg<F extends Message>(fn: F, ...args: undefined extends Inputs<F> ? [inputs?: Inputs<F>] : [inputs: Inputs<F>]): string {
  const lang = resolver()
  const inputs = (args[0] ?? {}) as Record<string, unknown>
  if (lang) return render(fn, inputs, lang)
  const key = table.__quadeckMessages?.keyOf.get(fn)
  if (key) return `\u0002${JSON.stringify([key, inputs])}\u0003`
  // No table in this process: both texts side by side, which localize() reads as well.
  return `\u0002${render(fn, inputs, 'de')}\u001f${render(fn, inputs, 'en')}\u0003`
}

function render(fn: Message, inputs: Record<string, unknown>, lang: Lang): string {
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
        const fn = table.__quadeckMessages?.byKey.get(key)
        return fn ? render(fn, inputs ?? {}, lang) : key
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
