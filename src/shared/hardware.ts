// Hardware of the host as a spec sheet: system and BIOS, CPU, memory slots,
// GPUs with their device nodes, PCIe link widths, USB devices with stable
// paths, SATA link speeds and sensors – plus the warnings worth acting on.
// buildHardware() is pure: the root helper reads sysfs into HardwareRaw.

export interface PciRaw {
  address: string
  /** 0x010802 */
  class: string
  className?: string
  vendor: string
  device: string
  vendorName?: string
  deviceName?: string
  driver?: string
  /** "16.0 GT/s PCIe", "8.0 GT/s PCIe" … as in sysfs. */
  linkSpeed?: string
  linkWidth?: number
  maxLinkSpeed?: string
  maxLinkWidth?: number
  /** nvme0, enp3s0 … what the kernel made of it. */
  names?: string[]
}

export interface UsbRaw {
  /** 1-4.2 */
  path: string
  vendor: string
  product: string
  manufacturer?: string
  name?: string
  /** Mbit/s */
  speed?: number
  driver?: string
  /** /dev/serial/by-id/… pointing to this device. */
  serial: string[]
  /** Hubs are not listed. */
  hub?: boolean
}

export interface AtaRaw {
  link: string
  disk?: string
  model?: string
  /** "6.0 Gbps" */
  speed?: string
  /** What the port/disk could do. */
  limit?: string
}

export interface SensorRaw {
  chip: string
  label: string
  kind: 'temp' | 'fan' | 'in' | 'power'
  /** °C, rpm, V, W */
  value: number
  max?: number
  crit?: number
}

export interface HardwareRaw {
  dmi: Partial<Record<'sys_vendor' | 'product_name' | 'product_version' | 'board_vendor' | 'board_name' | 'bios_vendor' | 'bios_version' | 'bios_date' | 'chassis_type', string>>
  virt?: string
  lscpu?: string
  cpuinfo: string
  meminfo: string
  dmidecode?: string
  edac: boolean
  pci: PciRaw[]
  usb: UsbRaw[]
  /** /dev/dri nodes → PCI address. */
  drm: { node: string; pci: string }[]
  ata: AtaRaw[]
  sensors: SensorRaw[]
}

export interface MemorySlot {
  locator: string
  size?: number
  type?: string
  speed?: number
  configuredSpeed?: number
  manufacturer?: string
  part?: string
}

export interface Hardware {
  system: { vendor?: string; product?: string; board?: string; bios?: { vendor?: string; version?: string; date?: string; year?: number }; chassis?: string; virt?: string }
  cpu: { model: string; vendor?: string; sockets: number; cores: number; threads: number; maxMHz?: number; virtualization?: string; cache?: string }
  memory: { total: number; ecc?: boolean; eccSource?: 'dmi' | 'edac'; maxCapacity?: number; slots: MemorySlot[] }
  gpus: { pci: string; name: string; driver?: string; nodes: string[] }[]
  pci: (PciRaw & { group: string; downgraded?: string })[]
  usb: UsbRaw[]
  sata: (AtaRaw & { slow?: boolean })[]
  sensors: SensorRaw[]
  warnings: { level: 'warning' | 'info'; text: string }[]
}

// ---------- parsers ----------

/** pci.ids / usb.ids: only the ids asked for are kept. */
export function lookupIds(text: string, want: { vendor: string; device?: string }[], classes?: string[]): { vendors: Map<string, string>; devices: Map<string, string>; classes: Map<string, string> } {
  const vendors = new Map<string, string>()
  const devices = new Map<string, string>()
  const classNames = new Map<string, string>()
  const wantV = new Set(want.map((w) => w.vendor.toLowerCase()))
  const wantD = new Set(want.filter((w) => w.device).map((w) => `${w.vendor}:${w.device}`.toLowerCase()))
  const wantC = new Set((classes ?? []).map((c) => c.toLowerCase()))
  let vendor: string | undefined
  let cls: string | undefined
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('C ')) {
      const m = line.match(/^C ([0-9a-f]{2})\s+(.*)$/i)
      cls = m?.[1]?.toLowerCase()
      vendor = undefined
      if (m && wantC.has(cls!)) classNames.set(cls!, m[2]!)
      continue
    }
    if (!line.startsWith('\t')) {
      const m = line.match(/^([0-9a-f]{4})\s+(.*)$/i)
      vendor = m?.[1]?.toLowerCase()
      cls = undefined
      if (m && wantV.has(vendor!)) vendors.set(vendor!, m[2]!)
      continue
    }
    if (line.startsWith('\t\t')) continue
    const m = line.match(/^\t([0-9a-f]{2,4})\s+(.*)$/i)
    if (!m) continue
    if (vendor && wantD.has(`${vendor}:${m[1]!.toLowerCase()}`)) devices.set(`${vendor}:${m[1]!.toLowerCase()}`, m[2]!)
    if (cls && wantC.has(`${cls}${m[1]!.toLowerCase()}`)) classNames.set(`${cls}${m[1]!.toLowerCase()}`, m[2]!)
  }
  return { vendors, devices, classes: classNames }
}

