/**
 * The UI language. Texts live in messages/{de,en}.json and are compiled by
 * Paraglide to src/paraglide: components call them directly (m.units_title()),
 * code outside of components uses msg(m.units_title) from ~/shared/i18n.
 * The language comes from the qd_lang cookie, else from the browser
 * (Accept-Language), so the server renders the page in the right language.
 */
import { Fragment, createContext, createElement, useContext, type ReactNode } from 'react'
import { api } from '~/lib/api'
import { LANG_COOKIE, setClientLang, type Lang } from '~/shared/i18n'

const Ctx = createContext<Lang>('de')

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  setClientLang(lang)
  return <Ctx.Provider value={lang}>{children}</Ctx.Provider>
}

/** The current language. */
export const useLang = (): Lang => useContext(Ctx)

/**
 * Switches the language: remembered in a cookie (and on the server for e-mails
 * and push messages), then the page reloads so live data comes in the new language too.
 */
export async function switchLang(lang: Lang) {
  document.cookie = `${LANG_COOKIE}=${lang}; path=/; max-age=31536000; samesite=strict`
  await api('/api/lang', { body: { lang } }).catch(() => {}) // not logged in yet: the cookie is enough
  location.reload()
}

export { LANGS, type Lang } from '~/shared/i18n'

/** A message chosen by a runtime key (status, kind …); unknown keys come back as they are. */
export function pickMsg(map: Record<string, () => string>, key: string): string {
  return map[key]?.() ?? key
}

/**
 * A message with React elements in it: the message gets the parameter names
 * as placeholders, the text around them stays plain, the elements go in between.
 *   rich(m.boot_paramsGrub, { file: <code>/etc/default/grub</code> })
 */
export function rich<P extends Record<string, ReactNode>>(message: (inputs: Record<keyof P, string>) => string, parts: P): ReactNode {
  const marks = Object.fromEntries(Object.keys(parts).map((k) => [k, `\u0001${k}\u0001`])) as Record<keyof P, string>
  const pieces = message(marks).split(/\u0001(\w+)\u0001/)
  return createElement(Fragment, null, ...pieces.map((p, i) => (i % 2 ? createElement(Fragment, { key: i }, parts[p as keyof P]) : p)))
}
