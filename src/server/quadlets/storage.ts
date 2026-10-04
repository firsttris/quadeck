// Podman storage through the libpod REST API (root helper): what lies on disk, what uses it, and
// removing exactly the confirmed items – never with force, so Podman itself refuses anything in use.

import { readFileSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { msg } from '~/shared/i18n'
import { confirmItems, normalizeImage, type CleanupItem, type CleanupResult, type PodmanContainer, type PodmanImage, type PodmanNetwork, type PodmanStorage, type PodmanVolume } from '~/shared/podman-storage'

export type PodmanApi = (path: string, init?: RequestInit) => Promise<Response>

/** What the Quadlet files say: image references, volume and network names they create. */
export interface QuadletRefs {
  images: { file: string; image: string }[]
  volumes: { file: string; name: string }[]
  networks: { file: string; name: string }[]
}

interface DfReport {
  ImagesSize?: number
  Images?: { ImageID: string; Size?: number; UniqueSize?: number; SharedSize?: number; Containers?: number }[] | null
  Containers?: { ContainerID: string; Size?: number; RWSize?: number }[] | null
  Volumes?: { VolumeName: string; Links?: number; Size?: number; ReclaimableSize?: number }[] | null
}
interface ImageSummary {
  Id: string
  Names?: string[] | null
  RepoTags?: string[] | null
  Created?: number
  Size?: number
  Dangling?: boolean
  /** Names the image had before (libpod: NamesHistory). */
  History?: string[] | null
}
interface ListContainer {
  Id: string
  Names?: string[] | null
  Image?: string
  ImageID?: string
  State?: string
  ExitCode?: number
  ExitedAt?: number
  Labels?: Record<string, string> | null
  Pod?: string
  IsInfra?: boolean
  Networks?: string[] | null
}
interface ContainerInspect {
  Mounts?: { Type?: string; Name?: string }[] | null
}
interface VolumeInfo {
  Name: string
  Mountpoint?: string
  CreatedAt?: string
  Anonymous?: boolean
}
interface NetworkInfo {
  name?: string
  Name?: string
}

const sameId = (a: string, b: string) => {
  const x = a.replace(/^sha256:/, '')
  const y = b.replace(/^sha256:/, '')
  return x.startsWith(y) || y.startsWith(x)
}

async function getJson<T>(api: PodmanApi, path: string): Promise<T> {
  const res = await api(path)
  if (!res.ok) throw new Error(`Podman-API ${path}: HTTP ${res.status}`)
  return (await res.json()) as T
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await fn(items[k]!)
      }
    }),
  )
  return out
}

