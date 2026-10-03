// Network overview: `ip -j`, `ss`, resolv.conf/resolvectl and the firewall
// tools. Runs as root (the helper) so ss can name the process behind every
// port; nothing is changed.

import { existsSync, readFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { run } from '../exec'
import { msg } from '~/shared/i18n'
import { firewallVerdict, scopeOf, type FirewallInfo, type IfaceKind, type ListeningPort, type NetInterface, type NetRoute, type NetworkState } from '~/shared/network'

export interface NetworkAdmin {
  networkState(): Promise<NetworkState>
}

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8').trim()
  } catch {
    return undefined
  }
}

interface IpLink {
  ifname: string
  flags?: string[]
  mtu: number
  operstate?: string
  link_type?: string
  address?: string
  master?: string
  linkinfo?: { info_kind?: string }
  addr_info?: { family: string; local: string; prefixlen: number; scope: string; dynamic?: boolean }[]
}

export function ifaceKind(l: IpLink, sys = '/sys/class/net'): IfaceKind {
  const k = l.linkinfo?.info_kind
  if (l.link_type === 'loopback') return 'loopback'
  if (k === 'wireguard' || k === 'tun' || /^(wg|tun|tap|tailscale|zt)/.test(l.ifname)) return 'vpn'
  if (k === 'bridge' || /^(podman|cni-)/.test(l.ifname)) return 'bridge'
  if (k === 'veth' || /^(veth|vnet)/.test(l.ifname)) return 'container'
  if (existsSync(join(sys, l.ifname, 'wireless'))) return 'wifi'
  if (existsSync(join(sys, l.ifname, 'device')) && !k) return 'ethernet'
  return 'virtual'
}

/** `ip -j -d addr show`. */
export function parseIpAddr(json: string, sys = '/sys/class/net'): NetInterface[] {
  const links = JSON.parse(json) as IpLink[]
  return links.map((l) => {
    const speed = Number(read(join(sys, l.ifname, 'speed')))
    const rx = Number(read(join(sys, l.ifname, 'statistics/rx_bytes')))
    const tx = Number(read(join(sys, l.ifname, 'statistics/tx_bytes')))
    const up = l.flags?.includes('UP')
    return {
      name: l.ifname,
      kind: ifaceKind(l, sys),
      state: l.operstate === 'UNKNOWN' && up ? (l.flags?.includes('LOWER_UP') ? 'UP' : 'UNKNOWN') : (l.operstate ?? (up ? 'UP' : 'DOWN')),
      mac: l.address && l.address !== '00:00:00:00:00:00' && l.link_type !== 'none' ? l.address : undefined,
      mtu: l.mtu,
      speedMbps: speed > 0 && speed < 1_000_000 ? speed : undefined,
      master: l.master,
      addresses: (l.addr_info ?? []).filter((a) => a.family === 'inet' || a.family === 'inet6').map((a) => ({ family: a.family as 'inet' | 'inet6', address: a.local, prefix: a.prefixlen, scope: a.scope, dynamic: a.dynamic || undefined })),
      rxBytes: Number.isFinite(rx) ? rx : undefined,
      txBytes: Number.isFinite(tx) ? tx : undefined,
    }
  })
}

/** Without iproute2: what Node knows. */
export function fallbackInterfaces(): NetInterface[] {
  return Object.entries(networkInterfaces()).map(([name, list]) => ({
    name,
    kind: name === 'lo' ? 'loopback' : existsSync(`/sys/class/net/${name}/device`) ? 'ethernet' : 'virtual',
    state: read(`/sys/class/net/${name}/operstate`)?.toUpperCase() ?? 'UNKNOWN',
    mac: list?.[0]?.mac !== '00:00:00:00:00:00' ? list?.[0]?.mac : undefined,
    mtu: Number(read(`/sys/class/net/${name}/mtu`)) || 0,
    addresses: (list ?? []).map((a) => ({ family: a.family === 'IPv4' ? 'inet' : 'inet6', address: a.address, prefix: Number(a.cidr?.split('/')[1] ?? 0), scope: a.internal ? 'host' : 'global' })),
  }))
}

