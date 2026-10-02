// Service icons from the dashboard-icons collection (homarr-labs). Candidate
// slugs come from the image name, the Quadlet/unit name and the Caddy host;
// they are checked against the collection's index (incl. aliases). Hits are
// cached under <dataDir>/icons so the dashboard works offline and without CDN.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config'

/** Our own aliases on top of the collection's metadata. */
export const ALIASES: Record<string, string> = {
  ha: 'home-assistant',
  hass: 'home-assistant',
  homeassistant: 'home-assistant',
  bitwarden: 'vaultwarden',
  bw: 'vaultwarden',
  vault: 'vaultwarden',
  qbt: 'qbittorrent',
  'qbittorrent-nox': 'qbittorrent',
  photos: 'immich',
  'immich-server': 'immich',
  'immich-machine-learning': 'immich',
  'immich-ml': 'immich',
  jf: 'jellyfin',
  'adguardhome': 'adguard-home',
  adguard: 'adguard-home',
  pihole: 'pi-hole',
  'nextcloud-aio-mastercontainer': 'nextcloud',
  'paperless-ngx': 'paperless-ngx',
  paperless: 'paperless-ngx',
  'uptime-kuma': 'uptime-kuma',
  kuma: 'uptime-kuma',
  nodered: 'node-red',
  zigbee2mqtt: 'zigbee2mqtt',
  z2m: 'zigbee2mqtt',
  frigate: 'frigate',
  nvr: 'frigate',
  gitea: 'gitea',
  forgejo: 'forgejo',
  abs: 'audiobookshelf',
  books: 'audiobookshelf',
}

const STRIP_SUFFIXES = ['-server', '-web', '-app', '-ui', '-nox', '-ce', '-ee', '-oss']

export function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** "docker.io/jellyfin/jellyfin:latest" → "jellyfin"; "ghcr.io/immich-app/immich-server:release" → "immich-server". */
export function imageSlug(image: string): string {
  const noDigest = image.split('@')[0]!
  const last = noDigest.split('/').pop()!
  return slugify(last.replace(/:[^:]*$/, ''))
}

export function slugCandidates(input: { image?: string; unit?: string; container?: string; host?: string; name?: string }): string[] {
  const raw: string[] = []
  if (input.name) raw.push(slugify(input.name))
  if (input.image) raw.push(imageSlug(input.image))
  if (input.unit) raw.push(slugify(input.unit.replace(/\.(service|container)$/, '')))
  if (input.container) raw.push(slugify(input.container))
  if (input.host && !/^[\d.]+$/.test(input.host)) raw.push(slugify(input.host.split('.')[0]!))
  const out: string[] = []
  const add = (s: string) => {
    if (s && !out.includes(s)) out.push(s)
  }
  for (const r of raw) {
    add(ALIASES[r] ?? r)
    for (const suf of STRIP_SUFFIXES) if (r.endsWith(suf)) add(ALIASES[r.slice(0, -suf.length)] ?? r.slice(0, -suf.length))
    // linuxserver-style "lscr.io/linuxserver/sonarr" is already covered; also try first dash segment ("immich-ml" → "immich").
    const first = r.split('-')[0]!
    if (first.length >= 3) add(ALIASES[first] ?? first)
  }
  return out
}

export interface IconIndex {
  svg: Set<string>
  png: Set<string>
  aliases: Map<string, string>
}

/** Accepts tree.json ({svg:[…], png:[…]}) and optionally metadata.json ({slug:{aliases:[…]}}). */
export function parseIconIndex(tree: unknown, metadata?: unknown): IconIndex {
  const strip = (arr: unknown, ext: string) =>
    new Set((Array.isArray(arr) ? arr : []).filter((x): x is string => typeof x === 'string').map((f) => f.replace(new RegExp(`\\.${ext}$`), '')))
  const t = (tree ?? {}) as Record<string, unknown>
  const index: IconIndex = { svg: strip(t.svg, 'svg'), png: strip(t.png, 'png'), aliases: new Map() }
  if (metadata && typeof metadata === 'object') {
    for (const [slug, meta] of Object.entries(metadata as Record<string, { aliases?: unknown }>)) {
      for (const a of Array.isArray(meta?.aliases) ? meta.aliases : []) if (typeof a === 'string') index.aliases.set(slugify(a), slug)
    }
  }
  return index
}

export function matchIcon(index: IconIndex, candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (index.svg.has(c) || index.png.has(c)) return c
    const a = index.aliases.get(c)
    if (a && (index.svg.has(a) || index.png.has(a))) return a
  }
  return undefined
}

// ---------- runtime index + cache ----------

const INDEX_MAX_AGE = 7 * 24 * 3600 * 1000
let index: IconIndex | undefined
let loading: Promise<void> | undefined

const iconDir = () => join(config().dataDir, 'icons')

export function iconIndex(): IconIndex | undefined {
  if (!index && !loading) loading = loadIndex().finally(() => (loading = undefined))
  return index
}

