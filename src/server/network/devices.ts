// The LAN scan (root helper): ping sweep of the server's own private subnets, the neighbour
// table for MACs, names from reverse DNS and mDNS, vendors from the OUI list.

import { promises as dns } from 'node:dns'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { BUILTIN_OUI, hostsOf, inSubnets, lanSubnets, ouiOf, parseAvahi, parseFping, parseNeigh, parseOui, parsePingTime, type ScanResult, type SeenDevice } from '~/shared/devices'
import type { NetInterface } from '~/shared/network'
import { run as exec, type ExecResult } from '../exec'

export const OUI_FILES = ['/usr/share/hwdata/oui.txt', '/usr/share/ieee-data/oui.txt', '/usr/share/misc/oui.txt', '/usr/share/nmap/nmap-mac-prefixes']

export interface ScanDeps {
  run: (argv: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>
  which: (bin: string) => string | null
  reverse: (ip: string) => Promise<string | undefined>
  ouiFiles: string[]
  hostname: string
}

const reverseDns = async (ip: string) => {
  const t = new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500))
  const name = await Promise.race([
    dns.reverse(ip).then(
      (n) => n[0],
      () => undefined,
    ),
    t,
  ])
  return name?.replace(/\.$/, '')
}

export const systemDeps = (): ScanDeps => ({
  run: exec,
  which: (b) => Bun.which(b),
  reverse: reverseDns,
  ouiFiles: OUI_FILES,
  hostname: hostname(),
})

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!)
    }),
  )
}

/** Who answers a ping: fping when installed (fast), else ping in parallel. */
async function sweep(subnets: string[], d: ScanDeps): Promise<{ alive: Map<string, number | undefined>; tool?: string }> {
  if (d.which('fping')) {
    const r = await d.run(['fping', '-a', '-e', '-q', '-r', '1', '-t', '300', ...subnets.flatMap((s) => ['-g', s])], { timeoutMs: 60_000 })
    // fping exits 1 when some hosts did not answer; alive hosts go to stdout either way
    return { alive: parseFping(r.stdout), tool: 'fping' }
  }
  if (!d.which('ping')) return { alive: new Map() }
  const alive = new Map<string, number | undefined>()
  await pool(subnets.flatMap(hostsOf), 64, async (ip) => {
    const r = await d.run(['ping', '-n', '-c', '1', '-W', '1', ip], {
      timeoutMs: 3000,
    })
    if (r.code === 0) alive.set(ip, parsePingTime(r.stdout))
  })
  return { alive, tool: 'ping' }
}

function vendors(macs: string[], files: string[]): Map<string, string> {
  const wanted = new Set(macs.map(ouiOf))
  const out = new Map<string, string>()
  for (const f of files) {
    if (!existsSync(f)) continue
    try {
      for (const [k, v] of parseOui(readFileSync(f, 'utf8'), wanted)) if (!out.has(k)) out.set(k, v)
    } catch {
      // unreadable: the next file or the built-in list
    }
    if (out.size === wanted.size) break
  }
  for (const p of wanted) if (!out.has(p) && BUILTIN_OUI[p]) out.set(p, BUILTIN_OUI[p]!)
  return out
}

/**
 * Active: ping every host of the own private subnets first (at most /22 each), so the neighbour
 * table fills. Passive: only what the kernel already knows. Never leaves the own subnets.
 */
export async function scanLan(interfaces: NetInterface[], active: boolean, d: ScanDeps = systemDeps()): Promise<ScanResult> {
  const subnets = lanSubnets(interfaces)
  const missing: string[] = []
  const { alive, tool } = active && subnets.length ? await sweep(subnets, d) : { alive: new Map<string, number | undefined>(), tool: 'none' }
  if (!tool) missing.push('ping')
  else if (tool === 'ping') missing.push('fping')

  const neigh = parseNeigh((await d.run(['ip', '-j', 'neigh', 'show'])).stdout).filter((n) => inSubnets(n.ip, subnets))
  const byIp = new Map<string, SeenDevice>()
  for (const n of neigh) if (n.fresh || alive.has(n.ip)) byIp.set(n.ip, { ip: n.ip, mac: n.mac, services: [] })
  for (const [ip, rtt] of alive)
    byIp.set(ip, {
      ...(byIp.get(ip) ?? { ip, services: [] }),
      ...(rtt !== undefined ? { rtt } : {}),
    })

  // The server itself (never in its own neighbour table).
  const selfIps: string[] = []
  for (const i of interfaces)
    for (const a of i.addresses)
      if (a.family === 'inet' && inSubnets(a.address, subnets)) {
        selfIps.push(a.address)
        byIp.set(a.address, {
          ip: a.address,
          ...(i.mac ? { mac: i.mac.toLowerCase() } : {}),
          name: d.hostname,
          services: [],
        })
      }

  if (d.which('avahi-browse')) {
    const r = await d.run(['avahi-browse', '-a', '-p', '-r', '-t'], {
      timeoutMs: 10_000,
    })
    for (const [ip, m] of parseAvahi(r.stdout)) {
      const e = byIp.get(ip)
      if (!e) continue
      e.services = [...m.services]
      if (m.host && !e.name) e.name = m.host
    }
  } else missing.push('avahi-browse')

  await pool(
    [...byIp.values()].filter((e) => !selfIps.includes(e.ip)),
    16,
    async (e) => {
      const n = await d.reverse(e.ip)
      // The router's name beats mDNS ("fritz.box" names are what people set there)
      if (n) e.name = n
    },
  )

  const v = vendors(
    [...byIp.values()].flatMap((e) => (e.mac ? [e.mac] : [])),
    d.ouiFiles,
  )
  for (const e of byIp.values()) {
    const name = e.mac ? v.get(ouiOf(e.mac)) : undefined
    if (name) e.vendor = name
  }
  return {
    at: Date.now(),
    subnets,
    devices: [...byIp.values()],
    missing,
    selfIps,
    active,
  }
}
