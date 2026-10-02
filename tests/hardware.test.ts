import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FixtureHardware, SystemHardware } from '~/server/hardware/collect'
import { buildHardware, gpuQuadletLine, lookupIds, parseCpu, parseDmidecode, pcieGen, pciGroup, shortGpuName, type HardwareRaw } from '~/shared/hardware'

const RAW = JSON.parse(readFileSync('fixtures/demo/hardware.json', 'utf8')) as HardwareRaw
const NOW = Date.UTC(2026, 9, 2)

describe('parsers', () => {
  it('reads memory slots and ECC from dmidecode', () => {
    const m = parseDmidecode(RAW.dmidecode!)
    expect(m.ecc).toBe(false)
    expect(m.maxCapacity).toBe(128 * 1024 ** 3)
    expect(m.slots.map((s) => [s.locator, s.size, s.type, s.speed, s.manufacturer])).toEqual([
      ['Controller0-DIMMA1', undefined, undefined, undefined, undefined],
      ['Controller0-DIMMA2', 16 * 1024 ** 3, 'DDR4', 3200, 'Kingston'],
      ['Controller1-DIMMB1', undefined, undefined, undefined, undefined],
      ['Controller1-DIMMB2', 16 * 1024 ** 3, 'DDR4', 3200, 'Kingston'],
    ])
    const ecc = parseDmidecode('Handle 0x1, DMI type 16\nPhysical Memory Array\n\tUse: System Memory\n\tError Correction Type: Multi-bit ECC\n\tMaximum Capacity: 2 TB\n')
    expect(ecc).toMatchObject({ ecc: true, maxCapacity: 2 * 1024 ** 4 })
  })

  it('reads the CPU from lscpu -J (nested) and from cpuinfo alone', () => {
    expect(parseCpu(RAW.lscpu, RAW.cpuinfo)).toEqual({ model: '12th Gen Intel(R) Core(TM) i5-12500', vendor: 'GenuineIntel', sockets: 1, cores: 6, threads: 12, maxMHz: 4600, virtualization: 'VT-x', cache: '18 MiB (1 instance)' })
    const info = 'processor\t: 0\nvendor_id\t: AuthenticAMD\nmodel name\t: AMD Ryzen 5 5600G\nphysical id\t: 0\ncpu cores\t: 6\nflags\t\t: fpu svm\n\nprocessor\t: 1\nphysical id\t: 0\n'
    expect(parseCpu(undefined, info)).toMatchObject({ model: 'AMD Ryzen 5 5600G', cores: 6, threads: 2, virtualization: 'AMD-V' })
  })

  it('looks names up in pci.ids', () => {
    const ids = `# comment\n8086  Intel Corporation\n\t125c  Ethernet Controller I226-V\n\t\t8086 0000  Subsystem\n144d  Samsung Electronics Co Ltd\n\ta80a  NVMe SSD Controller PM9A1/PM9A3/980PRO\nC 01  Mass storage controller\n\t08  Non-Volatile memory controller\nC 02  Network controller\n`
    const r = lookupIds(ids, [{ vendor: '8086', device: '125c' }, { vendor: '144d', device: 'a80a' }], ['0108', '02'])
    expect(r.vendors.get('8086')).toBe('Intel Corporation')
    expect(r.devices.get('8086:125c')).toBe('Ethernet Controller I226-V')
    expect(r.devices.get('144d:a80a')).toBe('NVMe SSD Controller PM9A1/PM9A3/980PRO')
    expect(r.classes.get('0108')).toBe('Non-Volatile memory controller')
    expect(r.classes.get('02')).toBe('Network controller')
  })

  it('knows PCIe generations, groups and GPU names', () => {
    expect([pcieGen('2.5 GT/s PCIe'), pcieGen('8.0 GT/s PCIe'), pcieGen('16.0 GT/s PCIe'), pcieGen('Unknown')]).toEqual([1, 3, 4, undefined])
    expect([pciGroup('0x010802'), pciGroup('0x010601'), pciGroup('0x020000'), pciGroup('0x030000'), pciGroup('0x0c0330')]).toEqual(['NVMe', 'Speicher-Controller', 'Netzwerk', 'Grafik', 'USB-Controller'])
    expect(shortGpuName('Intel Corporation DG2 [Arc A380]')).toBe('Arc A380')
    expect(shortGpuName('NVIDIA GeForce RTX 3060')).toBe('GeForce RTX 3060')
    expect(gpuQuadletLine(['/dev/dri/card1', '/dev/dri/renderD129'])).toBe('AddDevice=/dev/dri/renderD129')
    expect(gpuQuadletLine([])).toBeUndefined()
  })
})

