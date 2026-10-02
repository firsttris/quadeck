// Service registry: merges discovery candidates (Caddy), containers (Podman),
// units (systemd), Quadlet labels, manual links and UI overrides into the
// service tiles. Merge order, lowest to highest priority:
//   1. Caddy route → public URL
//   2. upstream → container (name, network alias, container IP or published port)
//   3. container label PODMAN_SYSTEMD_UNIT → Quadlet unit
//   4. labels quadeck.* in the Quadlet file
//   5. overrides from the UI (SQLite)

import type { Container, Health, IconRef, Service, ServiceGroup } from '~/shared/types'
import { colorFor, knownApp, matchIcon, slugCandidates, slugify, type IconIndex } from './icons'
import type { ServiceCandidate } from './providers/types'

export interface Override {
  serviceKey: string
  name?: string | null
  icon?: string | null
  group?: string | null
  url?: string | null
  hidden: boolean
  pinned: boolean
}

export interface ManualService {
  id: number
  name: string
  url: string
  icon?: string | null
  group?: string | null
  healthCheck: boolean
}

export interface HttpHealth {
  health: Health
  note?: string
}

export interface MergeInput {
  candidates: ServiceCandidate[]
  containers: Container[]
  manual: ManualService[]
  overrides: Override[]
  groupOrder?: string[]
  httpHealth: Map<string, HttpHealth>
  iconIndex?: IconIndex
  localHosts: Set<string>
}

const LOCAL_NAMES = ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.containers.internal', 'host.docker.internal', 'host-gateway']

export function localHostSet(extra: string[]): Set<string> {
  return new Set([...LOCAL_NAMES, ...extra.map((h) => h.toLowerCase())])
}

export function parseDial(dial: string): { host: string; port?: number } {
  const d = dial.replace(/^[a-z0-9+]+:\/\//i, '').replace(/\/.*$/, '')
  const v6 = d.match(/^\[([^\]]+)\](?::(\d+))?$/)
  if (v6) return { host: v6[1]!.toLowerCase(), port: v6[2] ? Number(v6[2]) : undefined }
  const m = d.match(/^(.*?)(?::(\d+))?$/)!
  return { host: m[1]!.toLowerCase(), port: m[2] ? Number(m[2]) : undefined }
}

/** Finds the container behind an upstream dial address, or undefined for external targets. */
export function matchUpstream(dial: string, containers: Container[], localHosts: Set<string>): Container | undefined {
  const { host, port } = parseDial(dial)
  const byName = containers.find((c) => c.name.toLowerCase() === host || c.aliases.some((a) => a.toLowerCase() === host))
  if (byName) return byName
  const byIp = containers.find((c) => c.ips.includes(host))
  if (byIp) return byIp
  if (port && localHosts.has(host)) {
    const hits = containers.filter((c) => c.ports.some((p) => p.hostPort === port))
    return hits.find((c) => c.state === 'running') ?? hits[0]
  }
  return undefined
}

const label = (c: Container | undefined, k: string) => c?.labels[`quadeck.${k}`]?.trim() || undefined

/** Only http(s) URLs from labels/overrides: they are fetched (health, favicon) and rendered as links. */
export function safeUrl(u: string | null | undefined): string | undefined {
  if (!u) return undefined
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.toString() : undefined
  } catch {
    return undefined
  }
}
const truthy = (v: string | undefined) => !!v && /^(1|true|yes|on)$/i.test(v)

