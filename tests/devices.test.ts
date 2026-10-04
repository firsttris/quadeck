import { mkdtempSync, writeFileSync } from 'node:fs'
import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanLan, type ScanDeps } from '~/server/network/devices'
import { FixtureNetwork } from '~/server/network/collect'
import {
  BUILTIN_OUI,
  deviceViews,
  forgetOld,
  hostsOf,
  inSubnets,
  isPrivateV4,
  isRandomMac,
  lanSubnets,
  magicPacket,
  mergeScan,
  parseAvahi,
  parseFping,
  parseNeigh,
  parseOui,
  parsePingTime,
  serviceLabels,
  type KnownDevice,
  type ScanResult,
} from '~/shared/devices'
import type { NetInterface } from '~/shared/network'
import { currentAlerts, defaultSettings, parseSettings } from '~/shared/notify'
import type { Snapshot } from '~/shared/types'

process.env.QUADECK_DATA_DIR = mkdtempSync(join(tmpdir(), 'quadeck-dev-'))
const store = await import('~/server/devices')

const iface = (over: Partial<NetInterface>): NetInterface => ({
  name: 'eth0',
  kind: 'ethernet',
  state: 'UP',
  mtu: 1500,
  addresses: [],
  ...over,
})
const v4 = (address: string, prefix: number, scope = 'global') => ({
  family: 'inet' as const,
  address,
  prefix,
  scope,
})

describe('addresses', () => {
  it('private ranges only', () => {
    expect(['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.178.20'].every(isPrivateV4)).toBe(true)
    expect(['172.32.0.1', '8.8.8.8', '100.64.0.1', '169.254.1.1', '192.169.0.1', 'x'].some(isPrivateV4)).toBe(false)
  })
  it('sweeps only home-facing private subnets, at most /22', () => {
    const subnets = lanSubnets([
      iface({
        addresses: [v4('192.168.1.20', 24), v4('127.0.0.1', 8, 'host')],
      }),
      iface({ name: 'wlan0', kind: 'wifi', addresses: [v4('10.0.37.5', 8)] }), // a /8: only the /24 around the address
      iface({ name: 'br0', kind: 'bridge', addresses: [v4('172.20.4.1', 22)] }),
      iface({ name: 'wg0', kind: 'vpn', addresses: [v4('10.8.0.1', 24)] }),
      iface({
        name: 'podman0',
        kind: 'container',
        addresses: [v4('10.88.0.1', 16)],
      }),
      iface({ name: 'eth1', addresses: [v4('203.0.113.4', 24)] }), // public
      iface({ name: 'eth2', addresses: [v4('192.168.9.1', 32)] }),
    ])
    expect(subnets).toEqual(['192.168.1.0/24', '10.0.37.0/24', '172.20.4.0/22'])
  })
  it('host lists', () => {
    expect(hostsOf('192.168.1.0/24')).toHaveLength(254)
    expect(hostsOf('192.168.1.0/24')[0]).toBe('192.168.1.1')
    expect(hostsOf('192.168.1.0/24').at(-1)).toBe('192.168.1.254')
    expect(hostsOf('10.0.0.0/22')).toHaveLength(1022)
    expect(hostsOf('10.0.0.0/16')).toEqual([]) // never a /16 sweep
    expect(hostsOf('10.0.0.0/31')).toEqual([])
    expect(hostsOf('nope/24')).toEqual([])
    expect(inSubnets('192.168.1.77', ['192.168.1.0/24'])).toBe(true)
    expect(inSubnets('192.168.2.1', ['192.168.1.0/24'])).toBe(false)
    expect(inSubnets('8.8.8.8', [])).toBe(false)
  })
  it('random MACs', () => {
    expect(isRandomMac('5e:21:9a:c4:07:13')).toBe(true)
    expect(isRandomMac('dc:a6:32:5b:90:0a')).toBe(false)
    expect(isRandomMac('52:54:00:8e:12:a4')).toBe(false) // QEMU, a fixed prefix
    expect(isRandomMac(undefined)).toBe(false)
  })
})