const bytesOf = (v: string | undefined): number | undefined => {
  const m = v?.match(/^([\d.]+)\s*(kB|KB|MB|GB|TB)\b/)
  if (!m) return undefined
  const mult = { kB: 1024, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2] as 'kB']
  return Math.round(Number(m[1]) * mult)
}

/** `dmidecode -t 16 -t 17`: slots and ECC. */
export function parseDmidecode(text: string): { slots: MemorySlot[]; ecc?: boolean; maxCapacity?: number } {
  const blocks = text.split(/\n(?=Handle 0x)/)
  const slots: MemorySlot[] = []
  let ecc: boolean | undefined
  let maxCapacity: number | undefined
  for (const b of blocks) {
    const f = (k: string) => b.match(new RegExp(`^\\s+${k}:\\s*(.+)$`, 'm'))?.[1]?.trim()
    if (/\nPhysical Memory Array/.test(b) && f('Use') !== 'Flash Memory') {
      const e = f('Error Correction Type')
      if (e) ecc = !/^(None|Unknown)$/.test(e)
      maxCapacity = bytesOf(f('Maximum Capacity')) ?? maxCapacity
    }
    if (/\nMemory Device/.test(b)) {
      const size = f('Size')
      const installed = size && !/No Module Installed|Not Installed|^0\b/.test(size)
      const clean = (v?: string) => (v && !/^(Unknown|Not Specified|NO DIMM|None|Undefined|0000|\s*)$/i.test(v) ? v : undefined)
      const mts = (v?: string) => (v && /^\d+/.test(v) ? Number(v.match(/^\d+/)![0]) : undefined)
      slots.push({
        locator: f('Locator') ?? f('Bank Locator') ?? `Steckplatz ${slots.length + 1}`,
        size: installed ? bytesOf(size) : undefined,
        type: installed ? clean(f('Type')) : undefined,
        speed: installed ? mts(f('Speed')) : undefined,
        configuredSpeed: installed ? mts(f('Configured Memory Speed') ?? f('Configured Clock Speed')) : undefined,
        manufacturer: installed ? clean(f('Manufacturer')) : undefined,
        part: installed ? clean(f('Part Number')) : undefined,
      })
    }
  }
  return { slots, ecc, maxCapacity }
}

/** lscpu -J or /proc/cpuinfo. */
export function parseCpu(lscpu: string | undefined, cpuinfo: string): Hardware['cpu'] {
  const fields = new Map<string, string>()
  try {
    const walk = (list: { field: string; data: string; children?: unknown[] }[]) => {
      for (const e of list) {
        fields.set(e.field.replace(/:$/, ''), e.data)
        if (Array.isArray(e.children)) walk(e.children as { field: string; data: string }[])
      }
    }
    if (lscpu) walk((JSON.parse(lscpu) as { lscpu: { field: string; data: string }[] }).lscpu)
  } catch {
    // fall back to cpuinfo
  }
  const info = (k: string) => cpuinfo.match(new RegExp(`^${k}\\s*:\\s*(.+)$`, 'm'))?.[1]?.trim()
  const threads = Number(fields.get('CPU(s)')) || cpuinfo.split('\n').filter((l) => l.startsWith('processor')).length || 1
  const perCore = Number(fields.get('Thread(s) per core')) || 1
  const sockets = Number(fields.get('Socket(s)')) || new Set(cpuinfo.match(/^physical id\s*:\s*\d+/gm) ?? ['0']).size
  const coresPerSocket = Number(fields.get('Core(s) per socket')) || Number(info('cpu cores')) || Math.max(1, threads / perCore / sockets)
  const flags = info('flags') ?? fields.get('Flags') ?? ''
  const virt = fields.get('Virtualization') ?? (/\bvmx\b/.test(flags) ? 'VT-x' : /\bsvm\b/.test(flags) ? 'AMD-V' : undefined)
  const max = Number(fields.get('CPU max MHz'))
  return {
    model: (fields.get('Model name') ?? info('model name') ?? info('Model') ?? 'unbekannt').replace(/\s+/g, ' '),
    vendor: fields.get('Vendor ID') ?? info('vendor_id'),
    sockets,
    cores: coresPerSocket * sockets,
    threads,
    maxMHz: Number.isFinite(max) && max > 0 ? Math.round(max) : undefined,
    virtualization: virt,
    cache: fields.get('L3') ?? fields.get('L3 cache'),
  }
}

