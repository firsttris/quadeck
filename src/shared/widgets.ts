// Dashboard widgets: the built-in cards (one each, can be hidden) and widgets that are added from
// the catalog, possibly several times, each with its own settings. No I/O here.

/** Built-in cards: one instance each, keyed by their kind; "removing" one hides it. */
export const BUILTIN_CARDS = ['services', 'storage', 'timers', 'shares', 'cpu', 'ram', 'temp', 'net', 'gpu', 'power'] as const
export type BuiltinCard = (typeof BUILTIN_CARDS)[number]

/** Widgets added from the catalog: stored with an id and a config of their own. */
export const INSTANCE_KINDS = ['note'] as const
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
  note: { category: 'other', multi: true, configurable: true },
}

export const NOTE_MAX = 4000
export const TITLE_MAX = 80

export interface NoteConfig {
  title: string
  text: string
}

export interface WidgetConfigs {
  note: NoteConfig
}

export type WidgetInstance = { [K in InstanceKind]: { id: string; kind: K; config: WidgetConfigs[K] } }[InstanceKind]

export const isInstanceKind = (v: unknown): v is InstanceKind => typeof v === 'string' && (INSTANCE_KINDS as readonly string[]).includes(v)
export const isBuiltinCard = (v: unknown): v is BuiltinCard => typeof v === 'string' && (BUILTIN_CARDS as readonly string[]).includes(v)

/** Instance ids: "<kind>-<random>" (fits the layout's id pattern). */
export const INSTANCE_ID = /^[a-z]+-[a-z0-9]{6,16}$/

/** Checks and normalises a config from outside; throws a message key on invalid input. */
export function parseWidgetConfig(kind: InstanceKind, raw: unknown): WidgetConfigs[InstanceKind] {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  switch (kind) {
    case 'note': {
      const title = typeof o.title === 'string' ? o.title.trim() : ''
      const text = typeof o.text === 'string' ? o.text.replace(/\r\n/g, '\n') : ''
      if (title.length > TITLE_MAX || text.length > NOTE_MAX) throw new Error('tooLong')
      return { title, text }
    }
  }
}

export const defaultConfig = (kind: InstanceKind): WidgetConfigs[InstanceKind] => parseWidgetConfig(kind, {})

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
