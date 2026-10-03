import { eq, like } from 'drizzle-orm'
import type { DashboardLayout, GridItem, LayoutScope } from '~/shared/layout'
import { HttpError } from './auth'
import { db, schema } from './db'
import { tr } from '~/shared/i18n'

const SCOPES: LayoutScope[] = ['page', 'tiles']
const BREAKPOINT = /^[a-z]{1,8}$/
const ID = /^[\w:.@/#-]{1,200}$/

/** The layouts table stores "<scope>|<breakpoint>" in its breakpoint column. */
const key = (scope: LayoutScope, bp: string) => `${scope}|${bp}`

export function getLayout(): DashboardLayout {
  const out: DashboardLayout = { layouts: { page: {}, tiles: {} }, hidden: [] }
  for (const r of db().select().from(schema.layouts).all()) {
    const [scope, bp] = r.breakpoint.split('|') as [LayoutScope, string]
    if (!SCOPES.includes(scope) || !bp) continue
    ;(out.layouts[scope][bp] ??= []).push({ i: r.widgetId, x: r.x, y: r.y, w: r.w, h: r.h })
  }
  out.hidden = db()
    .select()
    .from(schema.widgets)
    .all()
    .filter((w) => w.type === 'card' && (w.config as { hidden?: boolean }).hidden)
    .map((w) => w.id)
  return out
}

const int = (v: unknown, max: number) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > max) throw new HttpError(400, tr('Ungültige Layout-Werte', 'Invalid layout values'))
  return n
}

export function parseSave(body: Record<string, unknown>): { scope: LayoutScope; breakpoint: string; items: GridItem[] } {
  const scope = body.scope as LayoutScope
  const breakpoint = String(body.breakpoint ?? '')
  if (!SCOPES.includes(scope) || !BREAKPOINT.test(breakpoint)) throw new HttpError(400, tr('Ungültiger Layout-Bereich', 'Invalid layout scope'))
  if (!Array.isArray(body.items) || body.items.length > 500) throw new HttpError(400, tr('Ungültige Layout-Einträge', 'Invalid layout entries'))
  const items = body.items.map((raw) => {
    const it = raw as Record<string, unknown>
    if (typeof it.i !== 'string' || !ID.test(it.i)) throw new HttpError(400, tr('Ungültige Layout-ID', 'Invalid layout ID'))
    return { i: it.i, x: int(it.x, 100), y: int(it.y, 10_000), w: int(it.w, 100), h: int(it.h, 1000) }
  })
  return { scope, breakpoint, items }
}

/** Upserts the given items for one scope and breakpoint (other items stay). */
export function saveLayout(scope: LayoutScope, bp: string, items: GridItem[]) {
  const k = key(scope, bp)
  db().transaction((tx) => {
    for (const it of items) {
      tx.insert(schema.layouts)
        .values({ breakpoint: k, widgetId: it.i, x: it.x, y: it.y, w: it.w, h: it.h })
        .onConflictDoUpdate({ target: [schema.layouts.breakpoint, schema.layouts.widgetId], set: { x: it.x, y: it.y, w: it.w, h: it.h } })
        .run()
    }
  })
}

export function setCardHidden(id: string, hidden: boolean) {
  if (!ID.test(id)) throw new HttpError(400, tr('Ungültige Karten-ID', 'Invalid card ID'))
  db()
    .insert(schema.widgets)
    .values({ id, type: 'card', config: { hidden } })
    .onConflictDoUpdate({ target: schema.widgets.id, set: { config: { hidden } } })
    .run()
}

/** "Auf Auto-Layout zurücksetzen": all positions, sizes and hidden cards. */
export function resetLayout() {
  db().delete(schema.layouts).where(like(schema.layouts.breakpoint, '%|%')).run()
  db().delete(schema.widgets).where(eq(schema.widgets.type, 'card')).run()
}
