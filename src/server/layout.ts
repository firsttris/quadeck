import { randomBytes } from 'node:crypto'
import { and, eq, like } from 'drizzle-orm'
import type { DashboardLayout, GridItem, LayoutScope } from '~/shared/layout'
import { FRESH_DEFAULTS, INSTANCE_ID, isInstanceKind, parseWidgetConfig, WIDGETS, type InstanceKind, type WidgetInstance } from '~/shared/widgets'
import { HttpError } from './auth'
import { db, schema } from './db'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

const SCOPES: LayoutScope[] = ['page', 'tiles']
const BREAKPOINT = /^[a-z]{1,8}$/
const ID = /^[\w:.@/#-]{1,200}$/

/** The layouts table stores "<scope>|<breakpoint>" in its breakpoint column. */
const key = (scope: LayoutScope, bp: string) => `${scope}|${bp}`

/** Once on a fresh install: the starter widgets (an existing dashboard is never changed). */
function seedFresh() {
  const seed = db().select().from(schema.settings).where(eq(schema.settings.key, 'dashboard.seed')).get()
  if (!seed) return
  db().transaction((tx) => {
    for (const kind of FRESH_DEFAULTS) tx.insert(schema.widgets).values({ id: `${kind}-${randomBytes(6).toString('hex')}`, type: 'widget', config: { kind } }).run()
    tx.delete(schema.settings).where(eq(schema.settings.key, 'dashboard.seed')).run()
  })
}

export function getLayout(): DashboardLayout {
  seedFresh()
  const out: DashboardLayout = { layouts: { page: {}, tiles: {} }, hidden: [], widgets: [] }
  for (const r of db().select().from(schema.layouts).all()) {
    const [scope, bp] = r.breakpoint.split('|') as [LayoutScope, string]
    if (!SCOPES.includes(scope) || !bp) continue
    ;(out.layouts[scope][bp] ??= []).push({ i: r.widgetId, x: r.x, y: r.y, w: r.w, h: r.h })
  }
  const rows = db().select().from(schema.widgets).all()
  out.hidden = rows.filter((w) => w.type === 'card' && (w.config as { hidden?: boolean }).hidden).map((w) => w.id)
  out.widgets = rows.flatMap((w) => (w.type === 'widget' ? (instanceOf(w.id, w.config) ?? []) : []))
  return out
}

/** A stored widget row as an instance; rows of kinds this version doesn't know are skipped. */
function instanceOf(id: string, stored: Record<string, unknown>): WidgetInstance | undefined {
  const { kind, ...config } = stored
  if (!isInstanceKind(kind)) return undefined
  try {
    return { id, kind, config: parseWidgetConfig(kind, config) } as WidgetInstance
  } catch {
    return undefined
  }
}

const MAX_WIDGETS = 100

function checkConfig(kind: InstanceKind, raw: unknown) {
  try {
    return parseWidgetConfig(kind, raw)
  } catch {
    throw new HttpError(400, msg(m.layout_error_invalidWidget))
  }
}

/** Adds a widget from the catalog; it gets a fresh id and lands below the others. */
export function addWidget(kind: unknown, raw: unknown): WidgetInstance {
  if (!isInstanceKind(kind)) throw new HttpError(400, msg(m.layout_error_invalidWidget))
  const config = checkConfig(kind, raw)
  const existing = db().select().from(schema.widgets).where(eq(schema.widgets.type, 'widget')).all()
  if (existing.length >= MAX_WIDGETS) throw new HttpError(409, msg(m.layout_error_tooManyWidgets, { max: MAX_WIDGETS }))
  if (!WIDGETS[kind].multi && existing.some((w) => w.config.kind === kind)) throw new HttpError(409, msg(m.layout_error_widgetOnce))
  const id = `${kind}-${randomBytes(6).toString('hex')}`
  db()
    .insert(schema.widgets)
    .values({ id, type: 'widget', config: { kind, ...config } })
    .run()
  return { id, kind, config } as WidgetInstance
}

function storedWidget(id: unknown) {
  if (typeof id !== 'string' || !INSTANCE_ID.test(id)) throw new HttpError(400, msg(m.layout_error_invalidCardId))
  const row = db()
    .select()
    .from(schema.widgets)
    .where(and(eq(schema.widgets.id, id), eq(schema.widgets.type, 'widget')))
    .get()
  if (!row || !isInstanceKind(row.config.kind)) throw new HttpError(404, msg(m.layout_error_widgetMissing))
  return { id, kind: row.config.kind }
}

/** New settings for one widget. */
export function updateWidget(id: unknown, raw: unknown): WidgetInstance {
  const w = storedWidget(id)
  const config = checkConfig(w.kind, raw)
  db()
    .update(schema.widgets)
    .set({ config: { kind: w.kind, ...config } })
    .where(eq(schema.widgets.id, w.id))
    .run()
  return { id: w.id, kind: w.kind, config } as WidgetInstance
}

/** Removes a widget with its positions on every breakpoint. */
export function removeWidget(id: unknown) {
  const w = storedWidget(id)
  db().transaction((tx) => {
    tx.delete(schema.widgets).where(eq(schema.widgets.id, w.id)).run()
    tx.delete(schema.layouts).where(eq(schema.layouts.widgetId, w.id)).run()
  })
}

const int = (v: unknown, max: number) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > max) throw new HttpError(400, msg(m.layout_error_invalidValues))
  return n
}

export function parseSave(body: Record<string, unknown>): { scope: LayoutScope; breakpoint: string; items: GridItem[] } {
  const scope = body.scope as LayoutScope
  const breakpoint = String(body.breakpoint ?? '')
  if (!SCOPES.includes(scope) || !BREAKPOINT.test(breakpoint)) throw new HttpError(400, msg(m.layout_error_invalidScope))
  if (!Array.isArray(body.items) || body.items.length > 500) throw new HttpError(400, msg(m.layout_error_invalidEntries))
  const items = body.items.map((raw) => {
    const it = raw as Record<string, unknown>
    if (typeof it.i !== 'string' || !ID.test(it.i)) throw new HttpError(400, msg(m.layout_error_invalidId))
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
  if (!ID.test(id)) throw new HttpError(400, msg(m.layout_error_invalidCardId))
  db()
    .insert(schema.widgets)
    .values({ id, type: 'card', config: { hidden } })
    .onConflictDoUpdate({ target: schema.widgets.id, set: { config: { hidden } } })
    .run()
}

/** "Reset to auto layout": all positions, sizes and hidden cards; added widgets stay (their content too). */
export function resetLayout() {
  db().delete(schema.layouts).where(like(schema.layouts.breakpoint, '%|%')).run()
  db().delete(schema.widgets).where(eq(schema.widgets.type, 'card')).run()
}