describe('parsers', () => {
  it('ip neigh', () => {
    const json = JSON.stringify([
      {
        dst: '192.168.1.1',
        dev: 'eth0',
        lladdr: '3C:A6:2F:41:8A:10',
        state: ['REACHABLE'],
      },
      {
        dst: '192.168.1.5',
        dev: 'eth0',
        lladdr: 'aa:bb:cc:dd:ee:ff',
        state: ['STALE'],
      },
      { dst: '192.168.1.6', dev: 'eth0', state: ['FAILED'] },
      {
        dst: '192.168.1.7',
        dev: 'eth0',
        lladdr: 'aa:bb:cc:dd:ee:01',
        state: ['INCOMPLETE'],
      },
      {
        dst: 'fe80::1',
        dev: 'eth0',
        lladdr: 'aa:bb:cc:dd:ee:02',
        state: ['REACHABLE'],
      },
    ])
    expect(parseNeigh(json)).toEqual([
      { ip: '192.168.1.1', mac: '3c:a6:2f:41:8a:10', dev: 'eth0', fresh: true },
      {
        ip: '192.168.1.5',
        mac: 'aa:bb:cc:dd:ee:ff',
        dev: 'eth0',
        fresh: false,
      },
    ])
    expect(parseNeigh('garbage')).toEqual([])
    expect(parseNeigh('{}')).toEqual([])
  })
  it('fping and ping', () => {
    expect([...parseFping('192.168.1.1 (0.42 ms)\n192.168.1.10 (12.1 ms)\nICMP Host Unreachable from x\n\n')]).toEqual([
      ['192.168.1.1', 0.42],
      ['192.168.1.10', 12.1],
    ])
    expect(parsePingTime('64 bytes from 192.168.1.1: icmp_seq=1 ttl=64 time=0.420 ms')).toBe(0.42)
    expect(parsePingTime('100% packet loss')).toBeUndefined()
  })
  it('avahi-browse', () => {
    const out = [
      '+;eth0;IPv4;Brother HL;_ipp._tcp;local',
      '=;eth0;IPv4;Brother HL;_ipp._tcp;local;brother.local;192.168.1.40;631;"txtvers=1"',
      '=;eth0;IPv4;Brother HL;_printer._tcp;local;brother.local;192.168.1.40;515;',
      '=;eth0;IPv6;Brother HL;_ipp._tcp;local;brother.local;fe80::1;631;',
      '=;eth0;IPv4;evil;_x._tcp;local;h.local;not-an-ip;1;',
    ].join('\n')
    const m = parseAvahi(out)
    expect([...m.keys()]).toEqual(['192.168.1.40'])
    expect(m.get('192.168.1.40')).toEqual({
      host: 'brother',
      services: new Set(['_ipp._tcp', '_printer._tcp']),
    })
  })
  it('OUI files of both formats', () => {
    const ieee = '28-6F-B9   (hex)\t\tNokia Shanghai Bell Co., Ltd.\n286FB9     (base 16)\t\tNokia\nDC-A6-32   (hex)\t\tRaspberry Pi Trading Ltd\n'
    expect([...parseOui(ieee, new Set(['DCA632', 'FFFFFF']))]).toEqual([['DCA632', 'Raspberry Pi Trading Ltd']])
    expect([...parseOui('DCA632 Raspberry Pi Trading\n3CA62F AVM GmbH\n', new Set(['3CA62F']))]).toEqual([['3CA62F', 'AVM GmbH']])
    expect(BUILTIN_OUI.DCA632).toBe('Raspberry Pi')
  })
  it('service names', () => {
    // printers announce several types: one label; device-info is no service
    expect(serviceLabels(['_ipp._tcp', '_printer._tcp', '_ssh._tcp', '_device-info._tcp', '_weird._udp'])).toEqual(['Drucker', 'SSH', 'weird'])
  })
})

