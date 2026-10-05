// Devices in the local network: who answers, under which name, from which vendor, with which
// services. Parsers for `ip neigh`, `avahi-browse`, OUI lists; subnets to sweep; merging a scan
// into what Quadeck remembers. No I/O here.

import { msg } from './i18n'
import { m } from '~/paraglide/messages'
import type { NetInterface } from './network'

export interface SeenDevice {
  ip: string
  mac?: string
  /** Name from reverse DNS (the router usually knows it) or mDNS. */
  name?: string
  vendor?: string
  /** Services announced over mDNS (_ipp._tcp …). */
  services: string[]
  /** Round trip of the ping, ms. */
  rtt?: number
}

export interface ScanResult {
  at: number
  /** Subnets that were swept. */
  subnets: string[]
  devices: SeenDevice[]
  /** Missing tools (avahi-browse …), shown as a hint. */
  missing: string[]
  /** The server's own addresses in these subnets. */
  selfIps: string[]
  /** Pinged (true) or only the neighbour table (false). */
  active: boolean
}

/** What Quadeck keeps per device (settings key devices.known), keyed by MAC (or IP without one). */
export interface KnownDevice {
  key: string
  ip: string
  mac?: string
  name?: string
  vendor?: string
  services: string[]
  firstSeen: number
  lastSeen: number
  /** The admin's own name and note. */
  label?: string
  note?: string
  /** Marked as known: no "new device" alert. */
  known?: boolean
}

export interface DeviceView extends KnownDevice {
  online: boolean
  rtt?: number
  randomMac: boolean
  /** This server itself. */
  self?: boolean
}

// ---------- addresses ----------

const ipNum = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0)
const numIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')
export const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
export const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/