/** `ip -j route show` (and -6). */
export function parseRoutes(json: string, family: 'inet' | 'inet6'): NetRoute[] {
  try {
    return (JSON.parse(json) as { dst: string; gateway?: string; dev?: string }[]).map((r) => ({ family, dst: r.dst, gateway: r.gateway, dev: r.dev }))
  } catch {
    return []
  }
}

export function parseResolvConf(text: string) {
  const servers: string[] = []
  const search: string[] = []
  for (const l of text.split('\n')) {
    const m = l.trim().match(/^(nameserver|search|domain)\s+(.+)$/)
    if (!m) continue
    if (m[1] === 'nameserver') servers.push(m[2]!.trim())
    else search.push(...m[2]!.trim().split(/\s+/))
  }
  return { servers, search: [...new Set(search)] }
}

/** `resolvectl dns`: "Global: 1.1.1.1" / "Link 2 (eth0): 192.168.1.1 fd00::1". */
export function parseResolvectl(text: string): string[] {
  const out: string[] = []
  for (const l of text.split('\n')) {
    const m = l.match(/^(?:Global|Link \d+ \([^)]+\)):\s*(.*)$/)
    if (m) out.push(...m[1]!.split(/\s+/).filter(Boolean))
  }
  return [...new Set(out)]
}

/**
 * `ss -H -tulpn`: one row per port/protocol/process; IPv4 and IPv6 sockets
 * of the same program are merged.
 */
export function parseSs(text: string): ListeningPort[] {
  const byKey = new Map<string, ListeningPort>()
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5) continue
    const proto = cols[0] === 'tcp' ? 'tcp' : cols[0] === 'udp' ? 'udp' : undefined
    if (!proto) continue
    if (proto === 'tcp' && cols[1] !== 'LISTEN') continue
    const local = cols[4]!
    const m = local.match(/^\[?([^\]]*?)\]?(?:%[\w.-]+)?:(\d+|\*)$/)
    if (!m || m[2] === '*') continue
    const addr = m[1] === '' ? '*' : m[1]!
    const port = Number(m[2])
    const users = line.match(/users:\(\("([^"]+)",pid=(\d+)/)
    const process = users?.[1]
    const pid = users ? Number(users[2]) : undefined
    const key = `${proto}/${port}/${process ?? ''}`
    const e = byKey.get(key) ?? { proto, port, addresses: [], scope: 'local', process, pid }
    if (!e.addresses.includes(addr)) e.addresses.push(addr)
    e.scope = scopeOf(e.addresses)
    byKey.set(key, e)
  }
  return [...byKey.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))
}

/** systemd unit or container of a process from its cgroup path. */
export function cgroupOwner(cgroup: string): { unit?: string; containerId?: string } {
  const path =
    cgroup
      .split('\n')
      .find((l) => l.startsWith('0::'))
      ?.slice(3) ??
    cgroup.split('\n')[0]?.split(':')[2] ??
    ''
  const ct = path.match(/libpod-(?:conmon-)?([0-9a-f]{12,64})\.scope/)
  if (ct) return { containerId: ct[1] }
  const unit = path
    .split('/')
    .reverse()
    .find((p) => /\.(service|socket)$/.test(p))
  return { unit }
}

