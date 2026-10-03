import { eq } from 'drizzle-orm'
import { HttpError } from './auth'
import { db, schema } from './db'
import { msg } from '~/shared/i18n'

export interface LinkInput {
  name: string
  url: string
  group?: string
  icon?: string
  healthCheck: boolean
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export function validateLink(body: Record<string, unknown>): LinkInput {
  const name = str(body.name, 60)
  const url = str(body.url, 500)
  if (!name) throw new HttpError(400, msg('links_error_nameMissing'))
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new HttpError(400, msg('links_error_urlInvalid'))
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new HttpError(400, msg('links_error_httpOnly'))
  const icon = str(body.icon, 80).toLowerCase()
  if (icon && !/^[a-z0-9][a-z0-9-]*$/.test(icon)) throw new HttpError(400, msg('links_error_iconSlug'))
  return { name, url: parsed.toString(), group: str(body.group, 40) || undefined, icon: icon || undefined, healthCheck: body.healthCheck !== false }
}

export function addLink(l: LinkInput) {
  return db().insert(schema.manualServices).values(l).returning().get()
}

export function updateLink(id: number, l: LinkInput) {
  const r = db()
    .update(schema.manualServices)
    .set({ name: l.name, url: l.url, group: l.group ?? null, icon: l.icon ?? null, healthCheck: l.healthCheck })
    .where(eq(schema.manualServices.id, id))
    .returning()
    .all()
  if (!r.length) throw new HttpError(404, msg('links_error_notFound'))
  return r[0]
}

export function deleteLink(id: number) {
  const r = db().delete(schema.manualServices).where(eq(schema.manualServices.id, id)).returning().all()
  if (!r.length) throw new HttpError(404, msg('links_error_notFound'))
}
