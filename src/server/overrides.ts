import { eq } from 'drizzle-orm'
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
  if (!KEY.test(key)) throw new HttpError(400, 'Ungültiger Service-Schlüssel')
  if (key.startsWith('manual:')) throw new HttpError(400, 'Eigene Links werden direkt bearbeitet')
  const url = str(body.url, 500)
  if (url && !safeUrl(url)) throw new HttpError(400, 'URL muss mit http:// oder https:// beginnen')
  const icon = str(body.icon, 90).toLowerCase()
  if (icon && !ICON.test(icon)) throw new HttpError(400, 'Icon: Slug aus dashboard-icons, z. B. "home-assistant"')
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
  if (!KEY.test(key)) throw new HttpError(400, 'Ungültiger Service-Schlüssel')
  db()
    .insert(schema.serviceOverrides)
    .values({ serviceKey: key, hidden })
    .onConflictDoUpdate({ target: schema.serviceOverrides.serviceKey, set: { hidden } })
    .run()
}

export function deleteOverride(key: string) {
  db().delete(schema.serviceOverrides).where(eq(schema.serviceOverrides.serviceKey, key)).run()
}