/** "16.0 GT/s PCIe" → PCIe generation. */
export function pcieGen(speed: string | undefined): number | undefined {
  const gt = Number(speed?.match(/^([\d.]+)\s*GT\/s/)?.[1])
  if (!gt) return undefined
  return gt >= 64 ? 6 : gt >= 32 ? 5 : gt >= 16 ? 4 : gt >= 8 ? 3 : gt >= 5 ? 2 : 1
}

const gbps = (s?: string) => Number(s?.match(/^([\d.]+)\s*Gbps/)?.[1]) || undefined

export const CHASSIS: Record<string, string> = { '3': 'Desktop', '4': 'Desktop (flach)', '6': 'Mini-Tower', '7': 'Tower', '8': 'Laptop', '9': 'Laptop', '10': 'Notebook', '13': 'All-in-One', '17': 'Rack-Server', '23': 'Rack', '24': 'Tower', '30': 'Tablet', '31': 'Convertible', '35': 'Mini-PC', '36': 'Stick-PC' }

/** PCI class → group on the page. */
export function pciGroup(cls: string): string {
  const c = cls.replace(/^0x/, '').slice(0, 2)
  const sub = cls.replace(/^0x/, '').slice(0, 4)
  if (sub === '0108') return 'NVMe'
  if (c === '01') return 'Speicher-Controller'
  if (c === '02') return 'Netzwerk'
  if (c === '03') return 'Grafik'
  if (c === '04') return 'Audio und Video'
  if (sub === '0c03') return 'USB-Controller'
  if (c === '06') return 'Brücken'
  return 'Sonstige'
}

/** Without pci.ids: the vendors a home server usually has. */
export const PCI_VENDORS: Record<string, string> = {
  '8086': 'Intel',
  '1022': 'AMD',
  '1002': 'AMD/ATI',
  '10de': 'NVIDIA',
  '144d': 'Samsung',
  '1b21': 'ASMedia',
  '10ec': 'Realtek',
  '1987': 'Phison',
  '15b7': 'Western Digital',
  '1c5c': 'SK hynix',
  '126f': 'Silicon Motion',
  'c0a9': 'Micron/Crucial',
  '1cc1': 'ADATA',
  '1e0f': 'KIOXIA',
  '1b4b': 'Marvell',
  '1000': 'Broadcom/LSI',
  '14e4': 'Broadcom',
  '15b3': 'Mellanox',
  '1af4': 'Red Hat (virtio)',
  '1b36': 'Red Hat (QEMU)',
  '1234': 'QEMU',
  '15ad': 'VMware',
  '80ee': 'VirtualBox',
}

const JUNK_DMI = /^(To Be Filled By O\.E\.M\.|To be filled by O\.E\.M\.|Default string|System Product Name|System manufacturer|O\.E\.M\.|Not Applicable|None|0123456789|\s*)$/i

