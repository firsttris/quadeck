import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureNetwork, cgroupOwner, parseFirewalldZone, parseIpAddr, parseResolvConf, parseResolvectl, parseRoutes, parseSs, parseUfw, firewalldServicePorts } from '~/server/network/collect'
import { firewallVerdict, mergeContainerPorts, portAllowed, scopeOf, type FirewallInfo } from '~/shared/network'

describe('ip', () => {
  it('reads interfaces with kind, state, addresses and counters', () => {
    const sys = mkdtempSync(join(tmpdir(), 'qd-net-'))
    mkdirSync(join(sys, 'enp3s0/device'), { recursive: true })
    mkdirSync(join(sys, 'enp3s0/statistics'), { recursive: true })
    writeFileSync(join(sys, 'enp3s0/speed'), '1000\n')
    writeFileSync(join(sys, 'enp3s0/statistics/rx_bytes'), '123\n')
    writeFileSync(join(sys, 'enp3s0/statistics/tx_bytes'), '45\n')
    mkdirSync(join(sys, 'wlan0/wireless'), { recursive: true })
    mkdirSync(join(sys, 'wpan0'), { recursive: true })
    writeFileSync(join(sys, 'wpan0/speed'), '10000\n') // tun devices report a made-up 10 Gbit/s
    const json = JSON.stringify([
      { ifname: 'lo', flags: ['LOOPBACK', 'UP', 'LOWER_UP'], mtu: 65536, operstate: 'UNKNOWN', link_type: 'loopback', address: '00:00:00:00:00:00', addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 8, scope: 'host' }] },
      {
        ifname: 'enp3s0',
        flags: ['UP'],
        mtu: 1500,
        operstate: 'UP',
        link_type: 'ether',
        address: 'aa:bb:cc:dd:ee:ff',
        addr_info: [
          { family: 'inet', local: '192.168.1.20', prefixlen: 24, scope: 'global', dynamic: true },
          { family: 'inet6', local: 'fe80::1', prefixlen: 64, scope: 'link' },
        ],
      },
      { ifname: 'wlan0', flags: [], mtu: 1500, operstate: 'DOWN', link_type: 'ether', address: '11:22:33:44:55:66' },
      { ifname: 'podman0', flags: ['UP'], mtu: 1500, operstate: 'UP', link_type: 'ether', linkinfo: { info_kind: 'bridge' }, address: '6e:00:00:00:00:01' },
      { ifname: 'veth0', flags: ['UP'], mtu: 1500, operstate: 'UP', link_type: 'ether', linkinfo: { info_kind: 'veth' }, master: 'podman0' },
      { ifname: 'wg0', flags: ['UP'], mtu: 1420, operstate: 'UNKNOWN', link_type: 'none', linkinfo: { info_kind: 'wireguard' } },
      // OpenThread border router (Matter/Thread): a tun device, but not a VPN
      { ifname: 'wpan0', flags: ['UP', 'LOWER_UP'], mtu: 1280, operstate: 'UNKNOWN', link_type: 'none', linkinfo: { info_kind: 'tun' }, addr_info: [{ family: 'inet6', local: 'fddf:bdac:eb86:bced:0:ff:fe00:e400', prefixlen: 64, scope: 'global' }] },
    ])
    const ifs = parseIpAddr(json, sys)
    expect(ifs.map((i) => [i.name, i.kind, i.state])).toEqual([
      ['lo', 'loopback', 'UP'],
      ['enp3s0', 'ethernet', 'UP'],
      ['wlan0', 'wifi', 'DOWN'],
      ['podman0', 'bridge', 'UP'],
      ['veth0', 'container', 'UP'],
      ['wg0', 'vpn', 'UNKNOWN'],
      ['wpan0', 'thread', 'UP'],
    ])
    expect(ifs[6]!.speedMbps).toBeUndefined()
    expect(ifs[0]!.mac).toBeUndefined()
    expect(ifs[1]).toMatchObject({
      speedMbps: 1000,
      rxBytes: 123,
      txBytes: 45,
      addresses: [
        { address: '192.168.1.20', prefix: 24, dynamic: true },
        { address: 'fe80::1', scope: 'link' },
      ],
    })
    expect(ifs[4]!.master).toBe('podman0')
  })

  it('reads routes and DNS', () => {
    expect(parseRoutes('[{"dst":"default","gateway":"192.168.1.1","dev":"eth0","flags":[]}]', 'inet')).toEqual([{ family: 'inet', dst: 'default', gateway: '192.168.1.1', dev: 'eth0' }])
    expect(parseRoutes('', 'inet6')).toEqual([])
    expect(parseResolvConf('# x\nnameserver 127.0.0.53\noptions edns0\nsearch fritz.box lan\n')).toEqual({ servers: ['127.0.0.53'], search: ['fritz.box', 'lan'] })
    expect(parseResolvectl('Global:\nLink 2 (enp3s0): 192.168.1.1 fd00::1\nLink 3 (wg0):\n')).toEqual(['192.168.1.1', 'fd00::1'])
  })
})

