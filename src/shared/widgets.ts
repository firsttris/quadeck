// Dashboard widgets: the built-in cards (one each, can be hidden) and widgets that are added from
// the catalog, possibly several times, each with its own settings. No I/O here.

/** Built-in cards: one instance each, keyed by their kind; "removing" one hides it. */
export const BUILTIN_CARDS = ['services', 'storage', 'timers', 'shares', 'cpu', 'ram', 'temp', 'net', 'gpu', 'power'] as const
export type BuiltinCard = (typeof BUILTIN_CARDS)[number]

/** Widgets added from the catalog: stored with an id and a config of their own. */
export const INSTANCE_KINDS = ['updates', 'backups', 'disk', 'containers', 'alerts', 'service', 'devices', 'speed', 'logins', 'links', 'note'] as const
export type InstanceKind = (typeof INSTANCE_KINDS)[number]

export type WidgetCategory = 'system' | 'storage' | 'services' | 'network' | 'other'

export interface WidgetMeta {
  category: WidgetCategory
  /** Can be on the dashboard more than once. */
  multi: boolean
  /** Has settings (⚙ in edit mode). */
  configurable: boolean
}

export const WIDGETS: Record<BuiltinCard | InstanceKind, WidgetMeta> = {
  cpu: { category: 'system', multi: false, configurable: false },
  ram: { category: 'system', multi: false, configurable: false },
  temp: { category: 'system', multi: false, configurable: false },
  gpu: { category: 'system', multi: false, configurable: false },
  power: { category: 'system', multi: false, configurable: false },
  net: { category: 'network', multi: false, configurable: false },
  storage: { category: 'storage', multi: false, configurable: false },
  shares: { category: 'storage', multi: false, configurable: false },
  services: { category: 'services', multi: false, configurable: false },
  timers: { category: 'services', multi: false, configurable: false },
  updates: { category: 'system', multi: false, configurable: false },
  backups: { category: 'storage', multi: false, configurable: false },
  disk: { category: 'storage', multi: true, configurable: true },
  containers: { category: 'services', multi: true, configurable: true },
  alerts: { category: 'other', multi: false, configurable: false },
  service: { category: 'services', multi: true, configurable: true },
  devices: { category: 'network', multi: false, configurable: false },
  speed: { category: 'network', multi: false, configurable: false },
  logins: { category: 'network', multi: false, configurable: false },
  links: { category: 'other', multi: true, configurable: true },
  note: { category: 'other', multi: true, configurable: true },
}

/** On a fresh install these widgets are on the overview from the start (existing ones keep theirs). */
export const FRESH_DEFAULTS: InstanceKind[] = ['updates', 'backups']

export const NOTE_MAX = 4000
export const TITLE_MAX = 80

export interface NoteConfig {
  title: string
  text: string
}

export interface DiskConfig {
  /** Mount point; '' = not chosen yet. */
  mount: string
}

export interface ContainersConfig {
  metric: 'cpu' | 'ram'
}

export interface ServiceConfig {
  /** A systemd unit (service or Quadlet); '' = not chosen yet. */
  unit: string
}

export const LINKS_MAX = 20
export interface LinksConfig {
  title: string
  links: { name: string; url: string }[]
}

export type NoConfig = Record<string, never>

export interface WidgetConfigs {
  updates: NoConfig
  backups: NoConfig
  disk: DiskConfig
  containers: ContainersConfig
  alerts: NoConfig
  service: ServiceConfig
  devices: NoConfig
  speed: NoConfig
  logins: NoConfig
  links: LinksConfig
  note: NoteConfig
}

export type WidgetInstance = { [K in InstanceKind]: { id: string; kind: K; config: WidgetConfigs[K] } }[InstanceKind]

export const isInstanceKind = (v: unknown): v is InstanceKind => typeof v === 'string' && (INSTANCE_KINDS as readonly string[]).includes(v)
export const isBuiltinCard = (v: unknown): v is BuiltinCard => typeof v === 'string' && (BUILTIN_CARDS as readonly string[]).includes(v)

/** systemd unit names (same rules as on the units page, without paths). */
export const UNIT_NAME = /^[A-Za-z0-9:_.@\\-]{1,250}\.(service|socket|timer|target|mount|path)$/

/** Only http(s) links, at most 2000 characters. */
export function isWebUrl(url: string): boolean {
  if (url.length > 2000) return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Instance ids: "<kind>-<random>" (fits the layout's id pattern). */
export const INSTANCE_ID = /^[a-z]+-[a-z0-9]{6,16}$/

/** Checks and normalises a config from outside; throws a message key on invalid input. */
export function parseWidgetConfig(kind: InstanceKind, raw: unknown): WidgetConfigs[InstanceKind] {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  switch (kind) {
    case 'updates':
    case 'backups':
    case 'alerts':
    case 'devices':
    case 'speed':
    case 'logins':
      return {}
    case 'service': {
      const unit = typeof o.unit === 'string' ? o.unit : ''
      if (unit && !UNIT_NAME.test(unit)) throw new Error('unit')
      return { unit }
    }
    case 'links': {
      const title = typeof o.title === 'string' ? o.title.trim() : ''
      const raw = Array.isArray(o.links) ? o.links : []
      if (title.length > TITLE_MAX || raw.length > LINKS_MAX) throw new Error('tooLong')
      const links = raw.flatMap((l) => {
        const x = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>
        const name = typeof x.name === 'string' ? x.name.trim() : ''
        const url = typeof x.url === 'string' ? x.url.trim() : ''
        if (!name && !url) return [] // an empty row
        if (!name || name.length > TITLE_MAX || !isWebUrl(url)) throw new Error('link')
        return [{ name, url }]
      })
      return { title, links }
    }
    case 'disk': {
      const mount = typeof o.mount === 'string' ? o.mount : ''
      if (mount && (!mount.startsWith('/') || mount.length > 512 || /[\0\n]/.test(mount))) throw new Error('mount')
      return { mount }
    }
    case 'containers':
      return { metric: o.metric === 'cpu' ? 'cpu' : 'ram' }
    case 'note': {
      const title = typeof o.title === 'string' ? o.title.trim() : ''
      const text = typeof o.text === 'string' ? o.text.replace(/\r\n/g, '\n') : ''
      if (title.length > TITLE_MAX || text.length > NOTE_MAX) throw new Error('tooLong')
      return { title, text }
    }
  }
}

export const defaultConfig = (kind: InstanceKind): WidgetConfigs[InstanceKind] => parseWidgetConfig(kind, {})

/** Top consumers: running containers sorted by CPU or memory, at most `n`. */
export function topContainers<T extends { name: string; state: string; cpu?: number; memUsage?: number }>(list: T[], metric: 'cpu' | 'ram', n = 5): T[] {
  const value = (c: T) => (metric === 'cpu' ? c.cpu : c.memUsage) ?? 0
  return list
    .filter((c) => c.state === 'running')
    .sort((a, b) => value(b) - value(a) || a.name.localeCompare(b.name))
    .slice(0, n)
}

/** Text with links: plain parts and http(s) URLs (only those become links). */
export function linkify(text: string): { text: string; href?: string }[] {
  const out: { text: string; href?: string }[] = []
  const re = /https?:\/\/[^\s<>"')\]]+/g
  let last = 0
  for (const mm of text.matchAll(re)) {
    const url = mm[0].replace(/[.,;:!?]+$/, '')
    if (mm.index! > last) out.push({ text: text.slice(last, mm.index) })
    out.push({ text: url, href: url })
    last = mm.index! + url.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}