export function buildHardware(raw: HardwareRaw, now = Date.now()): Hardware {
  const dmi = (k: keyof HardwareRaw['dmi']) => {
    const v = raw.dmi[k]?.trim()
    return v && !JUNK_DMI.test(v) ? v : undefined
  }
  // DMI dates are MM/DD/YYYY.
  const biosDate = dmi('bios_date')?.replace(/^(\d\d)\/(\d\d)\/(\d{4})$/, '$2.$1.$3')
  const year = Number(biosDate?.match(/(\d{4})$/)?.[1]) || undefined
  const mem = raw.dmidecode ? parseDmidecode(raw.dmidecode) : { slots: [] as MemorySlot[] }
  // Installed modules when known (the kernel reports a bit less as MemTotal).
  const installed = mem.slots.reduce((n, s) => n + (s.size ?? 0), 0)
  const total = installed || (Number(raw.meminfo.match(/^MemTotal:\s+(\d+)/m)?.[1]) || 0) * 1024
  const ecc = 'ecc' in mem && mem.ecc !== undefined ? mem.ecc : raw.edac ? true : undefined
  const pci = raw.pci
    .map((p) => {
      p = { ...p, vendorName: p.vendorName ?? PCI_VENDORS[p.vendor] }
      const group = pciGroup(p.class)
      let downgraded: string | undefined
      if ((group === 'NVMe' || group === 'Speicher-Controller' || group === 'Netzwerk') && p.linkWidth && p.maxLinkWidth && p.linkWidth < p.maxLinkWidth)
        downgraded = `läuft mit x${p.linkWidth} statt x${p.maxLinkWidth}`
      else if (group === 'NVMe' && pcieGen(p.linkSpeed) && pcieGen(p.maxLinkSpeed) && pcieGen(p.linkSpeed)! < pcieGen(p.maxLinkSpeed)!)
        downgraded = `läuft mit PCIe ${pcieGen(p.linkSpeed)}.0 statt ${pcieGen(p.maxLinkSpeed)}.0`
      return { ...p, group, downgraded }
    })
    .sort((a, b) => a.group.localeCompare(b.group) || a.address.localeCompare(b.address))
  const gpus = pci
    .filter((p) => p.group === 'Grafik')
    .map((p) => ({ pci: p.address, name: [p.vendorName?.replace(/ Corporation| Inc\.|, Inc\.| \[AMD\/ATI\]/g, ''), p.deviceName].filter(Boolean).join(' ') || `${p.vendor}:${p.device}`, driver: p.driver, nodes: raw.drm.filter((d) => d.pci === p.address).map((d) => d.node).sort() }))
  const sata = raw.ata.map((a) => ({ ...a, slow: !!(gbps(a.speed) && gbps(a.limit) && gbps(a.speed)! < gbps(a.limit)!) }))

  const warnings: Hardware['warnings'] = []
  for (const p of pci) if (p.downgraded) warnings.push({ level: 'warning', text: `${p.names?.[0] ?? p.deviceName ?? p.address} ${p.downgraded} – meist ein Steckplatz, der weniger Lanes hat oder sie mit einem anderen teilt (Handbuch des Mainboards).` })
  for (const a of sata) if (a.slow && a.disk) warnings.push({ level: 'warning', text: `${a.disk}${a.model ? ` (${a.model})` : ''} ist mit ${a.speed} statt ${a.limit} angebunden – oft Kabel oder Port; passt zu CRC-Fehlern in SMART.` })
  for (const s of raw.sensors) if (s.kind === 'temp' && s.crit && s.value >= s.crit - 5) warnings.push({ level: 'warning', text: `${s.chip} ${s.label}: ${Math.round(s.value)} °C – nahe am kritischen Wert (${s.crit} °C).` })
  if (year && new Date(now).getUTCFullYear() - year >= 4) warnings.push({ level: 'info', text: `Das BIOS ist von ${year}. Neuere Versionen beheben oft Fehler und Sicherheitslücken – auf der Seite des Mainboard-Herstellers nachsehen.` })
  if (raw.virt && raw.virt !== 'none') warnings.push({ level: 'info', text: `Läuft in einer virtuellen Maschine (${raw.virt}) – Steckplätze, Sensoren und Anbindungen zeigen dann die virtuelle Hardware.` })

  return {
    system: {
      vendor: dmi('sys_vendor') ?? dmi('board_vendor'),
      product: [dmi('product_name'), dmi('product_version')].filter(Boolean).join(' ') || undefined,
      board: [dmi('board_vendor'), dmi('board_name')].filter(Boolean).join(' ') || undefined,
      bios: dmi('bios_version') || biosDate ? { vendor: dmi('bios_vendor'), version: dmi('bios_version'), date: biosDate, year } : undefined,
      chassis: CHASSIS[raw.dmi.chassis_type?.trim() ?? ''],
      virt: raw.virt && raw.virt !== 'none' ? raw.virt : undefined,
    },
    cpu: parseCpu(raw.lscpu, raw.cpuinfo),
    memory: { total, ecc, eccSource: 'ecc' in mem && mem.ecc !== undefined ? 'dmi' : raw.edac ? 'edac' : undefined, maxCapacity: 'maxCapacity' in mem ? mem.maxCapacity : undefined, slots: mem.slots },
    gpus,
    pci,
    usb: raw.usb.filter((u) => !u.hub),
    sata,
    sensors: raw.sensors,
    warnings,
  }
}

/** "Intel AlderLake-S GT1 [UHD Graphics 770]" → "UHD Graphics 770". */
export function shortGpuName(name: string): string {
  return name.match(/\[([^\]]+)\]\s*$/)?.[1] ?? name.replace(/^(Intel|NVIDIA|AMD\/ATI|Advanced Micro Devices, Inc\.)\s+/, '')
}

/** Quadlet line for a container that should use this GPU. */
export function gpuQuadletLine(nodes: string[]): string | undefined {
  if (!nodes.length) return undefined
  const render = nodes.find((n) => n.includes('renderD'))
  return render ? `AddDevice=${render}` : 'AddDevice=/dev/dri'
}

export const SENSOR_UNIT: Record<SensorRaw['kind'], string> = { temp: '°C', fan: 'U/min', in: 'V', power: 'W' }