/** firewall-cmd --list-all (one zone). */
export function parseFirewalldZone(text: string) {
  const get = (k: string) =>
    text
      .match(new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm'))?.[1]
      ?.trim()
      .split(/\s+/)
      .filter(Boolean) ?? []
  return { zone: text.match(/^(\S+)(?:\s+\(active\))?/)?.[1], services: get('services'), ports: get('ports') }
}

/** `ufw status`: active flag and ALLOW rules (ports and app profiles). */
export function parseUfw(text: string): { active: boolean; ports: string[]; services: string[] } {
  const active = /^Status:\s*active/m.test(text)
  const ports: string[] = []
  const services: string[] = []
  for (const l of text.split('\n')) {
    const m = l.match(/^(\S+(?: \S+)*?)\s+ALLOW(?: IN)?\s+/)
    if (!m) continue
    const target = m[1]!.replace(/ \(v6\)$/, '')
    if (/^\d+([:-]\d+)?(\/(tcp|udp))?$/.test(target)) ports.push(target.replace(':', '-'))
    else services.push(target)
  }
  return { active, ports: [...new Set(ports)], services: [...new Set(services)] }
}

async function firewall(): Promise<FirewallInfo> {
  if (Bun.which('firewall-cmd')) {
    const state = await run(['firewall-cmd', '--state'])
    if (state.stdout.trim() === 'running') {
      const zone = (await run(['firewall-cmd', '--get-default-zone'])).stdout.trim()
      const z = parseFirewalldZone((await run(['firewall-cmd', '--list-all'])).stdout)
      const ports = [...z.ports]
      for (const s of z.services.slice(0, 40)) {
        const info = await run(['firewall-cmd', `--info-service=${s}`])
        const p = info.stdout.match(/^\s*ports:\s*(.*)$/m)?.[1]?.trim()
        if (p) ports.push(...p.split(/\s+/))
      }
      return { kind: 'firewalld', active: true, zone: zone || z.zone, ports: [...new Set(ports)], services: z.services }
    }
  }
  if (Bun.which('ufw')) {
    const u = parseUfw((await run(['ufw', 'status'])).stdout)
    if (u.active)
      return {
        kind: 'ufw',
        active: true,
        ports: u.ports,
        services: u.services,
        note: u.services.length ? msg('network_note_appProfiles') : undefined,
      }
  }
  if (Bun.which('nft')) {
    const r = await run(['nft', 'list', 'ruleset'])
    // An input chain that drops by default means a hand-written firewall.
    if (/hook input[^\n]*policy drop/.test(r.stdout))
      return {
        kind: 'nftables',
        active: true,
        ports: [],
        services: [],
        note: msg('network_note_customNftables'),
      }
  }
  return { kind: 'none', active: false, ports: [], services: [] }
}

export class SystemNetwork implements NetworkAdmin {
  async networkState(): Promise<NetworkState> {
    const errors: string[] = []
    let interfaces: NetInterface[]
    const addr = await run(['ip', '-j', '-d', 'addr', 'show'])
    if (addr.code === 0) interfaces = parseIpAddr(addr.stdout)
    else {
      interfaces = fallbackInterfaces()
      if (addr.code === 127) errors.push(msg('network_error_ipMissing'))
    }
    const routes = [...parseRoutes((await run(['ip', '-j', 'route', 'show'])).stdout, 'inet'), ...parseRoutes((await run(['ip', '-6', '-j', 'route', 'show', 'default'])).stdout, 'inet6')]

    const dns: NetworkState['dns'] = parseResolvConf(read('/etc/resolv.conf') ?? '')
    if (dns.servers.includes('127.0.0.53') && Bun.which('resolvectl')) {
      const up = parseResolvectl((await run(['resolvectl', 'dns'])).stdout)
      if (up.length) dns.resolver = 'systemd-resolved'
      if (up.length) dns.servers = up
    }

    let ports: ListeningPort[] = []
    const ss = await run(['ss', '-H', '-tulpn'])
    if (ss.code === 0) ports = parseSs(ss.stdout)
    else errors.push(ss.code === 127 ? msg('network_error_ssMissing') : `ss: ${ss.stderr.trim()}`)
    for (const p of ports) {
      if (!p.pid) continue
      const owner = cgroupOwner(read(`/proc/${p.pid}/cgroup`) ?? '')
      p.unit = owner.unit
      if (owner.containerId) p.container = owner.containerId.slice(0, 12)
    }

    const fw = await firewall().catch((e) => {
      errors.push(`Firewall: ${(e as Error).message}`)
      return { kind: 'none', active: false, ports: [], services: [] } as FirewallInfo
    })
    for (const p of ports) p.firewall = firewallVerdict(p, fw)
    return { hostname: hostname(), interfaces, routes, dns, ports, firewall: fw, checkedAt: Date.now(), error: errors.join(' · ') || undefined }
  }
}

export class FixtureNetwork implements NetworkAdmin {
  constructor(private dir: string) {}

  async networkState(): Promise<NetworkState> {
    const s = JSON.parse(readFileSync(join(this.dir, 'network.json'), 'utf8')) as NetworkState
    for (const p of s.ports) p.firewall = firewallVerdict(p, s.firewall)
    return { ...s, checkedAt: Date.now() }
  }
}