export function isPrivateV4(ip: string): boolean {
  if (!IPV4.test(ip)) return false
  const [a, b] = ip.split('.').map(Number) as [number, number]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** Interfaces that face the home network (not VPN, containers, loopback). */
const LAN_KINDS = new Set(['ethernet', 'wifi', 'bridge', 'bond'])

/** The private IPv4 subnets the server sits in; wider than /22 is narrowed to the /24 around its address. */
export function lanSubnets(interfaces: Pick<NetInterface, 'kind' | 'addresses' | 'state'>[]): string[] {
  const out = new Set<string>()
  for (const i of interfaces) {
    if (!LAN_KINDS.has(i.kind)) continue
    for (const a of i.addresses) {
      if (a.family !== 'inet' || a.scope === 'host' || !isPrivateV4(a.address)) continue
      const prefix = a.prefix < 22 ? 24 : a.prefix
      if (prefix > 30) continue
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
      out.add(`${numIp((ipNum(a.address) & mask) >>> 0)}/${prefix}`)
    }
  }
  return [...out]
}

/** Host addresses of a subnet (no network and broadcast address). */
export function hostsOf(cidr: string): string[] {
  const [net, p] = cidr.split('/')
  const prefix = Number(p)
  if (!net || !IPV4.test(net) || !(prefix >= 22 && prefix <= 30)) return []
  const base = ipNum(net)
  const size = 2 ** (32 - prefix)
  return Array.from({ length: size - 2 }, (_, i) => numIp(base + i + 1))
}

export function inSubnets(ip: string, subnets: string[]): boolean {
  if (!IPV4.test(ip)) return false
  return subnets.some((c) => {
    const [net, p] = c.split('/')
    const mask = (0xffffffff << (32 - Number(p))) >>> 0
    return (ipNum(ip) & mask) >>> 0 === (ipNum(net!) & mask) >>> 0
  })
}

/** Locally administered MACs: phones and laptops use random ones per network. */
export function isRandomMac(mac: string | undefined): boolean {
  if (!mac || !MAC.test(mac) || mac.startsWith('52:54:00')) return false
  return (parseInt(mac.slice(1, 2), 16) & 2) === 2
}

// ---------- parsers ----------

/** `ip -j neigh`: IPv4 neighbours with a MAC that are not failed; `fresh` when the kernel heard from them lately. */
export function parseNeigh(json: string): { ip: string; mac: string; dev?: string; fresh: boolean }[] {
  let list: { dst?: string; lladdr?: string; dev?: string; state?: string[] }[]
  try {
    list = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  return list
    .filter((n) => n.dst && IPV4.test(n.dst) && n.lladdr && MAC.test(n.lladdr.toLowerCase()) && !(n.state ?? []).some((s) => s === 'FAILED' || s === 'INCOMPLETE' || s === 'NOARP'))
    .map((n) => ({
      ip: n.dst!,
      mac: n.lladdr!.toLowerCase(),
      ...(n.dev ? { dev: n.dev } : {}),
      fresh: (n.state ?? []).some((s) => s === 'REACHABLE' || s === 'DELAY' || s === 'PROBE' || s === 'PERMANENT'),
    }))
}

/** `fping -a -e`: "192.168.1.1 (0.42 ms)" per host that answered. */
export function parseFping(out: string): Map<string, number | undefined> {
  const alive = new Map<string, number | undefined>()
  for (const line of out.split('\n')) {
    const m = /^(\S+)(?:\s+\(([\d.]+) ms\))?/.exec(line.trim())
    if (m && IPV4.test(m[1]!)) alive.set(m[1]!, m[2] ? Number(m[2]) : undefined)
  }
  return alive
}

/** `avahi-browse -aprt`: resolved lines "=;if;IPv4;name;type;domain;host;address;port;txt". */
export function parseAvahi(out: string): Map<string, { host?: string; services: Set<string> }> {
  const byIp = new Map<string, { host?: string; services: Set<string> }>()
  for (const line of out.split('\n')) {
    const f = line.split(';')
    if (f[0] !== '=' || f[2] !== 'IPv4' || !f[7] || !IPV4.test(f[7])) continue
    const e = byIp.get(f[7]) ?? { services: new Set<string>() }
    if (f[6] && !e.host) e.host = f[6].replace(/\.local$/, '')
    if (f[4]) e.services.add(f[4])
    byIp.set(f[7], e)
  }
  return byIp
}

/** Ping output: "64 bytes from 192.168.1.1: icmp_seq=1 ttl=64 time=0.42 ms". */
export function parsePingTime(out: string): number | undefined {
  const t = /time[=<]([\d.]+) ?ms/.exec(out)?.[1]
  return t ? Number(t) : undefined
}

/** OUI lists: IEEE/hwdata ("28-6F-B9   (hex)\t\tVendor") or nmap ("286FB9 Vendor"); only the wanted prefixes. */
export function parseOui(text: string, wanted: Set<string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    let m = /^([0-9A-F]{2})-([0-9A-F]{2})-([0-9A-F]{2})\s+\(hex\)\s+(.+)$/i.exec(line)
    let prefix: string | undefined
    let name: string | undefined
    if (m) {
      prefix = `${m[1]}${m[2]}${m[3]}`.toUpperCase()
      name = m[4]
    } else if ((m = /^([0-9A-F]{6})\s+(.+)$/i.exec(line))) {
      prefix = m[1]!.toUpperCase()
      name = m[2]
    }
    if (prefix && name && wanted.has(prefix) && !out.has(prefix)) out.set(prefix, name.trim())
  }
  return out
}

export const ouiOf = (mac: string) => mac.replace(/:/g, '').slice(0, 6).toUpperCase()

/** A compact built-in list for home networks, used when the system has no OUI file. */
export const BUILTIN_OUI: Record<string, string> = Object.fromEntries(
  (
    [
      ['Raspberry Pi', 'B827EB DCA632 E45F01 D83ADD 28CDC1 2CCF67'],
      ['AVM (FRITZ!)', '3CA62F 444E6D 7CFF4D C80E14 DC396F E0286D 3810D5 989BCB 2C91AB 5C4979 74427F'],
      ['Espressif (ESP32/ESP8266)', '240AC4 246F28 30AEA4 3C71BF 84CCA8 A4CF12 BCDDC2 CC50E3 ECFABC 8CAAB5 7C9EBD 483FDA C82B96 349454 E8DB84 083AF2'],
      ['Synology', '001132 9009D0'],
      ['QNAP', '245EBE 00089B'],
      ['Ubiquiti', '245A4C 7483C2 788A20 802AA8 F09FC2 FCECDA B4FBE4 18E829 68D79A'],
      ['TP-Link', '50C7BF 98DAC4 B0BE76 C006C3 14EBB6 6032B1 3C52A1'],
      ['Sonos', '000E58 5CAAFD 949F3E 7828CA B8E937 48A6B8 542A1B'],
      ['Google', 'F4F5D8 F4F5E8 546009 1CF29A 30FD38 48D6D5 D86C63'],
      ['Amazon', 'F0272D 6854FD 74C246 84D6D0 FC65DE 40B4CD 44650D A002DC'],
      ['Signify (Philips Hue)', '001788 ECB5FA'],
      ['Apple', '3C22FB A483E7 F01898 DCA904 88665A BCD074 147DDA ACBC32 703EAC F40F24'],
      ['Brother', '008077 001BA9 30055C'],
      ['QEMU/KVM (VM)', '525400'],
      ['VMware (VM)', '000C29 005056'],
      ['VirtualBox (VM)', '080027'],
    ] as const
  ).flatMap(([vendor, list]) => list.split(' ').map((p) => [p, vendor])),
)

// ---------- services ----------

const SERVICES: Record<string, () => string> = {
  _ipp: () => msg(m.devices_service_printer),
  _ipps: () => msg(m.devices_service_printer),
  _printer: () => msg(m.devices_service_printer),
  '_pdl-datastream': () => msg(m.devices_service_printer),
  _scanner: () => msg(m.devices_service_scanner),
  _uscan: () => msg(m.devices_service_scanner),
  _airplay: () => 'AirPlay',
  _raop: () => 'AirPlay',
  _googlecast: () => 'Chromecast',
  '_spotify-connect': () => 'Spotify Connect',
  _sonos: () => 'Sonos',
  _hap: () => 'HomeKit',
  _matter: () => 'Matter',
  _matterc: () => 'Matter',
  _meshcop: () => 'Thread',
  _ssh: () => 'SSH',
  _sftp: () => 'SFTP',
  _smb: () => 'SMB',
  _afpovertcp: () => 'AFP',
  _nfs: () => 'NFS',
  _http: () => 'Web',
  _https: () => 'Web',
  _workstation: () => msg(m.devices_service_computer),
  '_device-info': () => '',
  '_home-assistant': () => 'Home Assistant',
  _esphomelib: () => 'ESPHome',
  _mqtt: () => 'MQTT',
  _rfb: () => 'VNC',
  _rdp: () => 'Remote Desktop',
  _adisk: () => 'Time Machine',
}

/** "_ipp._tcp" → "Drucker"; unknown types stay as they are, without the protocol. */
export function serviceLabel(type: string): string {
  const base = type.split('.')[0] ?? type
  const f = SERVICES[base]
  return f ? f() : base.replace(/^_/, '')
}

/** Readable, unique, without empty ones. */
export function serviceLabels(types: string[]): string[] {
  return [...new Set(types.map(serviceLabel).filter(Boolean))]
}

// ---------- remembering ----------

export const deviceKey = (d: Pick<SeenDevice, 'mac' | 'ip'>) => (d.mac ? d.mac : `ip:${d.ip}`)

/** Merges a scan (or the passive neighbour table) into the known devices. */
export function mergeScan(known: KnownDevice[], seen: SeenDevice[], now: number): { known: KnownDevice[]; added: KnownDevice[] } {
  const byKey = new Map(known.map((k) => [k.key, { ...k }]))
  const added: KnownDevice[] = []
  for (const s of seen) {
    const key = deviceKey(s)
    const k = byKey.get(key)
    if (k) {
      k.ip = s.ip
      k.lastSeen = now
      if (s.name) k.name = s.name
      if (s.vendor) k.vendor = s.vendor
      if (s.mac) k.mac = s.mac
      if (s.services.length) k.services = [...new Set([...k.services, ...s.services])]
    } else {
      // The same device seen before without a MAC (only by IP): take it over.
      const old = s.mac ? byKey.get(`ip:${s.ip}`) : undefined
      if (old) byKey.delete(old.key)
      const d: KnownDevice = {
        ...(old ?? {}),
        key,
        ip: s.ip,
        ...(s.mac ? { mac: s.mac } : {}),
        ...(s.name ? { name: s.name } : {}),
        ...(s.vendor ? { vendor: s.vendor } : {}),
        services: [...new Set([...(old?.services ?? []), ...s.services])],
        firstSeen: old?.firstSeen ?? now,
        lastSeen: now,
      }
      byKey.set(key, d)
      if (!old) added.push(d)
    }
  }
  return { known: [...byKey.values()], added }
}

/** Online: seen in the last scan or the neighbour table within the last 10 minutes. */
export function deviceViews(known: KnownDevice[], lastScan: ScanResult | undefined, selfIps: string[], now: number): DeviceView[] {
  const rtt = new Map((lastScan?.devices ?? []).map((d) => [deviceKey(d), d.rtt]))
  return known
    .map((k) => ({
      ...k,
      online: now - k.lastSeen < 10 * 60_000,
      ...(rtt.get(k.key) !== undefined ? { rtt: rtt.get(k.key) } : {}),
      randomMac: isRandomMac(k.mac),
      ...(selfIps.includes(k.ip) ? { self: true } : {}),
    }))
    .sort((a, b) => ipNum(a.ip) - ipNum(b.ip))
}

/** Forget devices not seen for this long (random phone MACs pile up otherwise), unless named or marked known. */
export const FORGET_AFTER_DAYS = 90
export function forgetOld(known: KnownDevice[], now: number): KnownDevice[] {
  return known.filter((k) => k.label || k.known || now - k.lastSeen < FORGET_AFTER_DAYS * 86_400_000)
}

/** The magic packet: 6 × 0xFF, then the MAC 16 times. */
export function magicPacket(mac: string): Uint8Array {
  if (!MAC.test(mac)) throw new Error(msg(m.devices_error_mac))
  const bytes = mac.split(':').map((h) => parseInt(h, 16))
  const out = new Uint8Array(102)
  out.fill(0xff, 0, 6)
  for (let i = 0; i < 16; i++) out.set(bytes, 6 + i * 6)
  return out
}

/** Ports checked on request for one device. */
export const CHECK_PORTS: { port: number; name: string }[] = [
  { port: 22, name: 'SSH' },
  { port: 53, name: 'DNS' },
  { port: 80, name: 'HTTP' },
  { port: 139, name: 'NetBIOS' },
  { port: 443, name: 'HTTPS' },
  { port: 445, name: 'SMB' },
  { port: 548, name: 'AFP' },
  { port: 631, name: 'IPP' },
  { port: 1883, name: 'MQTT' },
  { port: 3389, name: 'RDP' },
  { port: 5000, name: 'Synology/UPnP' },
  { port: 5900, name: 'VNC' },
  { port: 8080, name: 'HTTP' },
  { port: 8123, name: 'Home Assistant' },
  { port: 8443, name: 'HTTPS' },
  { port: 9100, name: 'RAW print' },
  { port: 32400, name: 'Plex' },
]