describe('ss', () => {
  it('merges IPv4/IPv6 sockets per program and knows the scope', () => {
    const out = [
      'tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))',
      'tcp LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=812,fd=4))',
      'tcp LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=640,fd=15))',
      'udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=640,fd=14))',
      'tcp LISTEN 0 64 *:2049 *:*',
      'tcp LISTEN 0 50 192.168.1.20:8080 0.0.0.0:* users:(("app",pid=9,fd=1))',
      'tcp ESTAB 0 0 192.168.1.20:22 192.168.1.5:5000 users:(("sshd",pid=900,fd=4))',
      'udp UNCONN 0 0 [::1]:323 [::]:* users:(("chronyd",pid=7,fd=6))',
    ].join('\n')
    expect(parseSs(out)).toEqual([
      { proto: 'tcp', port: 22, addresses: ['0.0.0.0', '::'], scope: 'all', process: 'sshd', pid: 812 },
      { proto: 'tcp', port: 53, addresses: ['127.0.0.53'], scope: 'local', process: 'systemd-resolve', pid: 640 },
      { proto: 'udp', port: 53, addresses: ['127.0.0.53'], scope: 'local', process: 'systemd-resolve', pid: 640 },
      { proto: 'udp', port: 323, addresses: ['::1'], scope: 'local', process: 'chronyd', pid: 7 },
      { proto: 'tcp', port: 2049, addresses: ['*'], scope: 'all', process: undefined, pid: undefined },
      { proto: 'tcp', port: 8080, addresses: ['192.168.1.20'], scope: 'address', process: 'app', pid: 9 },
    ])
  })

  it('finds the unit or container of a process', () => {
    expect(cgroupOwner('0::/system.slice/sshd.service\n')).toEqual({ unit: 'sshd.service' })
    expect(cgroupOwner('0::/machine.slice/libpod-0123456789abcdef0123.scope/container\n')).toEqual({ containerId: '0123456789abcdef0123' })
    expect(cgroupOwner('0::/user.slice/user-1000.slice/session-2.scope\n')).toEqual({ unit: undefined })
    expect(scopeOf(['127.0.0.1', '::1'])).toBe('local')
  })
})