export async function readStorage(api: PodmanApi, refs: QuadletRefs, disk: (root: string) => PodmanStorage['disk'] = diskOf): Promise<PodmanStorage> {
  const [df, images, list, vols, nets, info] = await Promise.all([
    getJson<DfReport>(api, '/v4.0.0/libpod/system/df'),
    getJson<ImageSummary[]>(api, '/v4.0.0/libpod/images/json'),
    getJson<ListContainer[]>(api, '/v4.0.0/libpod/containers/json?all=true'),
    getJson<VolumeInfo[]>(api, '/v4.0.0/libpod/volumes/json'),
    getJson<NetworkInfo[]>(api, '/v4.0.0/libpod/networks/json').catch(() => [] as NetworkInfo[]),
    getJson<{ store?: { graphRoot?: string } }>(api, '/v4.0.0/libpod/info').catch(() => ({}) as { store?: { graphRoot?: string } }),
  ])
  const mounts = await pool(list, 8, (c) => getJson<ContainerInspect>(api, `/v4.0.0/libpod/containers/${c.Id}/json`).catch(() => ({}) as ContainerInspect))

  const containers: PodmanContainer[] = list
    .filter((c) => !c.IsInfra)
    .map((c) => {
      const i = list.indexOf(c)
      const size = df.Containers?.find((d) => sameId(d.ContainerID, c.Id))
      return {
        id: c.Id,
        name: (c.Names?.[0] ?? '').replace(/^\//, ''),
        image: c.Image ?? '',
        imageId: c.ImageID ?? '',
        state: (c.State ?? 'unknown').toLowerCase(),
        ...(c.ExitCode !== undefined && c.State !== 'running' ? { exitCode: c.ExitCode } : {}),
        ...(c.ExitedAt && c.ExitedAt > 0 ? { exitedAt: c.ExitedAt * 1000 } : {}),
        ...(size?.RWSize !== undefined ? { size: size.RWSize } : size?.Size !== undefined ? { size: size.Size } : {}),
        ...(c.Labels?.PODMAN_SYSTEMD_UNIT ? { unit: c.Labels.PODMAN_SYSTEMD_UNIT } : {}),
        pod: !!c.Pod,
        volumes: (mounts[i]?.Mounts ?? []).filter((m) => m.Type === 'volume' && m.Name).map((m) => m.Name!),
        networks: c.Networks ?? [],
      }
    })
  // Infra containers hold their pod's networks and volumes too.
  const users = list.map((c, i) => ({ id: c.Id, volumes: (mounts[i]?.Mounts ?? []).filter((m) => m.Type === 'volume' && m.Name).map((m) => m.Name!), networks: c.Networks ?? [], imageId: c.ImageID ?? '' }))

  const quadletImages = refs.images.map((r) => ({ file: r.file, ref: normalizeImage(r.image) }))
  const outImages: PodmanImage[] = images.map((im) => {
    const names = [...new Set([...(im.Names ?? []), ...(im.RepoTags ?? [])])].filter((n) => n && !n.startsWith('<none>'))
    const d = df.Images?.find((x) => sameId(x.ImageID, im.Id))
    const dangling = im.Dangling ?? names.length === 0
    const previously = dangling ? (im.History ?? []).find((h) => h && !h.startsWith('<none>')) : undefined
    return {
      id: im.Id,
      names,
      size: d?.UniqueSize ?? im.Size ?? 0,
      ...(im.Created ? { created: im.Created * 1000 } : {}),
      dangling,
      usedBy: users.filter((u) => u.imageId && sameId(u.imageId, im.Id)).map((u) => u.id),
      quadlets: quadletImages.filter((q) => names.some((n) => normalizeImage(n) === q.ref)).map((q) => q.file),
      ...(previously ? { previously } : {}),
    }
  })

  const volumes: PodmanVolume[] = vols.map((v) => {
    const d = df.Volumes?.find((x) => x.VolumeName === v.Name)
    const created = v.CreatedAt ? Date.parse(v.CreatedAt) : NaN
    const quadlet = refs.volumes.find((q) => q.name === v.Name)?.file
    return {
      name: v.Name,
      ...(d?.Size !== undefined ? { size: d.Size } : {}),
      ...(Number.isFinite(created) ? { created } : {}),
      ...(v.Mountpoint ? { mountpoint: v.Mountpoint } : {}),
      anonymous: v.Anonymous ?? /^[0-9a-f]{64}$/.test(v.Name),
      usedBy: users.filter((u) => u.volumes.includes(v.Name)).map((u) => u.id),
      ...(quadlet ? { quadlet } : {}),
    }
  })

  const networks: PodmanNetwork[] = nets
    .map((n) => n.name ?? n.Name ?? '')
    .filter(Boolean)
    .map((name) => {
      const quadlet = refs.networks.find((q) => q.name === name)?.file
      return { name, usedBy: users.filter((u) => u.networks.includes(name)).map((u) => u.id), builtin: name === 'podman', ...(quadlet ? { quadlet } : {}) }
    })

  const root = info.store?.graphRoot
  const space = root ? disk(root) : undefined
  return { ...(root ? { root } : {}), ...(space ? { disk: space } : {}), images: outImages, containers, volumes, networks }
}

function diskOf(root: string): PodmanStorage['disk'] {
  try {
    const s = statfsSync(root)
    const size = s.blocks * s.bsize
    return { size, used: size - s.bfree * s.bsize }
  } catch {
    return undefined
  }
}

const PATH: Record<CleanupItem['kind'], (id: string) => string> = {
  container: (id) => `/v4.0.0/libpod/containers/${encodeURIComponent(id)}`,
  image: (id) => `/v4.0.0/libpod/images/${encodeURIComponent(id.replace(/^sha256:/, ''))}`,
  volume: (id) => `/v4.0.0/libpod/volumes/${encodeURIComponent(id)}`,
  network: (id) => `/v4.0.0/libpod/networks/${encodeURIComponent(id)}`,
}
const ORDER: CleanupItem['kind'][] = ['container', 'image', 'volume', 'network']

/** Re-reads, keeps only what is still removable, deletes one by one (no force), reports each. */
export async function cleanStorage(api: PodmanApi, refs: QuadletRefs, requested: { kind: CleanupItem['kind']; id: string }[]): Promise<{ results: CleanupResult[]; skipped: number }> {
  const fresh = await readStorage(api, refs, () => undefined)
  const items = confirmItems(fresh, requested).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
  const results: CleanupResult[] = []
  for (const item of items) {
    try {
      const res = await api(PATH[item.kind](item.id), { method: 'DELETE' })
      if (res.ok) results.push({ item, ok: true })
      else {
        const body = await res.text()
        let message = body
        try {
          message = (JSON.parse(body) as { message?: string }).message ?? body
        } catch {
          // plain text
        }
        results.push({ item, ok: false, error: res.status === 409 ? msg('podstore_error_inUse') : message.trim().slice(0, 300) || `HTTP ${res.status}` })
      }
    } catch (e) {
      results.push({ item, ok: false, error: (e as Error).message })
    }
  }
  return { results, skipped: requested.length - items.length }
}

/**
 * The demo: an in-memory Podman API over fixtures/demo/podman-storage.json, deletes included
 * (per process), so the page and the E2E test run through the same code as a real server.
 */
export function fixtureApi(dir: string): PodmanApi {
  const g = globalThis as unknown as { __qdPodmanFixture?: Record<string, unknown[]> & { df: DfReport } }
  const state = (g.__qdPodmanFixture ??= JSON.parse(readFileSync(join(dir, 'podman-storage.json'), 'utf8')))
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
  return async (path, init) => {
    const p = path.replace(/^\/v[\d.]+\/libpod/, '').split('?')[0]!
    const containers = state.containers as (ListContainer & { Mounts: ContainerInspect['Mounts'] })[]
    if (init?.method === 'DELETE') {
      const [, kind, raw] = p.split('/')
      const id = decodeURIComponent(raw ?? '')
      const key = kind === 'images' ? 'images' : kind === 'volumes' ? 'volumes' : kind === 'networks' ? 'networks' : 'containers'
      const list = state[key] as { Id?: string; Name?: string; name?: string }[]
      const i = list.findIndex((x) => (x.Id && sameId(x.Id, id)) || x.Name === id || x.name === id)
      if (i < 0) return json({ message: 'no such object' }, 404)
      const inUse = key === 'images' ? containers.some((c) => c.ImageID && sameId(c.ImageID, id)) : key === 'volumes' ? containers.some((c) => (c.Mounts ?? []).some((m) => m.Name === id)) : key === 'networks' ? containers.some((c) => (c.Networks ?? []).includes(id)) : containers[i]?.State === 'running'
      if (inUse) return json({ message: `${id} is in use` }, 409)
      list.splice(i, 1)
      return json([{ Id: id }])
    }
    if (p === '/system/df') return json(state.df)
    if (p === '/images/json') return json(state.images)
    if (p === '/containers/json') return json(containers.map(({ Mounts: _m, ...c }) => c))
    if (p === '/volumes/json') return json(state.volumes)
    if (p === '/networks/json') return json(state.networks)
    if (p === '/info') return json({ store: { graphRoot: '/var/lib/containers/storage' } })
    const m = /^\/containers\/([^/]+)\/json$/.exec(p)
    if (m) {
      const c = containers.find((x) => x.Id === m[1])
      return c ? json({ Mounts: c.Mounts ?? [] }) : json({ message: 'no such container' }, 404)
    }
    return json({ message: 'not found' }, 404)
  }
}
