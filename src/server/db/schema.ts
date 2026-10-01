import { sqliteTable, text, integer, real, index, primaryKey } from 'drizzle-orm/sqlite-core'

// SQLite only stores what the user decided plus a short metric history;
// everything discovered is recomputed live.

export const serviceOverrides = sqliteTable('service_overrides', {
  serviceKey: text('service_key').primaryKey(),
  name: text('name'),
  icon: text('icon'),
  group: text('group'),
  url: text('url'),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
})

export const groups = sqliteTable('groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  order: integer('order').notNull().default(0),
  collapsed: integer('collapsed', { mode: 'boolean' }).notNull().default(false),
})

export const layouts = sqliteTable(
  'layouts',
  {
    breakpoint: text('breakpoint').notNull(),
    widgetId: text('widget_id').notNull(),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
    w: integer('w').notNull(),
    h: integer('h').notNull(),
  },
  (t) => [primaryKey({ columns: [t.breakpoint, t.widgetId] })],
)

export const widgets = sqliteTable('widgets', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
})

export const metricSamples = sqliteTable(
  'metric_samples',
  {
    ts: integer('ts').notNull(),
    metric: text('metric').notNull(),
    value: real('value').notNull(),
  },
  (t) => [index('metric_samples_metric_ts').on(t.metric, t.ts)],
)

export const manualServices = sqliteTable('manual_services', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  icon: text('icon'),
  group: text('group'),
  healthCheck: integer('health_check', { mode: 'boolean' }).notNull().default(true),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(), // sha256 of the cookie token
  csrf: text('csrf').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
})
