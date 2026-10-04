// Podman storage: images, volumes, stopped containers and networks with what uses them, and
// what a cleanup would remove. Pure: the root helper reads the Podman API, the page computes the
// preview with the same functions the helper uses to decide what it actually deletes.

export interface PodmanImage {
  id: string
  names: string[]
  /** Bytes only this image holds (shared layers excluded) – what deleting it frees. */
  size: number
  created?: number
  dangling: boolean
  /** Container ids using it. */
  usedBy: string[]
  /** Quadlet .container files whose Image= names it (also when the service is stopped). */
  quadlets: string[]
  /** For an untagged image: the name it had before (old version after an update). */
  previously?: string
}

export interface PodmanContainer {
  id: string
  name: string
  image: string
  imageId: string
  state: string
  exitCode?: number
  exitedAt?: number
  size?: number
  /** systemd unit (Quadlet) that owns it. */
  unit?: string
  /** Part of a pod (the pod decides). */
  pod: boolean
  volumes: string[]
  networks: string[]
}

export interface PodmanVolume {
  name: string
  size?: number
  created?: number
  mountpoint?: string
  anonymous: boolean
  /** Container ids using it. */
  usedBy: string[]
  /** The Quadlet .volume file that creates it. */
  quadlet?: string
}

export interface PodmanNetwork {
  name: string
  usedBy: string[]
  /** The default network. */
  builtin: boolean
  quadlet?: string
}

export interface PruneTimer {
  every: PruneEvery
  last?: number
  next?: number
}
export type PruneEvery = 'weekly' | 'monthly'

export interface PodmanStorage {
  root?: string
  disk?: { size: number; used: number }
  images: PodmanImage[]
  containers: PodmanContainer[]
  volumes: PodmanVolume[]
  networks: PodmanNetwork[]
  prune?: PruneTimer
  error?: string
}

export type CleanupKind = 'container' | 'image' | 'volume' | 'network'
export interface CleanupItem {
  kind: CleanupKind
  id: string
  label: string
  size?: number
}

export interface CleanupSelection {
  containers: boolean
  /** Untagged images (old versions). */
  dangling: boolean
  /** Also tagged images no container and no Quadlet uses. */
  unusedImages: boolean
  networks: boolean
  /** Volumes picked one by one. */
  volumes: string[]
}

export interface CleanupResult {
  item: CleanupItem
  ok: boolean
  error?: string
}

export const defaultSelection = (): CleanupSelection => ({ containers: true, dangling: true, unusedImages: false, networks: true, volumes: [] })

const RUNNING = new Set(['running', 'paused', 'restarting', 'stopping', 'removing'])

/** Stopped containers Quadeck may remove: not owned by a Quadlet or a pod. */
export const removableContainer = (c: PodmanContainer) => !RUNNING.has(c.state) && !c.unit && !c.pod

export const shortId = (id: string) => id.replace(/^sha256:/, '').slice(0, 12)
export const containerLabel = (c: PodmanContainer) => c.name || shortId(c.id)
export const imageLabel = (i: PodmanImage) => i.names[0] ?? (i.previously ? `${shortId(i.id)} (${i.previously})` : shortId(i.id))

const unusedAfter = (usedBy: string[], removed: Set<string>) => usedBy.every((id) => removed.has(id))

/**
 * What goes, in this order: containers first (that frees their images and volumes), then images,
 * volumes and networks. Anything in use, owned by a Quadlet or the default network never shows up.
 */
export function cleanupPlan(s: PodmanStorage, sel: CleanupSelection): CleanupItem[] {
  const out: CleanupItem[] = []
  const gone = new Set<string>()
  if (sel.containers)
    for (const c of s.containers.filter(removableContainer)) {
      gone.add(c.id)
      out.push({ kind: 'container', id: c.id, label: containerLabel(c), ...(c.size !== undefined ? { size: c.size } : {}) })
    }
  for (const i of s.images) {
    if (!unusedAfter(i.usedBy, gone) || i.quadlets.length) continue
    if ((i.dangling && sel.dangling) || (!i.dangling && sel.unusedImages)) out.push({ kind: 'image', id: i.id, label: imageLabel(i), size: i.size })
  }
  const pick = new Set(sel.volumes)
  for (const v of s.volumes) if (pick.has(v.name) && !v.quadlet && unusedAfter(v.usedBy, gone)) out.push({ kind: 'volume', id: v.name, label: v.anonymous ? `${v.name.slice(0, 12)}…` : v.name, ...(v.size !== undefined ? { size: v.size } : {}) })
  if (sel.networks) for (const n of s.networks) if (!n.builtin && !n.quadlet && unusedAfter(n.usedBy, gone)) out.push({ kind: 'network', id: n.name, label: n.name })
  return out
}