describe('remembering', () => {
  const t0 = 1_700_000_000_000
  it('merges by MAC, takes over IP-only entries, keeps names', () => {
    let { known, added } = mergeScan(
      [],
      [
        { ip: '192.168.1.5', services: [] },
        {
          ip: '192.168.1.6',
          mac: 'aa:bb:cc:dd:ee:06',
          name: 'tv',
          services: ['_googlecast._tcp'],
        },
      ],
      t0,
    )
    expect(added.map((a) => a.key)).toEqual(['ip:192.168.1.5', 'aa:bb:cc:dd:ee:06'])
    known = known.map((k) => (k.key === 'aa:bb:cc:dd:ee:06' ? { ...k, label: 'Fernseher' } : k))
    // later: the TV moved to .7 and the IP-only device shows its MAC
    const r = mergeScan(
      known,
      [
        { ip: '192.168.1.5', mac: 'aa:bb:cc:dd:ee:05', services: [] },
        {
          ip: '192.168.1.7',
          mac: 'aa:bb:cc:dd:ee:06',
          services: ['_airplay._tcp'],
        },
      ],
      t0 + 1000,
    )
    expect(r.added).toEqual([])
    const tv = r.known.find((k) => k.key === 'aa:bb:cc:dd:ee:06')!
    expect(tv).toMatchObject({
      ip: '192.168.1.7',
      name: 'tv',
      label: 'Fernseher',
      firstSeen: t0,
      lastSeen: t0 + 1000,
      services: ['_googlecast._tcp', '_airplay._tcp'],
    })
    const five = r.known.find((k) => k.ip === '192.168.1.5')!
    expect(five).toMatchObject({ key: 'aa:bb:cc:dd:ee:05', firstSeen: t0 })
    expect(r.known.some((k) => k.key === 'ip:192.168.1.5')).toBe(false)
  })
  it('views: online for 10 min, sorted by IP, self marked', () => {
    const k = (ip: string, lastSeen: number): KnownDevice => ({
      key: `ip:${ip}`,
      ip,
      services: [],
      firstSeen: t0,
      lastSeen,
    })
    const v = deviceViews(
      [k('192.168.1.100', t0), k('192.168.1.9', t0 - 11 * 60_000), k('192.168.1.20', t0)],
      {
        at: t0,
        subnets: [],
        devices: [{ ip: '192.168.1.100', services: [], rtt: 3 }],
        missing: [],
        selfIps: [],
        active: true,
      },
      ['192.168.1.20'],
      t0,
    )
    expect(v.map((d) => [d.ip, d.online, d.rtt, d.self])).toEqual([
      ['192.168.1.9', false, undefined, undefined],
      ['192.168.1.20', true, undefined, true],
      ['192.168.1.100', true, 3, undefined],
    ])
  })
  it('forgets old unnamed devices only', () => {
    const old = t0 - 91 * 86_400_000
    const list: KnownDevice[] = [
      { key: 'a', ip: '1', services: [], firstSeen: old, lastSeen: old },
      {
        key: 'b',
        ip: '2',
        services: [],
        firstSeen: old,
        lastSeen: old,
        label: 'NAS',
      },
      {
        key: 'c',
        ip: '3',
        services: [],
        firstSeen: old,
        lastSeen: old,
        known: true,
      },
      { key: 'd', ip: '4', services: [], firstSeen: old, lastSeen: t0 },
    ]
    expect(forgetOld(list, t0).map((k) => k.key)).toEqual(['b', 'c', 'd'])
  })
  it('magic packet', () => {
    const p = magicPacket('aa:bb:cc:dd:ee:ff')
    expect(p).toHaveLength(102)
    expect([...p.slice(0, 6)]).toEqual([255, 255, 255, 255, 255, 255])
    expect([...p.slice(96)]).toEqual([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])
    expect(() => magicPacket('aa:bb:cc:dd:ee')).toThrow()
    expect(() => magicPacket('AA-BB-CC-DD-EE-FF')).toThrow()
  })
})

