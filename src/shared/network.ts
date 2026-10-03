// Network overview (read only): interfaces, routes, DNS, listening ports and
// the firewall's view on them.

import { msg } from './i18n'

export type IfaceKind = 'ethernet' | 'wifi' | 'bridge' | 'container' | 'vpn' | 'thread' | 'loopback' | 'virtual'

export interface NetAddress {
  family: 'inet' | 'inet6'
  address: string
  prefix: number
  scope: string
  dynamic?: boolean
}

export interface NetInterface {
  name: string
  kind: IfaceKind
  /** UP, DOWN, UNKNOWN (e.g. loopback, some virtual links). */
  state: string
  mac?: string
  mtu: number
  speedMbps?: number
  /** Bridge or bond it belongs to. */
  master?: string
  addresses: NetAddress[]
  rxBytes?: number
  txBytes?: number
}

export interface NetRoute {
  family: 'inet' | 'inet6'
  dst: string
  gateway?: string
  dev?: string
}

export type PortScope = 'all' | 'local' | 'address'

export interface ListeningPort {
  proto: 'tcp' | 'udp'
  port: number
  /** All addresses the socket(s) listen on. */
  addresses: string[]
  scope: PortScope
  process?: string
  pid?: number
  /** systemd unit of the process. */
  unit?: string
  /** Container (published port or the process belongs to one). */
  container?: string
  /** Firewall verdict for connections from the network. */
  firewall?: 'open' | 'blocked' | 'podman' | 'unknown'
}

export interface FirewallInfo {
  kind: 'firewalld' | 'ufw' | 'nftables' | 'none'
  active: boolean
  zone?: string
  /** Allowed ports ("22/tcp", "8000-8100/tcp"). */
  ports: string[]
  /** Allowed services by name (firewalld services, ufw app profiles). */
  services: string[]
  note?: string
}

export interface NetworkState {
  hostname: string
  interfaces: NetInterface[]
  routes: NetRoute[]
  dns: { servers: string[]; search: string[]; resolver?: string }
  ports: ListeningPort[]
  firewall: FirewallInfo
  checkedAt: number
  error?: string
}

export function scopeOf(addresses: string[]): PortScope {
  const all = addresses.some((a) => a === '0.0.0.0' || a === '::' || a === '*')
  if (all) return 'all'
  const local = addresses.every((a) => /^127\./.test(a) || a === '::1' || a === 'localhost')
  return local ? 'local' : 'address'
}

/** "8000-8100/tcp" style list → does it contain port/proto? */
export function portAllowed(list: string[], port: number, proto: string): boolean {
  return list.some((p) => {
    const m = p.match(/^(\d+)(?:[-:](\d+))?(?:\/(tcp|udp))?$/)
    if (!m) return false
    const lo = Number(m[1])
    const hi = m[2] ? Number(m[2]) : lo
    return port >= lo && port <= hi && (!m[3] || m[3] === proto)
  })
}

/** What the firewall does with a port reachable from the network. */
export function firewallVerdict(p: ListeningPort, fw: FirewallInfo): ListeningPort['firewall'] {
  if (p.scope === 'local') return undefined
  if (!fw.active) return 'open'
  // Podman adds its own forwarding rules for published ports.
  if (p.container && !p.process) return 'podman'
  if (fw.kind === 'nftables') return 'unknown'
  return portAllowed(fw.ports, p.port, p.proto) ? 'open' : 'blocked'
}

/** Well-known ports, so a bare number means something. */
export const knownPorts = (): Record<string, string> => ({
  '22/tcp': 'SSH',
  '53/udp': 'DNS',
  '53/tcp': 'DNS',
  '80/tcp': 'HTTP',
  '443/tcp': 'HTTPS',
  '443/udp': 'HTTP/3',
  '111/tcp': 'rpcbind (NFS)',
  '111/udp': 'rpcbind (NFS)',
  '139/tcp': 'SMB (NetBIOS)',
  '445/tcp': 'SMB',
  '2049/tcp': 'NFS',
  '631/tcp': msg('network_service_printer'),
  '5353/udp': 'mDNS/Avahi',
  '9090/tcp': 'Cockpit',
  '5355/udp': 'LLMNR',
  '5355/tcp': 'LLMNR',
  '137/udp': 'NetBIOS',
  '138/udp': 'NetBIOS',
  '3702/udp': 'WS-Discovery',
  '51820/udp': 'WireGuard',
})

/**
 * Adds what Podman knows: names for container processes and published ports.
 * Rootful Podman forwards published ports with firewall rules, so they often
 * have no listening socket of their own.
 */
export function mergeContainerPorts(ports: ListeningPort[], containers: { id: string; name: string; ports: { hostIp?: string; hostPort: number; protocol: string }[] }[], fw: FirewallInfo): ListeningPort[] {
  const out = ports.map((p) => {
    const c = p.container ? containers.find((x) => x.id.startsWith(p.container!)) : undefined
    return c ? { ...p, container: c.name } : { ...p }
  })
  for (const c of containers)
    for (const cp of c.ports) {
      const proto = cp.protocol === 'udp' ? 'udp' : 'tcp'
      const existing = out.find((p) => p.port === cp.hostPort && p.proto === proto)
      if (existing) {
        existing.container ??= c.name
        continue
      }
      const addresses = [cp.hostIp || '0.0.0.0']
      const p: ListeningPort = { proto, port: cp.hostPort, addresses, scope: scopeOf(addresses), container: c.name }
      p.firewall = firewallVerdict(p, fw)
      out.push(p)
    }
  return out.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))
}
