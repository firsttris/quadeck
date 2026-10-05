import { ActionError } from './hub'
import { HttpError, requireSession, type Session } from './auth'
import { localize, localizeResponse } from './lang'
import { currentLang, msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError || e instanceof ActionError) return Response.json({ error: localize(e.message, currentLang()) }, { status: e.status })
  console.error('[quadeck]', e)
  return Response.json({ error: localize((e as Error).message || msg(m.http_error_internal), currentLang()) }, { status: 500 })
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

/** Default limit for JSON request bodies. */
export const JSON_MAX = 64 * 1024

/**
 * Parses a JSON body of at most `limit` bytes. Checks Content-Length first and stops reading as
 * soon as the limit is passed, so nobody can make the server buffer a huge body (login and setup
 * call this before any authentication).
 */
export async function readJson<T>(request: Request, limit = JSON_MAX): Promise<T> {
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) throw new HttpError(415, msg(m.http_error_jsonExpected))
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, msg(m.http_error_tooLarge))
  const text = await readLimited(request.body, limit)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(400, msg(m.http_error_invalidJson))
  }
}

async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel().catch(() => {})
      throw new HttpError(413, msg(m.http_error_tooLarge))
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.length
  }
  return new TextDecoder().decode(all)
}
