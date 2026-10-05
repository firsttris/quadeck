// The viewer's language for the duration of a request (see src/shared/i18n.ts).

import { AsyncLocalStorage } from 'node:async_hooks'
import { m as messages } from '~/paraglide/messages'
import { currentLang, langOfRequest, localize, localizeDeep, registerMessages, setLangResolver, type Lang, type Message } from '~/shared/i18n'

// The full message table, server-side only: marks carry the key and are rendered by it later.
registerMessages(messages as unknown as Record<string, Message>)

// One store per process: main.ts and the bundled server routes each load their own copy of this module.
const g = globalThis as unknown as { __quadeckLangStore?: AsyncLocalStorage<Lang> }
const store = (g.__quadeckLangStore ??= new AsyncLocalStorage<Lang>())

/** Web process: msg() answers in the language of the current request; outside of one it keeps key and inputs. */
export function installRequestLang() {
  setLangResolver(() => store.getStore())
}

/** Root helper and jobs: no viewer, every message stays language-neutral (key and inputs). */
export function installNoLang() {
  setLangResolver(() => undefined)
}

export const requestLang = (req: Request): Lang => langOfRequest(req.headers.get('cookie'), req.headers.get('accept-language'))

export function withRequestLang<T>(req: Request, fn: () => T): T {
  return store.run(requestLang(req), fn)
}

/** Work that outlives the request (collectors, timers) must not inherit its language. */
export function outsideRequest<T>(fn: () => T): T {
  return store.exit(fn)
}

/**
 * Objects that keep or broadcast what they produce (hub, notifier, privileged
 * backends): every method runs without the caller's language, so stored texts
 * stay language-neutral and each viewer gets their language at the response.
 */
export function bilingual<T extends object>(obj: T): T {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown
      return typeof v === 'function' ? (...args: unknown[]) => store.exit(() => (v as (...a: unknown[]) => unknown).apply(target, args)) : v
    },
  })
}

/** JSON responses: messages from the helper or the background are rendered in the viewer's language. */
export async function localizeResponse(res: Response, lang: Lang = currentLang()): Promise<Response> {
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return res
  const text = await res.text()
  const body = text.includes('\\u0002') || text.includes('\u0002') ? JSON.stringify(localizeDeep(JSON.parse(text), lang)) : text
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
}

export { localize, localizeDeep }
