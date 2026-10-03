// Reads the hardware from sysfs (PCI, USB, DRM, SATA links, hwmon, DMI) and
// dmidecode for the memory slots. Runs in the root helper; everything but
// dmidecode would also work without root. lspci/lsusb are not needed – names
// come from pci.ids/usb.ids.

import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { run } from '../exec'
import { msg } from '~/shared/i18n'
import { buildHardware, lookupIds, type AtaRaw, type Hardware, type HardwareRaw, type PciRaw, type SensorRaw, type UsbRaw } from '~/shared/hardware'

export interface HardwareAdmin {
  hardware(): Promise<Hardware>
}

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8').trim()
  } catch {
    return undefined
  }
}
const ls = (p: string) => {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}
const link = (p: string) => {
  try {
    return basename(readlinkSync(p))
  } catch {
    return undefined
  }
}
const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return undefined
  }
}

const IDS = (name: string) => [`/usr/share/hwdata/${name}`, `/usr/share/misc/${name}`, `/usr/share/${name}`].find((p) => existsSync(p))

function readPci(): PciRaw[] {
  const root = '/sys/bus/pci/devices'
  const devs = ls(root).map((address) => {
    const d = join(root, address)
    const hex = (f: string) => read(join(d, f))?.replace(/^0x/, '').toLowerCase() ?? ''
    const width = (f: string) => Number(read(join(d, f))) || undefined
    return {
      address,
      class: `0x${hex('class')}`,
      vendor: hex('vendor'),
      device: hex('device'),
      driver: link(join(d, 'driver')),
      linkSpeed: read(join(d, 'current_link_speed')),
      linkWidth: width('current_link_width'),
      maxLinkSpeed: read(join(d, 'max_link_speed')),
      maxLinkWidth: width('max_link_width'),
      names: [...ls(join(d, 'nvme')), ...ls(join(d, 'net'))],
    } satisfies PciRaw
  })
  const file = IDS('pci.ids')
  if (file) {
    const ids = lookupIds(
      read(file) ?? '',
      devs.map((d) => ({ vendor: d.vendor, device: d.device })),
      devs.flatMap((d) => [d.class.slice(2, 4), d.class.slice(2, 6)]),
    )
    for (const d of devs as PciRaw[]) {
      d.vendorName = ids.vendors.get(d.vendor)
      d.deviceName = ids.devices.get(`${d.vendor}:${d.device}`)
      d.className = ids.classes.get(d.class.slice(2, 6)) ?? ids.classes.get(d.class.slice(2, 4))
    }
  }
  return devs
}

function readUsb(): UsbRaw[] {
  const root = '/sys/bus/usb/devices'
  // /dev/serial/by-id/… → the USB device behind the tty.
  const serial = new Map<string, string[]>()
  for (const id of ls('/dev/serial/by-id')) {
    const tty = link(join('/dev/serial/by-id', id))
    const dev = tty && real(`/sys/class/tty/${tty}/device`)
    const usb = dev
      ?.split('/')
      .filter((s) => /^\d+-[\d.]+$/.test(s))
      .pop()
    if (usb) serial.set(usb, [...(serial.get(usb) ?? []), `/dev/serial/by-id/${id}`])
  }
  const devs: UsbRaw[] = ls(root)
    .filter((n) => /^\d+-[\d.]+$/.test(n))
    .map((path) => {
      const d = join(root, path)
      const iface = ls(d).find((n) => n.startsWith(`${path}:`))
      return {
        path,
        vendor: read(join(d, 'idVendor')) ?? '',
        product: read(join(d, 'idProduct')) ?? '',
        manufacturer: read(join(d, 'manufacturer')),
        name: read(join(d, 'product')),
        speed: Number(read(join(d, 'speed'))) || undefined,
        driver: iface ? link(join(d, iface, 'driver')) : undefined,
        serial: serial.get(path) ?? [],
        hub: read(join(d, 'bDeviceClass')) === '09',
      }
    })
  const file = IDS('usb.ids')
  if (file && devs.some((d) => !d.name || !d.manufacturer)) {
    const ids = lookupIds(
      read(file) ?? '',
      devs.map((d) => ({ vendor: d.vendor, device: d.product })),
    )
    for (const d of devs) {
      d.manufacturer ??= ids.vendors.get(d.vendor)
      d.name ??= ids.devices.get(`${d.vendor}:${d.product}`)
    }
  }
  return devs
}

function readDrm(): HardwareRaw['drm'] {
  return ls('/sys/class/drm')
    .filter((n) => /^(card\d+|renderD\d+)$/.test(n))
    .map((n) => ({ node: `/dev/dri/${n}`, pci: basename(real(`/sys/class/drm/${n}/device`) ?? '') }))
    .filter((d) => /^[0-9a-f]{4}:/.test(d.pci))
}

