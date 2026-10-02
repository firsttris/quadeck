// The viewer's language for the duration of a request (see src/shared/i18n.ts).

import { AsyncLocalStorage } from 'node:async_hooks'
import { currentLang, langOfRequest, localize, localizeDeep, setLangResolver, type Lang } from '~/shared/i18n'

const store = new AsyncLocalStorage<Lang>()

/** Web process: tr() answers in the language of the current request; outside of one it keeps both. */
export function installRequestLang() {
  setLangResolver(() => store.getStore())
}

/** Root helper and jobs: no viewer, every text keeps both languages. */
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

/** JSON responses: texts from the helper or the background carry both languages – pick the viewer's. */
export async function localizeResponse(res: Response, lang: Lang = currentLang()): Promise<Response> {
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return res
  const text = await res.text()
  const body = text.includes('\\u0002') || text.includes('\u0002') ? JSON.stringify(localizeDeep(JSON.parse(text), lang)) : text
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
}

export { localize, localizeDeep }