describe('scan', () => {
  const ifaces = [iface({ mac: 'D8:5E:D3:1A:4C:02', addresses: [v4('192.168.1.20', 24)] }), iface({ name: 'wg0', kind: 'vpn', addresses: [v4('10.8.0.1', 24)] })]
  const deps = (bins: string[], over: Partial<ScanDeps> = {}) => {
    const calls: string[][] = []
    const d: ScanDeps = {
      which: (b) => (bins.includes(b) ? `/usr/bin/${b}` : null),
      hostname: 'nas',
      ouiFiles: [],
      reverse: async (ip) => (ip === '192.168.1.1' ? 'fritz.box' : undefined),
      run: async (argv) => {
        calls.push(argv)
        if (argv[0] === 'fping')
          return {
            code: 1,
            stdout: '192.168.1.1 (0.5 ms)\n192.168.1.40 (2.0 ms)\n',
            stderr: '',
          }
        if (argv[0] === 'ping') return argv.at(-1) === '192.168.1.1' ? { code: 0, stdout: 'time=0.7 ms', stderr: '' } : { code: 1, stdout: '', stderr: '' }
        if (argv[0] === 'ip')
          return {
            code: 0,
            stdout: JSON.stringify([
              {
                dst: '192.168.1.1',
                lladdr: '3c:a6:2f:41:8a:10',
                state: ['REACHABLE'],
              },
              {
                dst: '192.168.1.40',
                lladdr: '30:05:5c:aa:71:0e',
                state: ['STALE'],
              },
              {
                dst: '192.168.1.99',
                lladdr: 'aa:aa:aa:aa:aa:99',
                state: ['STALE'],
              }, // old entry, did not answer
              {
                dst: '10.8.0.2',
                lladdr: 'aa:aa:aa:aa:aa:02',
                state: ['REACHABLE'],
              }, // VPN: not ours to list
              {
                dst: '8.8.8.8',
                lladdr: 'aa:aa:aa:aa:aa:03',
                state: ['REACHABLE'],
              },
            ]),
            stderr: '',
          }
        if (argv[0] === 'avahi-browse')
          return {
            code: 0,
            stdout: '=;eth0;IPv4;Brother;_ipp._tcp;local;brother.local;192.168.1.40;631;\n',
            stderr: '',
          }
        return { code: 127, stdout: '', stderr: '' }
      },
      ...over,
    }
    return { d, calls }
  }

  it('sweeps with fping, merges neighbours, names and vendors', async () => {
    const { d, calls } = deps(['fping', 'avahi-browse'])
    const r = await scanLan(ifaces, true, d)
    expect(calls[0]).toEqual(['fping', '-a', '-e', '-q', '-r', '1', '-t', '300', '-g', '192.168.1.0/24'])
    expect(r.subnets).toEqual(['192.168.1.0/24'])
    expect(r.missing).toEqual([])
    expect(r.selfIps).toEqual(['192.168.1.20'])
    const by = Object.fromEntries(r.devices.map((x) => [x.ip, x]))
    expect(Object.keys(by).sort()).toEqual(['192.168.1.1', '192.168.1.20', '192.168.1.40'])
    expect(by['192.168.1.1']).toMatchObject({
      mac: '3c:a6:2f:41:8a:10',
      name: 'fritz.box',
      vendor: 'AVM (FRITZ!)',
      rtt: 0.5,
    })
    expect(by['192.168.1.40']).toMatchObject({
      name: 'brother',
      vendor: 'Brother',
      services: ['_ipp._tcp'],
      rtt: 2,
    })
    expect(by['192.168.1.20']).toMatchObject({
      mac: 'd8:5e:d3:1a:4c:02',
      name: 'nas',
    })
  })

  it('falls back to ping, then to the neighbour table alone', async () => {
    const p = deps(['ping'])
    const r = await scanLan(ifaces, true, p.d)
    expect(p.calls.filter((c) => c[0] === 'ping')).toHaveLength(254)
    expect(p.calls.every((c) => c[0] !== 'ping' || inSubnets(c.at(-1)!, ['192.168.1.0/24']))).toBe(true)
    expect(r.missing).toEqual(['fping', 'avahi-browse'])
    expect(r.devices.find((x) => x.ip === '192.168.1.1')?.rtt).toBe(0.7)

    const none = deps([])
    const r2 = await scanLan(ifaces, true, none.d)
    expect(r2.missing).toContain('ping')
    expect(r2.devices.map((x) => x.ip).sort()).toEqual(['192.168.1.1', '192.168.1.20']) // REACHABLE only
  })

  it('passive: no ping at all', async () => {
    const { d, calls } = deps(['fping', 'ping'])
    const r = await scanLan(ifaces, false, d)
    expect(calls.some((c) => c[0] === 'fping' || c[0] === 'ping')).toBe(false)
    expect(r.active).toBe(false)
  })

  it('no private subnet: nothing is pinged', async () => {
    const { d, calls } = deps(['fping'])
    const r = await scanLan([iface({ addresses: [v4('203.0.113.4', 24)] })], true, d)
    expect(r.subnets).toEqual([])
    expect(r.devices).toEqual([])
    expect(calls.some((c) => c[0] === 'fping')).toBe(false)
  })

  it('reads vendors from an OUI file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qd-oui-'))
    writeFileSync(join(dir, 'oui.txt'), '3C-A6-2F   (hex)\t\tAVM Audiovisuelles Marketing und Computersysteme GmbH\n')
    const { d } = deps(['fping'], {
      ouiFiles: [join(dir, 'missing.txt'), join(dir, 'oui.txt')],
    })
    const r = await scanLan(ifaces, true, d)
    expect(r.devices.find((x) => x.ip === '192.168.1.1')?.vendor).toBe('AVM Audiovisuelles Marketing und Computersysteme GmbH')
    expect(r.devices.find((x) => x.ip === '192.168.1.40')?.vendor).toBe('Brother') // built-in list fills the gap
  })

  it('demo fixture', async () => {
    const n = new FixtureNetwork('fixtures/demo')
    const a = await n.scanDevices(true)
    const p = await n.scanDevices(false)
    expect(a.devices.length).toBeGreaterThan(10)
    expect(p.devices.length).toBeLessThan(a.devices.length)
  })
})