function readAta(): AtaRaw[] {
  const disks = new Map<string, { disk: string; model?: string }>()
  for (const b of ls('/sys/block')) {
    const port = real(`/sys/block/${b}`)?.match(/\/ata(\d+)\//)?.[1]
    if (port) disks.set(port, { disk: b, model: read(`/sys/block/${b}/device/model`) })
  }
  return ls('/sys/class/ata_link')
    .filter((l) => /^link\d+$/.test(l))
    .map((l) => {
      const d = `/sys/class/ata_link/${l}`
      const spd = read(join(d, 'sata_spd'))
      const limit = read(join(d, 'hw_sata_spd_limit'))
      const disk = disks.get(l.slice(4))
      return { link: l.replace('link', 'ata'), disk: disk?.disk, model: disk?.model, speed: spd && spd !== '<unknown>' ? spd : undefined, limit: limit && limit !== '<unknown>' ? limit : undefined }
    })
    .filter((a) => a.disk || a.speed)
}

export function readHwmon(root = '/sys/class/hwmon'): SensorRaw[] {
  const out: SensorRaw[] = []
  for (const h of ls(root)) {
    const d = join(root, h)
    const chip = read(join(d, 'name')) ?? h
    for (const f of ls(d)) {
      const m = f.match(/^(temp|fan|in|power)(\d+)_(input|average)$/)
      if (!m) continue
      const kind = m[1] as SensorRaw['kind']
      const raw = Number(read(join(d, f)))
      if (!Number.isFinite(raw)) continue
      const label = read(join(d, `${m[1]}${m[2]}_label`))
      if (kind === 'in' && !label) continue // unlabeled voltages are just noise
      const scale = kind === 'temp' || kind === 'in' ? 1000 : kind === 'power' ? 1e6 : 1
      const extra = (s: string) => {
        const v = Number(read(join(d, `${m[1]}${m[2]}_${s}`)))
        return Number.isFinite(v) && v > 0 ? v / scale : undefined
      }
      if (kind === 'temp' && (raw <= -40_000 || raw >= 150_000)) continue // unconnected sensor
      out.push({
        chip,
        label: label ?? (kind === 'fan' ? msg('hardware_sensor_fan', { index: m[2] }) : kind === 'temp' ? msg('hardware_sensor_temperature', { index: m[2] }) : `${kind} ${m[2]}`),
        kind,
        value: raw / scale,
        max: extra('max'),
        crit: extra('crit'),
      })
    }
  }
  return out.sort((a, b) => a.chip.localeCompare(b.chip) || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label, undefined, { numeric: true }))
}

export class SystemHardware implements HardwareAdmin {
  private cache?: { at: number; raw: Omit<HardwareRaw, 'sensors'> }

  private async collect(): Promise<Omit<HardwareRaw, 'sensors'>> {
    const dmiKeys = ['sys_vendor', 'product_name', 'product_version', 'board_vendor', 'board_name', 'bios_vendor', 'bios_version', 'bios_date', 'chassis_type'] as const
    const [lscpu, virt, dmidecode] = await Promise.all([
      Bun.which('lscpu') ? run(['lscpu', '-J']).then((r) => (r.code === 0 ? r.stdout : undefined)) : undefined,
      Bun.which('systemd-detect-virt') ? run(['systemd-detect-virt']).then((r) => r.stdout.trim() || undefined) : undefined,
      Bun.which('dmidecode') ? run(['dmidecode', '-t', '16', '-t', '17'], { timeoutMs: 15_000 }).then((r) => (r.code === 0 ? r.stdout : undefined)) : undefined,
    ])
    return {
      dmi: Object.fromEntries(dmiKeys.map((k) => [k, read(`/sys/class/dmi/id/${k}`)]).filter(([, v]) => v)),
      virt,
      lscpu,
      cpuinfo: read('/proc/cpuinfo') ?? '',
      meminfo: read('/proc/meminfo') ?? '',
      dmidecode,
      edac: existsSync('/sys/devices/system/edac/mc/mc0'),
      pci: readPci(),
      usb: readUsb(),
      drm: readDrm(),
      ata: readAta(),
    }
  }

  async hardware(): Promise<Hardware> {
    // The devices rarely change; the sensors are read every time.
    if (!this.cache || Date.now() - this.cache.at > 5 * 60_000) this.cache = { at: Date.now(), raw: await this.collect() }
    return buildHardware({ ...this.cache.raw, sensors: readHwmon() })
  }
}

export class FixtureHardware implements HardwareAdmin {
  constructor(private dir: string) {}

  async hardware(): Promise<Hardware> {
    const raw = JSON.parse(read(join(this.dir, 'hardware.json')) ?? '{}') as HardwareRaw
    // Sensors move a little, like on a real machine.
    const t = Date.now() / 60_000
    raw.sensors = raw.sensors.map((s, i) => (s.kind === 'temp' ? { ...s, value: Math.round((s.value + Math.sin(t + i) * 1.5) * 10) / 10 } : s.kind === 'fan' && s.value ? { ...s, value: Math.round(s.value + Math.sin(t + i) * 30) } : s))
    return buildHardware(raw)
  }
}
