import { Database } from 'bun:sqlite'
import { and, gte, lt, type SQL } from 'drizzle-orm'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config'
import { migrations } from './migrations.gen'
import * as schema from './schema'

export type DB = BunSQLiteDatabase<typeof schema>

let instance: { db: DB; sqlite: Database } | undefined

export function migrate(sqlite: Database) {
  sqlite.run('CREATE TABLE IF NOT EXISTS __quadeck_migrations (tag TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const done = new Set(sqlite.query<{ tag: string }, []>('SELECT tag FROM __quadeck_migrations').all().map((r) => r.tag))
  for (const m of migrations) {
    if (done.has(m.tag)) continue
    sqlite.transaction(() => {
      for (const s of m.statements) sqlite.run(s)
      sqlite.run('INSERT INTO __quadeck_migrations (tag, applied_at) VALUES (?, ?)', [m.tag, Date.now()])
    })()
  }
}

export function openDb(path: string) {
  const sqlite = new Database(path, { create: true })
  // Password hash and session hashes live here: root only.
  if (path !== ':memory:') chmodSync(path, 0o600)
  sqlite.run('PRAGMA busy_timeout = 5000') // CLI and service share the file
  sqlite.run('PRAGMA journal_mode = WAL')
  sqlite.run('PRAGMA foreign_keys = ON')
  migrate(sqlite)
  return { db: drizzle(sqlite, { schema }), sqlite }
}

export function db(): DB {
  if (!instance) {
    const dir = config().dataDir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    instance = openDb(join(dir, 'quadeck.db'))
  }
  return instance.db
}

export { schema }

/**
 * metric_samples rows whose name starts with `prefix` ("ct:", "smart:sda:"), written as a range
 * (metric >= 'ct:' AND metric < 'ct;'). SQLite's LIKE is case-insensitive and therefore never uses
 * the (metric, ts) index: `metric LIKE 'ct:%'` read the whole table every time.
 */
export function metricPrefix(prefix: string): SQL {
  const t = schema.metricSamples
  const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
  return and(gte(t.metric, prefix), lt(t.metric, end))!
}
