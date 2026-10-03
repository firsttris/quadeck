/**
 * UI texts in German and English. Each namespace file exports `de` (defines the
 * shape) and `en` (must match it, checked by tsc). Components take their texts
 * from `useT()`; code outside of components uses `tr(de, en)` from ~/shared/i18n.
 * The language comes from the qd_lang cookie, else from the browser (Accept-Language),
 * so the server renders the page in the right language already.
 */
import { Fragment, createContext, createElement, useContext, type ReactNode } from 'react'
import { api } from '~/lib/api'
import { LANG_COOKIE, setClientLang, type Lang } from '~/shared/i18n'
import * as boot from './boot'
import * as common from './common'
import * as disks from './disks'
import * as files from './files'
import * as hardware from './hardware'
import * as journal from './journal'
import * as network from './network'
import * as notifications from './notifications'
import * as overview from './overview'
import * as podman from './podman'
import * as proxy from './proxy'
import * as quadlets from './quadlets'
import * as shares from './shares'
import * as shell from './shell'
import * as ssh from './ssh'
import * as system from './system'
import * as systemd from './systemd'
import * as timers from './timers'
import * as units from './units'
import * as users from './users'

const NS = { common, shell, overview, units, journal, timers, quadlets, systemd, podman, disks, files, shares, system, boot, hardware, network, proxy, ssh, users, notifications }
type Ns = typeof NS

export type Messages = { [K in keyof Ns]: Ns[K]['de'] }

const pickNs = (lang: Lang) => Object.fromEntries(Object.entries(NS).map(([k, v]) => [k, v[lang]])) as Messages

export const messages: Record<Lang, Messages> = { de: pickNs('de'), en: pickNs('en') }

const Ctx = createContext<Lang>('de')

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  setClientLang(lang)
  return <Ctx.Provider value={lang}>{children}</Ctx.Provider>
}

/** The current language. */
export const useLang = (): Lang => useContext(Ctx)

/** The texts of the current language. */
export const useT = (): Messages => messages[useLang()]

/**
 * Switches the language: remembered in a cookie (and on the server for e-mails
 * and push messages), then the page reloads so live data comes in the new language too.
 */
export async function switchLang(lang: Lang) {
  document.cookie = `${LANG_COOKIE}=${lang}; path=/; max-age=31536000; samesite=strict`
  await api('/api/lang', { body: { lang } }).catch(() => {}) // not logged in yet: the cookie is enough
  location.reload()
}

export { LANGS, tr, type Lang } from '~/shared/i18n'

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

