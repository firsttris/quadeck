import { eq } from 'drizzle-orm'
import { db, schema } from './db'

export function getSetting<T>(key: string): T | undefined {
  const row = db().select().from(schema.settings).where(eq(schema.settings.key, key)).get()
  return row?.value as T | undefined
}

export function setSetting(key: string, value: unknown) {
  db().insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } }).run()
}

export function deleteSetting(key: string) {
  db().delete(schema.settings).where(eq(schema.settings.key, key)).run()
}