describe('the spec sheet', () => {
  it('builds the demo machine with its warnings', () => {
    const h = buildHardware(RAW, NOW)
    expect(h.system).toMatchObject({ vendor: 'ASRock', product: undefined, board: 'ASRock B660M Pro RS', chassis: 'Desktop', bios: { version: '14.03', date: '24.08.2022', year: 2022 } })
    expect(h.memory).toMatchObject({ total: 32 * 1024 ** 3, ecc: false, eccSource: 'dmi' })
    expect(h.gpus.map((g) => [g.name, g.nodes])).toEqual([
      ['Intel AlderLake-S GT1 [UHD Graphics 770]', ['/dev/dri/card0', '/dev/dri/renderD128']],
      ['Intel DG2 [Arc A380]', ['/dev/dri/card1', '/dev/dri/renderD129']],
    ])
    expect(h.usb.map((u) => u.name)).toEqual(['Sonoff Zigbee 3.0 USB Dongle Plus', 'Back-UPS ES 700G FW:871.O3 .I USB FW:O3', 'Ultra Fit']) // the hub is left out
    expect(h.pci.find((p) => p.address === '0000:04:00.0')!.downgraded).toBe('läuft mit x1 statt x2')
    expect(h.pci.find((p) => p.group === 'Grafik' && p.linkWidth)!.downgraded).toBeUndefined() // GPUs slow their link down when idle
    expect(h.sata.find((a) => a.disk === 'sdc')!.slow).toBe(true)
    expect(h.warnings.map((w) => w.text)).toEqual([expect.stringMatching(/^ASM1166 .*x1 statt x2/), expect.stringMatching(/^sdc .*3.0 Gbps statt 6.0 Gbps/), expect.stringMatching(/BIOS ist von 2022/)])
  })

  it('warns about a hot sensor and a slow NVMe; tells a VM apart', () => {
    const raw: HardwareRaw = {
      ...RAW,
      virt: 'kvm',
      pci: [{ address: '0000:01:00.0', class: '0x010802', vendor: '144d', device: 'a80a', linkSpeed: '8.0 GT/s PCIe', linkWidth: 4, maxLinkSpeed: '16.0 GT/s PCIe', maxLinkWidth: 4, names: ['nvme0'] }],
      ata: [],
      sensors: [{ chip: 'coretemp', label: 'Package id 0', kind: 'temp', value: 97, crit: 100 }],
      dmi: { bios_date: '01/01/2025' },
    }
    const w = buildHardware(raw, NOW).warnings.map((x) => x.text)
    expect(w).toEqual([expect.stringMatching(/^nvme0 läuft mit PCIe 3.0 statt 4.0/), expect.stringMatching(/97 °C – nahe am kritischen Wert/), expect.stringMatching(/virtuellen Maschine \(kvm\)/)])
    expect(buildHardware(raw, NOW).pci[0]!.vendorName).toBe('Samsung') // built-in name without pci.ids
  })

  it('reads this machine from sysfs without failing', async () => {
    const h = await new SystemHardware().hardware()
    expect(h.cpu.threads).toBeGreaterThan(0)
    expect(h.memory.total).toBeGreaterThan(0)
    expect(Array.isArray(h.pci)).toBe(true)
  })

  it('demo sensors move but stay plausible', async () => {
    const h = await new FixtureHardware('fixtures/demo').hardware()
    const pkg = h.sensors.find((s) => s.label === 'Package id 0')!
    expect(pkg.value).toBeGreaterThan(45)
    expect(pkg.value).toBeLessThan(51)
  })
})