describe('store, ports and wake-on-LAN', () => {
  const t0 = Date.now() - 3600_000
  const scan = (devices: ScanResult['devices'], at: number, active = true): ScanResult => ({
    at,
    subnets: ['127.0.0.0/24'],
    devices,
    missing: [],
    selfIps: ['127.0.0.20'],
    active,
  })

  it('the first scan is the baseline; later devices are new until named or known', () => {
    expect(store.freshDevices()).toEqual([])
    store.recordScan(
      scan(
        [
          { ip: '127.0.0.1', mac: 'aa:00:00:00:00:01', services: [] },
          { ip: '127.0.0.20', services: [] },
        ],
        t0,
      ),
      t0,
    )
    expect(store.freshDevices()).toEqual([])
    const added = store.recordScan(
      scan(
        [
          { ip: '127.0.0.1', mac: 'aa:00:00:00:00:01', services: [] },
          {
            ip: '127.0.0.2',
            mac: 'aa:00:00:00:00:02',
            name: 'phone',
            services: [],
          },
        ],
        t0 + 1000,
      ),
      t0 + 1000,
    )
    expect(added.map((a) => a.key)).toEqual(['aa:00:00:00:00:02'])
    expect(store.freshDevices()).toEqual([
      {
        key: 'aa:00:00:00:00:02',
        ip: '127.0.0.2',
        name: 'phone',
        mac: 'aa:00:00:00:00:02',
      },
    ])

    // the notification rule, off by default
    const snap = {
      devices: { fresh: store.freshDevices() },
    } as unknown as Snapshot
    const off = parseSettings({}, defaultSettings())
    expect(off.rules['device-new']).toBe(false)
    const on = parseSettings({ rules: { 'device-new': true } }, defaultSettings())
    const sub = (s: typeof on) =>
      currentAlerts(
        {
          ...snap,
          units: [],
          containers: [],
          services: [],
          disks: [],
          smart: [],
          sources: {
            systemd: { ok: true },
            podman: { ok: true },
            disks: { ok: true },
            smart: { ok: true },
          },
        } as unknown as Snapshot,
        s,
      ).alerts.filter((a) => a.rule === 'device-new')
    expect(sub(off)).toEqual([])
    expect(sub(on).map((a) => [a.key, a.detail])).toEqual([['device:aa:00:00:00:00:02', '127.0.0.2 · aa:00:00:00:00:02']])

    store.editDevice('aa:00:00:00:00:02', {
      known: true,
      label: '  Annas Handy ',
      note: 'Wohnzimmer',
    })
    expect(store.freshDevices()).toEqual([])
    const d = store.knownDevices().find((k) => k.key === 'aa:00:00:00:00:02')!
    expect(d).toMatchObject({
      label: 'Annas Handy',
      note: 'Wohnzimmer',
      known: true,
    })
    store.editDevice('aa:00:00:00:00:02', { label: '', known: false })
    expect(store.knownDevices().find((k) => k.key === 'aa:00:00:00:00:02')).not.toHaveProperty('label')
    expect(() => store.editDevice('aa:00:00:00:00:02', { label: 'x'.repeat(61) })).toThrow()
    expect(() => store.editDevice('aa:00:00:00:00:02', { label: 'a\u0007b' })).toThrow()
    expect(() => store.editDevice('aa:00:00:00:00:02', { note: 42 })).toThrow()
    expect(() => store.editDevice('nope', {})).toThrow()
  })

  it('a passive read keeps the round trips of the last sweep', () => {
    store.recordScan(scan([{ ip: '127.0.0.1', mac: 'aa:00:00:00:00:01', services: [], rtt: 1.5 }], t0 + 2000), t0 + 2000)
    store.recordScan(scan([{ ip: '127.0.0.1', mac: 'aa:00:00:00:00:01', services: [] }], t0 + 3000, false), t0 + 3000)
    const last = store.lastScan()!
    expect(last.active).toBe(true)
    expect(last.devices[0]!.rtt).toBe(1.5)
    expect(last.at).toBe(t0 + 3000)
  })

  it('sweep interval', () => {
    expect(store.deviceSettings().sweepMinutes).toBe(30)
    expect(() => store.setDeviceSettings({ sweepMinutes: 5 })).toThrow()
    store.setDeviceSettings({ sweepMinutes: 0 })
    expect(store.sweepDue()).toBe(false)
    store.setDeviceSettings({ sweepMinutes: 15 })
    store.markSwept(Date.now() - 16 * 60_000)
    expect(store.sweepDue()).toBe(true)
    store.markSwept()
    expect(store.sweepDue()).toBe(false)
  })

  it('checks ports only inside the own subnets', async () => {
    const srv = createServer().listen(0, '127.0.0.1')
    await new Promise((r) => srv.once('listening', r))
    const port = (srv.address() as { port: number }).port
    await expect(store.checkPorts('8.8.8.8')).rejects.toThrow()
    await expect(store.checkPorts('192.168.1.1')).rejects.toThrow()
    const r = await store.checkPorts('127.0.0.1', false, 300)
    expect(r).toHaveLength(17)
    expect(r.every((p) => typeof p.open === 'boolean')).toBe(true)
    srv.close()
    expect(port).toBeGreaterThan(0)
    const demo = await store.checkPorts('127.0.0.1', true)
    expect(demo.filter((p) => p.open).map((p) => p.port)).toEqual([53, 80, 443])
  })

  it('wake-on-LAN sends the magic packet to the subnet broadcast', async () => {
    expect(store.broadcastOf('192.168.1.0/24')).toBe('192.168.1.255')
    expect(store.broadcastOf('10.0.4.0/22')).toBe('10.0.7.255')
    const sent: [number, string, number][] = []
    const targets = await store.wake('AA:BB:CC:DD:EE:FF', false, async (p, host, port) => void sent.push([p.length, host, port]))
    expect(targets).toEqual(['127.0.0.255', '255.255.255.255'])
    expect(sent).toEqual([
      [102, '127.0.0.255', 9],
      [102, '255.255.255.255', 9],
    ])
    await expect(store.wake('aa:bb:cc', false, async () => {})).rejects.toThrow()
    expect(
      await store.wake('aa:bb:cc:dd:ee:ff', true, async () => {
        throw new Error('demo must not send')
      }),
    ).toHaveLength(2)

    // the real sender reaches a listener (loopback instead of a broadcast)
    const sock = createSocket('udp4')
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()))
    const got = new Promise<Buffer>((r) => sock.once('message', (b) => r(b)))
    await store.sendUdp(magicPacket('aa:bb:cc:dd:ee:ff'), '127.0.0.1', sock.address().port)
    expect([...(await got).subarray(96)]).toEqual([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])
    sock.close()
  })

  it('forget', () => {
    store.forgetDevice('aa:00:00:00:00:01')
    expect(store.knownDevices().some((k) => k.key === 'aa:00:00:00:00:01')).toBe(false)
    expect(() => store.forgetDevice('aa:00:00:00:00:01')).toThrow()
  })
})