/** Of the requested items, those still removable on a fresh read (used meanwhile → skipped). */
export function confirmItems(s: PodmanStorage, requested: { kind: CleanupKind; id: string }[]): CleanupItem[] {
  const want = new Set(requested.map((r) => `${r.kind}:${r.id}`))
  const containers = s.containers.filter((c) => want.has(`container:${c.id}`))
  const all = cleanupPlan({ ...s, containers }, { containers: true, dangling: true, unusedImages: true, networks: true, volumes: s.volumes.map((v) => v.name) })
  return all.filter((i) => want.has(`${i.kind}:${i.id}`))
}

export const planSize = (items: CleanupItem[]) => items.reduce((n, i) => n + (i.size ?? 0), 0)

/** The tiles: total and what a full cleanup (without volumes in use, with unused volumes) could free. */
export function storageSummary(s: PodmanStorage) {
  const sum = (xs: (number | undefined)[]) => xs.reduce<number>((n, x) => n + (x ?? 0), 0)
  const plan = cleanupPlan(s, { containers: true, dangling: true, unusedImages: true, networks: false, volumes: s.volumes.map((v) => v.name) })
  const of = (k: CleanupKind) => plan.filter((i) => i.kind === k)
  return {
    images: { count: s.images.length, size: sum(s.images.map((i) => i.size)), free: planSize(of('image')), unused: of('image').length },
    volumes: { count: s.volumes.length, size: sum(s.volumes.map((v) => v.size)), free: planSize(of('volume')), unused: of('volume').length },
    containers: { count: s.containers.length, running: s.containers.filter((c) => RUNNING.has(c.state)).length, size: sum(s.containers.map((c) => c.size)), free: planSize(of('container')), stopped: of('container').length },
  }
}

/** "jellyfin/jellyfin" → "docker.io/jellyfin/jellyfin:latest", for matching Quadlet Image= against image names. */
export function normalizeImage(ref: string): string {
  let r = ref.trim()
  if (!r) return r
  const first = r.split('/')[0]!
  if (!r.includes('/')) r = `docker.io/library/${r}`
  else if (!/[.:]/.test(first) && first !== 'localhost') r = `docker.io/${r}`
  const last = r.split('/').pop()!
  if (!last.includes(':') && !r.includes('@')) r += ':latest'
  return r
}

/** Image= of a .container file, Volume name of a .volume file, Network name of a .network file. */
export function quadletKey(content: string, key: 'Image' | 'VolumeName' | 'NetworkName'): string | undefined {
  return new RegExp(`^\\s*${key}\\s*=\\s*(\\S.*?)\\s*$`, 'm').exec(content)?.[1]
}

export const PRUNE_TIMER = 'quadeck-podman-prune'
export const PRUNE_CALENDAR: Record<PruneEvery, string> = { weekly: 'Sun *-*-* 04:00:00', monthly: '*-*-01 04:00:00' }
/** The safe part only: stopped containers without a Quadlet, untagged images; both older than a week. Never volumes. */
export const PRUNE_COMMAND = ['podman container prune -f --filter until=168h --filter label!=PODMAN_SYSTEMD_UNIT', 'podman image prune -f --filter until=168h'].join('\n')

export function parseSelection(v: unknown): CleanupSelection {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    containers: o.containers === true,
    dangling: o.dangling === true,
    unusedImages: o.unusedImages === true,
    networks: o.networks === true,
    volumes: Array.isArray(o.volumes) ? o.volumes.filter((x): x is string => typeof x === 'string').slice(0, 500) : [],
  }
}

export function parseItems(v: unknown): { kind: CleanupKind; id: string }[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is { kind: CleanupKind; id: string } => !!x && typeof x === 'object' && ['container', 'image', 'volume', 'network'].includes((x as { kind: string }).kind) && typeof (x as { id: unknown }).id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test((x as { id: string }).id))
    .slice(0, 1000)
}
