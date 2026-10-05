// Podman collector: containers, ports, labels, health and stats via the
// Podman REST API on podman.sock. Read-only except for start/stop/restart of
// containers that have no systemd unit.

import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { existsSync } from 'node:fs'
import type { Container, ContainerPort } from '~/shared/types'

export const UNIT_LABEL = 'PODMAN_SYSTEMD_UNIT'

interface CompatContainer {
  Id: string
  Names?: string[]
  Image: string
  State: string
  Status: string
  Labels?: Record<string, string> | null
  Ports?: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[] | null
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string; Aliases?: string[] | null }> | null }
}

interface InspectInfo {
  aliases: string[]
  hostname?: string
}

interface LibpodStats {
  Stats?: { ContainerID: string; CPU: number; MemUsage: number }[] | null
}

export function parseHealth(status: string): Container['health'] {
  const m = status.match(/\((healthy|unhealthy|starting|health: starting)\)/)
  if (!m) return undefined
  return m[1] === 'health: starting' ? 'starting' : (m[1] as Container['health'])
}

export function mapContainer(c: CompatContainer, inspect?: InspectInfo): Omit<Container, 'cpuHistory'> {
  const labels = c.Labels ?? {}
  const ports: ContainerPort[] = []
  for (const p of c.Ports ?? []) {
    if (!p.PublicPort) continue
    ports.push({ hostIp: p.IP || undefined, hostPort: p.PublicPort, containerPort: p.PrivatePort, protocol: p.Type })
  }
  const nets = c.NetworkSettings?.Networks ?? {}
  const aliases = new Set<string>()
  for (const n of Object.values(nets)) for (const a of n.Aliases ?? []) aliases.add(a)
  for (const a of inspect?.aliases ?? []) aliases.add(a)
  if (inspect?.hostname) aliases.add(inspect.hostname)
  const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '')
  aliases.delete(name)
  return {
    id: c.Id,
    name,
    image: c.Image,
    state: c.State,
    status: c.Status,
    health: parseHealth(c.Status),
    labels,
    ports,
    networks: Object.keys(nets),
    aliases: [...aliases].filter((a) => !/^[0-9a-f]{12,}$/.test(a)),
    ips: Object.values(nets)
      .map((n) => n.IPAddress)
      .filter((x): x is string => !!x),
    unit: labels[UNIT_LABEL] || undefined,
  }
}

const HISTORY = 60 // 15 min at one sample every 15 s

/** Read-only Podman API access (directly or through the root helper). */
export type PodmanGet = <T>(path: string) => Promise<T>

export class PodmanCollector {
  private inspectCache = new Map<string, InspectInfo>()
  private history = new Map<string, number[]>()
  private lastHistoryAt = 0
  constructor(
    private get: PodmanGet,
    /** Only checked when talking to the socket directly. */
    private socket?: string,
  ) {}

  async version(): Promise<string | undefined> {
    return (await this.get<{ Version?: string }>('/version')).Version
  }

  private async inspect(id: string): Promise<InspectInfo> {
    const hit = this.inspectCache.get(id)
    if (hit) return hit
    const info = await this.get<{ Config?: { Hostname?: string }; NetworkSettings?: { Networks?: Record<string, { Aliases?: string[] | null }> } }>(`/containers/${id}/json`)
      .then((r) => ({
        hostname: r.Config?.Hostname,
        aliases: Object.values(r.NetworkSettings?.Networks ?? {}).flatMap((n) => n.Aliases ?? []),
      }))
      .catch(() => ({ aliases: [] }))
    this.inspectCache.set(id, info)
    return info
  }

  async collect(): Promise<Container[]> {
    if (this.socket && !existsSync(this.socket)) throw new Error(msg(m.podman_error_socketMissing, { socket: this.socket }))
    const list = await this.get<CompatContainer[]>('/containers/json?all=true')
    const stats = await this.get<LibpodStats>('/v4.0.0/libpod/containers/stats?stream=false')
      .then((s) => new Map((s.Stats ?? []).map((x) => [x.ContainerID, x])))
      .catch(() => new Map<string, { CPU: number; MemUsage: number }>())

    const live = new Set(list.map((c) => c.Id))
    for (const id of this.inspectCache.keys()) if (!live.has(id)) this.inspectCache.delete(id)

    const now = Date.now()
    const pushHistory = now - this.lastHistoryAt >= 15_000
    if (pushHistory) this.lastHistoryAt = now

    // inspect is cached per container; new ones (first tick, after a recreate) are asked in parallel
    const inspected = new Map(await Promise.all(list.filter((c) => c.State === 'running').map(async (c) => [c.Id, await this.inspect(c.Id)] as const)))
    const out: Container[] = []
    for (const c of list) {
      const base = mapContainer(c, inspected.get(c.Id))
      const st = stats.get(c.Id)
      const running = c.State === 'running'
      const cpu = running && st ? st.CPU : undefined
      const key = base.name
      let hist = this.history.get(key) ?? []
      if (pushHistory) {
        hist = [...hist, cpu ?? 0].slice(-HISTORY)
        this.history.set(key, hist)
      }
      out.push({ ...base, cpu, memUsage: running && st ? st.MemUsage : undefined, cpuHistory: hist })
    }
    for (const k of this.history.keys()) if (!out.some((c) => c.name === k)) this.history.delete(k)
    return out.sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.name.localeCompare(b.name))
  }
}
