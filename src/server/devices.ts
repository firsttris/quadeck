// What Quadeck remembers about the devices in the LAN (settings, no root): first/last seen, the
// admin's names and notes. The root helper scans; port checks and Wake-on-LAN run here.

import { createSocket } from 'node:dgram'
import { connect } from 'node:net'
import { CHECK_PORTS, MAC, deviceViews, forgetOld, inSubnets, magicPacket, mergeScan, type DeviceView, type KnownDevice, type ScanResult } from '~/shared/devices'
import { msg } from '~/shared/i18n'
import { HttpError } from './auth'
import { getSetting, setSetting } from './settings'

const KNOWN = 'devices.known'
const LAST = 'devices.scan'
const SINCE = 'devices.since'
const SETTINGS = 'devices.settings'

/** Active sweep: off or every n minutes (passive reading runs every 5 min regardless). */
export const SWEEP_MINUTES = [0, 15, 30, 60, 360] as const
export type SweepMinutes = (typeof SWEEP_MINUTES)[number]
export interface DeviceSettings {
  sweepMinutes: SweepMinutes
}
export const defaultDeviceSettings = (): DeviceSettings => ({
  sweepMinutes: 30,
})

export function deviceSettings(): DeviceSettings {
  const s = getSetting<Partial<DeviceSettings>>(SETTINGS) ?? {}
  return {
    sweepMinutes: SWEEP_MINUTES.includes(s.sweepMinutes as SweepMinutes) ? (s.sweepMinutes as SweepMinutes) : 30,
  }
}
export function setDeviceSettings(v: unknown): DeviceSettings {
  const n = Number((v as { sweepMinutes?: unknown })?.sweepMinutes)
  if (!SWEEP_MINUTES.includes(n as SweepMinutes)) throw new HttpError(400, msg('devices_error_interval'))
  setSetting(SETTINGS, { sweepMinutes: n })
  return deviceSettings()
}

export const knownDevices = () => getSetting<KnownDevice[]>(KNOWN) ?? []
export const lastScan = () => getSetting<ScanResult>(LAST)
/** Devices first seen before this (the very first scan) are not "new". */
export const devicesSince = () => getSetting<number>(SINCE)

/** Takes a scan into the store; returns the devices seen for the first time. */
export function recordScan(r: ScanResult, now = Date.now()): KnownDevice[] {
  const before = knownDevices()
  if (devicesSince() === undefined) setSetting(SINCE, now)
  const { known, added } = mergeScan(before, r.devices, now)
  setSetting(KNOWN, forgetOld(known, now))
  // The last result keeps the round trips and the hints; a passive one only refreshes the time.
  const last = lastScan()
  setSetting(
    LAST,
    r.active || !last
      ? r
      : {
          ...last,
          devices: r.devices.map((d) => ({
            ...d,
            rtt: last.devices.find((x) => x.ip === d.ip)?.rtt,
          })),
          selfIps: r.selfIps,
          subnets: r.subnets,
          at: r.at,
        },
  )
  return added
}

/** The next active sweep is due (never ran, or older than the interval). */
export function sweepDue(now = Date.now()): boolean {
  const { sweepMinutes } = deviceSettings()
  if (!sweepMinutes) return false
  const last = getSetting<number>('devices.sweptAt')
  return !last || now - last >= sweepMinutes * 60_000
}
export const markSwept = (now = Date.now()) => setSetting('devices.sweptAt', now)

export function devicesView(now = Date.now()): {
  devices: DeviceView[]
  scan?: ScanResult
  settings: DeviceSettings
  sweptAt?: number
  since?: number
} {
  const scan = lastScan()
  return {
    devices: deviceViews(knownDevices(), scan, scan?.selfIps ?? [], now),
    scan,
    settings: deviceSettings(),
    sweptAt: getSetting<number>('devices.sweptAt'),
    since: devicesSince(),
  }
}

/** Unknown devices that turned up after the first scan: for the opt-in notification. */
export function freshDevices(): {
  key: string
  ip: string
  name?: string
  vendor?: string
  mac?: string
}[] {
  const since = devicesSince()
  if (since === undefined) return []
  const self = lastScan()?.selfIps ?? []
  return knownDevices()
    .filter((k) => !k.known && !k.label && k.firstSeen > since && !self.includes(k.ip))
    .map((k) => ({
      key: k.key,
      ip: k.ip,
      ...(k.name ? { name: k.name } : {}),
      ...(k.vendor ? { vendor: k.vendor } : {}),
      ...(k.mac ? { mac: k.mac } : {}),
    }))
}