async function loadIndex() {
  const dir = iconDir()
  mkdirSync(dir, { recursive: true })
  const treeFile = join(dir, 'tree.json')
  const metaFile = join(dir, 'metadata.json')
  const fresh = existsSync(treeFile) && Date.now() - statSync(treeFile).mtimeMs < INDEX_MAX_AGE
  if (!fresh) {
    try {
      const base = config().iconsBase
      const tree = await fetch(`${base}/tree.json`, { signal: AbortSignal.timeout(15_000) })
      if (tree.ok) writeFileSync(treeFile, await tree.text())
      const meta = await fetch(`${base}/metadata.json`, { signal: AbortSignal.timeout(15_000) })
      if (meta.ok) writeFileSync(metaFile, await meta.text())
    } catch {
      // offline: use whatever is cached
    }
  }
  try {
    const tree = JSON.parse(readFileSync(treeFile, 'utf8'))
    const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : undefined
    index = parseIconIndex(tree, meta)
  } catch {
    index = undefined
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/

/** Returns the cached icon file (downloading it once). */
export async function iconFile(slug: string): Promise<{ path: string; type: string } | undefined> {
  if (!SLUG.test(slug)) return undefined
  const dir = iconDir()
  mkdirSync(dir, { recursive: true })
  for (const [ext, type] of [
    ['svg', 'image/svg+xml'],
    ['png', 'image/png'],
  ] as const) {
    const p = join(dir, `${slug}.${ext}`)
    if (existsSync(p)) return { path: p, type }
  }
  const idx = iconIndex()
  const ext = idx?.svg.has(slug) ? 'svg' : idx?.png.has(slug) ? 'png' : idx ? undefined : 'svg'
  if (!ext) return undefined
  try {
    const res = await fetch(`${config().iconsBase}/${ext}/${slug}.${ext}`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return undefined
    const p = join(dir, `${slug}.${ext}`)
    writeFileSync(p, new Uint8Array(await res.arrayBuffer()))
    return { path: p, type: ext === 'svg' ? 'image/svg+xml' : 'image/png' }
  } catch {
    return undefined
  }
}

// ---------- fallback glyphs and colours ----------

/** Neutral category icon (glyph name understood by the UI) and accent colour for well-known apps. */
const KNOWN: Record<string, { group: string; glyph: string; color: string; name?: string }> = {
  jellyfin: { group: 'Medien', glyph: 'play', color: '#a78bfa' },
  plex: { group: 'Medien', glyph: 'play', color: '#e5a00d' },
  emby: { group: 'Medien', glyph: 'play', color: '#52b54b' },
  immich: { group: 'Medien', glyph: 'image', color: '#f0a35e' },
  photoprism: { group: 'Medien', glyph: 'image', color: '#a78bfa', name: 'PhotoPrism' },
  audiobookshelf: { group: 'Medien', glyph: 'book', color: '#e3c46b', name: 'Audiobookshelf' },
  navidrome: { group: 'Medien', glyph: 'play', color: '#6fa8ff' },
  sonarr: { group: 'Downloads', glyph: 'download', color: '#6fa8ff' },
  radarr: { group: 'Downloads', glyph: 'download', color: '#f2c14e' },
  lidarr: { group: 'Downloads', glyph: 'download', color: '#4fd1a5' },
  prowlarr: { group: 'Downloads', glyph: 'download', color: '#e07a7a' },
  qbittorrent: { group: 'Downloads', glyph: 'magnet', color: '#8fb3d9', name: 'qBittorrent' },
  transmission: { group: 'Downloads', glyph: 'magnet', color: '#e07a7a' },
  sabnzbd: { group: 'Downloads', glyph: 'download', color: '#f2c14e', name: 'SABnzbd' },
  'home-assistant': { group: 'Smart Home', glyph: 'home', color: '#5fb3e8', name: 'Home Assistant' },
  'node-red': { group: 'Smart Home', glyph: 'bolt', color: '#e07a7a', name: 'Node-RED' },
  zigbee2mqtt: { group: 'Smart Home', glyph: 'bolt', color: '#f2c14e', name: 'Zigbee2MQTT' },
  frigate: { group: 'Smart Home', glyph: 'camera', color: '#e07a7a' },
  vaultwarden: { group: 'System', glyph: 'key', color: '#9aa3b1' },
  'adguard-home': { group: 'Netzwerk', glyph: 'shield', color: '#4fd1a5', name: 'AdGuard Home' },
  'pi-hole': { group: 'Netzwerk', glyph: 'shield', color: '#e07a7a', name: 'Pi-hole' },
  caddy: { group: 'System', glyph: 'globe', color: '#4fd1a5' },
  'uptime-kuma': { group: 'System', glyph: 'shield', color: '#4fd1a5', name: 'Uptime Kuma' },
  grafana: { group: 'System', glyph: 'chart', color: '#f0a35e' },
  nextcloud: { group: 'Produktivität', glyph: 'cloud', color: '#6fa8ff', name: 'Nextcloud' },
  'paperless-ngx': { group: 'Produktivität', glyph: 'book', color: '#4fd1a5', name: 'Paperless-ngx' },
  gitea: { group: 'Produktivität', glyph: 'code', color: '#7cc4b8' },
  forgejo: { group: 'Produktivität', glyph: 'code', color: '#f0a35e' },
}

const PALETTE = ['#7cc4b8', '#a78bfa', '#6fa8ff', '#f0a35e', '#e3c46b', '#5fb3e8', '#e07a7a', '#4fd1a5', '#c4b5fd', '#9cc8e0']

export function knownApp(candidates: string[]) {
  for (const c of candidates) if (KNOWN[c]) return KNOWN[c]
  return undefined
}

export function colorFor(key: string) {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]!
}

/** Icon picker search: prefix matches first, then substring matches, then aliases. */
export function searchIcons(index: IconIndex, query: string, limit = 48): string[] {
  const q = slugify(query)
  const all = [...new Set([...index.svg, ...index.png])].sort()
  if (!q) return all.slice(0, limit)
  const prefix = all.filter((s) => s.startsWith(q))
  const contains = all.filter((s) => !s.startsWith(q) && s.includes(q))
  const alias = [...index.aliases.entries()].filter(([a]) => a.includes(q)).map(([, s]) => s)
  return [...new Set([...prefix, ...contains, ...alias])].slice(0, limit)
}
