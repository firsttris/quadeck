// Arch Linux news (manual interventions before an upgrade). Fetched by the
// web app, cached for three hours.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NewsItem } from '~/shared/packages'
import { config } from './config'
import { parseRss } from './packages/parse'

const FEED = 'https://archlinux.org/feeds/news/'
const TTL = 3 * 60 * 60_000
let cache: { at: number; items: NewsItem[]; error?: string } | undefined

export async function archNews(): Promise<{ items: NewsItem[]; error?: string }> {
  const dir = config().fixturesDir
  if (dir) return { items: JSON.parse(readFileSync(join(dir, 'news.json'), 'utf8')) as NewsItem[] }
  if (cache && Date.now() - cache.at < TTL) return cache
  try {
    const res = await fetch(FEED, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    cache = { at: Date.now(), items: parseRss(text.slice(0, 2_000_000)).slice(0, 8) }
  } catch (e) {
    // Keep showing the last good list; retry in ten minutes.
    cache = { at: Date.now() - TTL + 10 * 60_000, items: cache?.items ?? [], error: `Arch-News nicht erreichbar: ${(e as Error).message}` }
  }
  return cache
}