function titleCase(s: string) {
  return s
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

function hostOf(url: string) {
  try {
    const u = new URL(url)
    return u.host + (u.pathname !== '/' ? u.pathname : '')
  } catch {
    return url
  }
}

function resolveIcon(explicit: string | undefined, candidates: string[], index: IconIndex | undefined, key: string): IconRef {
  if (explicit) {
    if (explicit.startsWith('glyph:')) return { kind: 'glyph', glyph: explicit.slice(6) }
    return { kind: 'dash', slug: slugify(explicit) }
  }
  const hit = index ? matchIcon(index, candidates) : undefined
  if (hit) return { kind: 'dash', slug: hit }
  return { kind: 'favicon', key }
}

function containerHealth(c: Container): HttpHealth | undefined {
  if (c.state !== 'running') return { health: 'bad', note: `Container ${c.state === 'exited' ? 'gestoppt' : c.state}` }
  if (c.health === 'unhealthy') return { health: 'bad', note: 'Healthcheck schlägt fehl' }
  if (c.health === 'starting') return { health: 'warn', note: 'Healthcheck startet' }
  if (c.health === 'healthy') return { health: 'ok', note: 'healthy' }
  return undefined
}

export function mergeServices(input: MergeInput): ServiceGroup[] {
  const services: Service[] = []
  const usedContainers = new Set<string>()
  const keys = new Set<string>()

  const build = (o: {
    key: string
    url: string
    container?: Container
    source: Service['source']
    fallbackName: string
    hostForSlug?: string
    manual?: ManualService
  }) => {
    const c = o.container
    const name = o.manual?.name ?? label(c, 'name') ?? o.fallbackName
    const candidates = slugCandidates({ name: label(c, 'name') ?? o.manual?.name, image: c?.image, unit: c?.unit, container: c?.name, host: o.hostForSlug })
    const known = knownApp(candidates)
    const url = safeUrl(label(c, 'url')) ?? o.url
    const svc: Service = {
      key: o.key,
      name,
      url,
      host: hostOf(url),
      group: o.manual?.group ?? label(c, 'group') ?? (o.source === 'manual' ? 'Links' : (known?.group ?? 'Apps')),
      icon: resolveIcon(o.manual?.icon ?? label(c, 'icon'), candidates, input.iconIndex, o.key),
      iconFallback: known?.glyph ?? (o.source === 'manual' ? 'globe' : 'box'),
      color: known?.color ?? colorFor(o.key),
      health: 'unknown',
      container: c?.name,
      unit: c?.unit,
      source: o.source,
      manualId: o.manual?.id,
    }
    if (truthy(label(c, 'hidden'))) return
    const ch = c ? containerHealth(c) : undefined
    const hh = o.manual && !o.manual.healthCheck ? undefined : input.httpHealth.get(url)
    const h = ch?.health === 'bad' || ch?.health === 'warn' ? ch : (ch ?? hh)
    if (h) {
      svc.health = h.health
      svc.healthNote = h.note
    }
    services.push(svc)
  }

  // 1–4: Caddy routes, matched to containers.
  for (const cand of input.candidates) {
    const container = cand.upstreams.map((u) => matchUpstream(u, input.containers, input.localHosts)).find(Boolean)
    if (!safeUrl(cand.url)) continue
    const key = container && !usedContainers.has(container.name) ? `ct:${container.name}` : `host:${cand.host}${new URL(cand.url).pathname.replace(/\/$/, '')}`
    if (keys.has(key)) continue
    keys.add(key)
    if (container) usedContainers.add(container.name)
    const sub = cand.host.split('.')[0]!
    build({
      key,
      url: cand.url,
      container,
      source: 'caddy',
      fallbackName: container ? knownName(container) : (prettyName(slugCandidates({ host: cand.host })) ?? titleCase(sub)),
      hostForSlug: cand.host,
    })
  }

  // Containers that declare their own URL via label but have no Caddy route.
  for (const c of input.containers) {
    const url = safeUrl(label(c, 'url'))
    if (!url || usedContainers.has(c.name)) continue
    const key = `ct:${c.name}`
    if (keys.has(key)) continue
    keys.add(key)
    usedContainers.add(c.name)
    build({ key, url, container: c, source: 'label', fallbackName: knownName(c) })
  }

  // Manual links (router, printer, other hosts).
  for (const m of input.manual) {
    let host: string | undefined
    try {
      host = new URL(m.url).hostname
    } catch {
      host = undefined
    }
    build({ key: `manual:${m.id}`, url: m.url, source: 'manual', fallbackName: m.name, hostForSlug: host, manual: m })
  }

  // 5: overrides from the UI win over everything.
  const ov = new Map(input.overrides.map((o) => [o.serviceKey, o]))
  const final: Service[] = []
  for (const s of services) {
    const o = ov.get(s.key)
    if (o?.hidden) continue
    if (o) {
      if (o.name) s.name = o.name
      if (o.group) s.group = o.group
      const ou = safeUrl(o.url)
      if (ou) {
        s.url = ou
        s.host = hostOf(ou)
      }
      if (o.icon) s.icon = resolveIcon(o.icon, [], input.iconIndex, s.key)
      s.pinned = o.pinned
    }
    final.push(s)
  }

  // Group, pinned first, then by name. Group order from the groups table, else alphabetical with "Links" last.
  const byGroup = new Map<string, Service[]>()
  for (const s of final) byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s])
  const order = input.groupOrder ?? []
  const rank = (g: string) => {
    const i = order.indexOf(g)
    return i >= 0 ? i : g === 'Links' ? 10_000 : 1_000
  }
  return [...byGroup.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, 'de'))
    .map(([name, items]) => {
      const sources = new Set(items.map((i) => i.source))
      const note = sources.size === 1 && sources.has('manual') ? 'manuell angelegt' : sources.has('manual') ? 'erkannt und manuell' : 'aus Caddy und Quadlets'
      return { name, note, items: items.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.name.localeCompare(b.name, 'de')) }
    })
}

/** Display name of a well-known app among the slug candidates ("ha" → "Home Assistant"). */
function prettyName(candidates: string[]): string | undefined {
  const slug = candidates.find((x) => knownApp([x]))
  return slug ? (knownApp([slug])!.name ?? titleCase(slug)) : undefined
}

/** Default name for a container: the known app behind its image, else its name ("immich-server" → "Immich"). */
function knownName(c: Container): string {
  return prettyName(slugCandidates({ image: c.image, container: c.name })) ?? titleCase(c.name)
}