const clean = (v: unknown, max: number) => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new HttpError(400, msg('devices_error_text'))
  const t = v.trim()
  if (t.length > max || /[\u0000-\u001f]/.test(t.replace(/\n/g, ''))) throw new HttpError(400, msg('devices_error_text'))
  return t || undefined
}

/** The admin's own name, note and the "known" mark. */
export function editDevice(key: string, b: { label?: unknown; note?: unknown; known?: unknown }): KnownDevice {
  const list = knownDevices()
  const d = list.find((k) => k.key === key)
  if (!d) throw new HttpError(404, msg('devices_error_unknown'))
  if ('label' in b) {
    const label = clean(b.label, 60)
    if (label) d.label = label
    else delete d.label
  }
  if ('note' in b) {
    const note = clean(b.note, 500)
    if (note) d.note = note
    else delete d.note
  }
  if ('known' in b) {
    if (b.known === true) d.known = true
    else delete d.known
  }
  setSetting(KNOWN, list)
  return d
}

export function forgetDevice(key: string) {
  const list = knownDevices()
  if (!list.some((k) => k.key === key)) throw new HttpError(404, msg('devices_error_unknown'))
  setSetting(
    KNOWN,
    list.filter((k) => k.key !== key),
  )
}

/** Only devices in the server's own subnets (no port scanning of the internet through Quadeck). */
function ownSubnet(ip: string) {
  const subnets = lastScan()?.subnets ?? []
  if (!inSubnets(ip, subnets)) throw new HttpError(400, msg('devices_error_subnet'))
}

const tcpOpen = (ip: string, port: number, timeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    const s = connect({ host: ip, port })
    const done = (ok: boolean) => {
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })

export async function checkPorts(ip: string, demo = false, timeoutMs = 800): Promise<{ port: number; name: string; open: boolean }[]> {
  ownSubnet(ip)
  if (demo) {
    const d = knownDevices().find((k) => k.ip === ip)
    const s = (d?.services ?? []).join(' ')
    const open = new Set<number>([
      ...(/_ssh/.test(s) ? [22] : []),
      ...(/_http\./.test(s) ? [80] : []),
      ...(/_ipp|_printer/.test(s) ? [631, 9100] : []),
      ...(/_smb/.test(s) ? [139, 445] : []),
      ...(/_home-assistant/.test(s) ? [8123] : []),
      ...(ip.endsWith('.1') ? [53, 80, 443] : []),
    ])
    return CHECK_PORTS.map((p) => ({ ...p, open: open.has(p.port) }))
  }
  return Promise.all(
    CHECK_PORTS.map(async (p) => ({
      ...p,
      open: await tcpOpen(ip, p.port, timeoutMs),
    })),
  )
}

/** Broadcast address of a subnet ("192.168.1.0/24" → "192.168.1.255"). */
export function broadcastOf(cidr: string): string {
  const [net, p] = cidr.split('/')
  const n = net!.split('.').reduce((a, x) => a * 256 + Number(x), 0)
  const b = (n | (2 ** (32 - Number(p)) - 1)) >>> 0
  return [24, 16, 8, 0].map((s) => (b >>> s) & 255).join('.')
}

/** Wake-on-LAN: the magic packet to UDP 9 on the broadcast of every own subnet. */
export async function wake(mac: string, demo = false, send = sendUdp): Promise<string[]> {
  const m = mac.toLowerCase()
  if (!MAC.test(m)) throw new HttpError(400, msg('devices_error_mac'))
  const packet = magicPacket(m)
  const targets = [...new Set([...(lastScan()?.subnets ?? []).map(broadcastOf), '255.255.255.255'])]
  if (!demo) for (const t of targets) await send(packet, t, 9)
  return targets
}

export function sendUdp(packet: Uint8Array, host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    const s = createSocket('udp4')
    s.once('error', (e) => {
      s.close()
      reject(e)
    })
    s.bind(() => {
      s.setBroadcast(true)
      s.send(packet, port, host, (e) => {
        s.close()
        if (e) reject(e)
        else resolve()
      })
    })
  })
}