describe('firewall', () => {
  it('parses firewalld and ufw', () => {
    const fw = parseFirewalldZone('public (active)\n  target: default\n  interfaces: enp3s0\n  services: dhcpv6-client ssh\n  ports: 8585/tcp 60000-61000/udp\n  protocols: \n')
    expect(fw).toEqual({ zone: 'public', services: ['dhcpv6-client', 'ssh'], ports: ['8585/tcp', '60000-61000/udp'] })
    expect(
      parseUfw(
        'Status: active\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW       Anywhere\nOpenSSH                    ALLOW       Anywhere\n8000:8100/tcp              ALLOW IN    Anywhere\n22/tcp (v6)                ALLOW       Anywhere (v6)\n',
      ),
    ).toEqual({
      active: true,
      ports: ['22/tcp', '8000-8100/tcp'],
      services: ['OpenSSH'],
    })
    expect(parseUfw('Status: inactive\n').active).toBe(false)
  })

  it('decides per port', () => {
    const fw: FirewallInfo = { kind: 'firewalld', active: true, ports: ['22/tcp', '60000-61000/udp'], services: [] }
    expect(portAllowed(fw.ports, 60500, 'udp')).toBe(true)
    expect(portAllowed(fw.ports, 60500, 'tcp')).toBe(false)
    expect(firewallVerdict({ proto: 'tcp', port: 22, addresses: ['0.0.0.0'], scope: 'all', process: 'sshd' }, fw)).toBe('open')
    expect(firewallVerdict({ proto: 'tcp', port: 111, addresses: ['0.0.0.0'], scope: 'all', process: 'rpcbind' }, fw)).toBe('blocked')
    expect(firewallVerdict({ proto: 'tcp', port: 631, addresses: ['127.0.0.1'], scope: 'local' }, fw)).toBeUndefined()
    expect(firewallVerdict({ proto: 'tcp', port: 8096, addresses: ['0.0.0.0'], scope: 'all', container: 'jellyfin' }, fw)).toBe('podman')
    expect(firewallVerdict({ proto: 'tcp', port: 1, addresses: ['0.0.0.0'], scope: 'all' }, { kind: 'none', active: false, ports: [], services: [] })).toBe('open')
  })

  it('adds published container ports and names container processes', () => {
    const fw: FirewallInfo = { kind: 'none', active: false, ports: [], services: [] }
    const ports = mergeContainerPorts(
      [{ proto: 'tcp', port: 3000, addresses: ['0.0.0.0'], scope: 'all', process: 'node', container: 'abc123abc123' }],
      [
        { id: 'abc123abc123ffff', name: 'namarr', ports: [{ hostPort: 3000, protocol: 'tcp' }] },
        {
          id: 'def',
          name: 'jellyfin',
          ports: [
            { hostPort: 8096, protocol: 'tcp' },
            { hostIp: '127.0.0.1', hostPort: 8097, protocol: 'udp' },
          ],
        },
      ],
      fw,
    )
    expect(ports.map((p) => [p.port, p.proto, p.container, p.scope])).toEqual([
      [3000, 'tcp', 'namarr', 'all'],
      [8096, 'tcp', 'jellyfin', 'all'],
      [8097, 'udp', 'jellyfin', 'local'],
    ])
  })

  it('serves the demo data', async () => {
    const s = await new FixtureNetwork('fixtures/demo').networkState()
    expect(s.ports.find((p) => p.port === 111)?.firewall).toBe('blocked')
    expect(s.ports.find((p) => p.port === 22)?.firewall).toBe('open')
  })
})

describe('firewalld service ports without one firewall-cmd per service', () => {
  it('reads the service definition, /etc before /usr/lib', () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-fw-'))
    const [etc, lib] = [join(root, 'etc'), join(root, 'lib')]
    mkdirSync(etc)
    mkdirSync(lib)
    writeFileSync(join(lib, 'ssh.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<service>\n  <short>SSH</short>\n  <port protocol="tcp" port="22"/>\n</service>\n')
    writeFileSync(join(lib, 'samba.xml'), '<service><port protocol="udp" port="137"/><port protocol="udp" port="138"/><port protocol="tcp" port="139"/><port protocol="tcp" port="445"/></service>')
    writeFileSync(join(etc, 'ssh.xml'), '<service><port port="2222" protocol="tcp" /></service>')
    expect(firewalldServicePorts('samba', [etc, lib])).toEqual(['137/udp', '138/udp', '139/tcp', '445/tcp'])
    expect(firewalldServicePorts('ssh', [etc, lib])).toEqual(['2222/tcp'])
    expect(firewalldServicePorts('missing', [etc, lib])).toBeUndefined()
    expect(firewalldServicePorts('../ssh', [etc, lib])).toBeUndefined()
  })
})
