import { eq } from 'drizzle-orm'
import { m } from '~/paraglide/messages'
import { msg } from '~/shared/i18n'
import { HttpError } from './auth'
import { db, schema } from './db'
import { safeUrl } from './registry'

export interface OverrideInput {
  key: string
  name?: string
  group?: string
  url?: string
  icon?: string
  hidden: boolean
  pinned: boolean
}

const KEY = /^[\w:.@/#-]{1,200}$/
const ICON = /^(glyph:)?[a-z0-9][a-z0-9-]{0,80}$/
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Empty fields mean "follow discovery". */
export function validateOverride(body: Record<string, unknown>): OverrideInput {
  const key = str(body.key, 200)
  if (!KEY.test(key)) throw new HttpError(400, msg(m.services_error_invalidKey))
  if (key.startsWith('manual:')) throw new HttpError(400, msg(m.services_error_manualLink))
  const url = str(body.url, 500)
  if (url && !safeUrl(url)) throw new HttpError(400, msg(m.notify_error_urlScheme))
  const icon = str(body.icon, 90).toLowerCase()
  if (icon && !ICON.test(icon)) throw new HttpError(400, msg(m.services_error_iconSlug))
  return {
    key,
    name: str(body.name, 60) || undefined,
    group: str(body.group, 40) || undefined,
    url: url ? safeUrl(url) : undefined,
    icon: icon || undefined,
    hidden: body.hidden === true,
    pinned: body.pinned === true,
  }
}

export function saveOverride(o: OverrideInput) {
  const values = { name: o.name ?? null, group: o.group ?? null, url: o.url ?? null, icon: o.icon ?? null, hidden: o.hidden, pinned: o.pinned }
  db()
    .insert(schema.serviceOverrides)
    .values({ serviceKey: o.key, ...values })
    .onConflictDoUpdate({ target: schema.serviceOverrides.serviceKey, set: values })
    .run()
}

export function setHidden(key: string, hidden: boolean) {
  if (!KEY.test(key)) throw new HttpError(400, msg(m.services_error_invalidKey))
  db().insert(schema.serviceOverrides).values({ serviceKey: key, hidden }).onConflictDoUpdate({ target: schema.serviceOverrides.serviceKey, set: { hidden } }).run()
}

/**
 * Dashboard drag and drop: only the group changes. A manual link keeps it in its own row,
 * a detected service in its override (the other overridden fields stay as they are).
 */
export function setGroup(key: string, group: string) {
  const g = str(group, 40)
  if (!KEY.test(key) || !g) throw new HttpError(400, msg(m.api_services_keyGroupRequired))
  const manual = key.match(/^manual:(\d+)$/)
  if (manual) {
    const r = db()
      .update(schema.manualServices)
      .set({ group: g })
      .where(eq(schema.manualServices.id, Number(manual[1])))
      .returning()
      .all()
    if (!r.length) throw new HttpError(404, msg(m.links_error_notFound))
    return
  }
  db()
    .insert(schema.serviceOverrides)
    .values({ serviceKey: key, group: g })
    .onConflictDoUpdate({ target: schema.serviceOverrides.serviceKey, set: { group: g } })
    .run()
}

export function deleteOverride(key: string) {
  db().delete(schema.serviceOverrides).where(eq(schema.serviceOverrides.serviceKey, key)).run()
}
