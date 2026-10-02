import { ActionError } from './hub'
import { HttpError, requireSession, type Session } from './auth'
import { localize, localizeResponse } from './lang'
import { currentLang, tr } from '~/shared/i18n'

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError || e instanceof ActionError) return Response.json({ error: localize(e.message, currentLang()) }, { status: e.status })
  console.error('[quadeck]', e)
  return Response.json({ error: localize((e as Error).message || tr('Interner Fehler', 'Internal error'), currentLang()) }, { status: 500 })
}

/** Wraps a server-route handler: requires a session (and CSRF token for writes) and maps errors to JSON. */
export function authed<C extends { request: Request }>(fn: (ctx: C, session: Session) => Promise<Response> | Response) {
  return async (ctx: C) => {
    try {
      return await localizeResponse(await fn(ctx, requireSession(ctx.request)))
    } catch (e) {
      return errorResponse(e)
    }
  }
}

export async function readJson<T>(request: Request): Promise<T> {
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) throw new HttpError(415, 'JSON erwartet')
  const text = await request.text()
  if (text.length > 64 * 1024) throw new HttpError(413, 'Anfrage zu groß')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(400, 'Ungültiges JSON')
  }
}
