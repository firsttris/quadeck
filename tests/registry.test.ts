import { describe, expect, it } from 'vitest'
import { parseIconIndex } from '~/server/icons'
import { checkTarget } from '~/server/health'
import { localHostSet, matchUpstream, mergeServices, parseDial, probeUrl, type HttpHealth, type MergeInput } from '~/server/registry'
import type { Container } from '~/shared/types'

const ct = (name: string, o: Partial<Container> = {}): Container => ({
  id: name,
  name,
  image: `docker.io/library/${name}:latest`,
  state: 'running',
  status: 'Up',
  labels: {},
  ports: [],
  networks: [],
  aliases: [],
  ips: [],
  cpuHistory: [],
  ...o,
})

const local = localHostSet(['nas-01', '192.168.1.10'])

describe('upstream → container', () => {
  const containers = [
    ct('jellyfin', { unit: 'jellyfin.service', aliases: ['jf'] }),
    ct('namarr', { ports: [{ hostPort: 3000, containerPort: 3000, protocol: 'tcp' }] }),
    ct('old-namarr', { state: 'exited', ports: [{ hostPort: 3000, containerPort: 3000, protocol: 'tcp' }] }),
    ct('db', { ips: ['10.89.0.7'] }),
  ]

  it('parses dial addresses', () => {
    expect(parseDial('jellyfin:8096')).toEqual({ host: 'jellyfin', port: 8096 })
    expect(parseDial('[::1]:3000')).toEqual({ host: '::1', port: 3000 })
    expect(parseDial('http://Host.Lan/x')).toEqual({ host: 'host.lan', port: undefined })
  })

  it('matches by container name, network alias and container IP', () => {
    expect(matchUpstream('jellyfin:8096', containers, local)?.name).toBe('jellyfin')
    expect(matchUpstream('JF:8096', containers, local)?.name).toBe('jellyfin')
    expect(matchUpstream('10.89.0.7:5432', containers, local)?.name).toBe('db')
  })

  it('matches local addresses by published port, preferring running containers', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]', 'host.containers.internal', 'nas-01', '192.168.1.10']) expect(matchUpstream(`${h}:3000`, containers, local)?.name).toBe('namarr')
  })

  it('never guesses for external hosts or unknown ports', () => {
    expect(matchUpstream('192.168.1.30:8123', containers, local)).toBeUndefined()
    expect(matchUpstream('localhost:9999', containers, local)).toBeUndefined()
    expect(matchUpstream('localhost', containers, local)).toBeUndefined()
  })
})

describe('mergeServices', () => {
  const base = (o: Partial<MergeInput> = {}): MergeInput => ({
    candidates: [],
    containers: [],
    manual: [],
    overrides: [],
    httpHealth: new Map(),
    localHosts: local,
    ...o,
  })
  const flat = (g: ReturnType<typeof mergeServices>) => g.flatMap((x) => x.items)

  it('builds tiles from Caddy routes with container, unit, icon and known-app defaults', () => {
    const groups = mergeServices(
      base({
        candidates: [
          { host: 'jellyfin.example.de', url: 'https://jellyfin.example.de', upstreams: ['jellyfin:8096'], provider: 'caddy' },
          { host: 'ha.example.de', url: 'https://ha.example.de', upstreams: ['192.168.1.30:8123'], provider: 'caddy' },
        ],
        containers: [ct('jellyfin', { image: 'docker.io/jellyfin/jellyfin:latest', unit: 'jellyfin.service', health: 'healthy' })],
        iconIndex: parseIconIndex({ svg: ['jellyfin.svg', 'home-assistant.svg'] }),
      }),
    )
    const [jf, ha] = [flat(groups).find((s) => s.key === 'ct:jellyfin')!, flat(groups).find((s) => s.host === 'ha.example.de')!]
    expect(jf).toMatchObject({ name: 'Jellyfin', group: 'Medien', unit: 'jellyfin.service', container: 'jellyfin', health: 'ok', icon: { kind: 'dash', slug: 'jellyfin' } })
    expect(ha).toMatchObject({ name: 'Home Assistant', group: 'Smart Home', key: 'host:ha.example.de', icon: { kind: 'dash', slug: 'home-assistant' }, health: 'unknown' })
  })

  it('applies quadeck.* labels, and UI overrides on top', () => {
    const containers = [ct('app', { labels: { 'quadeck.name': 'Mein App', 'quadeck.group': 'Werkzeuge', 'quadeck.icon': 'glyph:bolt' } })]
    const cand = [{ host: 'app.example.de', url: 'https://app.example.de', upstreams: ['app:80'], provider: 'caddy' }]
    let s = flat(mergeServices(base({ candidates: cand, containers })))[0]!
    expect(s).toMatchObject({ name: 'Mein App', group: 'Werkzeuge', icon: { kind: 'glyph', glyph: 'bolt' } })
    s = flat(mergeServices(base({ candidates: cand, containers, overrides: [{ serviceKey: 'ct:app', name: 'Override', group: null, hidden: false, pinned: true }] })))[0]!
    expect(s).toMatchObject({ name: 'Override', group: 'Werkzeuge', pinned: true })
    expect(flat(mergeServices(base({ candidates: cand, containers, overrides: [{ serviceKey: 'ct:app', hidden: true, pinned: false }] })))).toEqual([])
    expect(flat(mergeServices(base({ candidates: cand, containers: [ct('app', { labels: { 'quadeck.hidden': 'true' } })] })))).toEqual([])
  })

  it('container state beats HTTP health; HTTP health is used otherwise', () => {
    const cand = [
      { host: 'a.x', url: 'https://a.x', upstreams: ['a:1'], provider: 'caddy' },
      { host: 'b.x', url: 'https://b.x', upstreams: ['b:1'], provider: 'caddy' },
    ]
    const httpHealth = new Map([
      ['https://a.x', { health: 'ok' as const }],
      ['https://b.x', { health: 'warn' as const, note: 'langsam' }],
    ])
    const s = flat(mergeServices(base({ candidates: cand, containers: [ct('a', { state: 'exited' }), ct('b')], httpHealth })))
    expect(s.find((x) => x.container === 'a')).toMatchObject({ health: 'bad', healthNote: 'Container gestoppt' })
    expect(s.find((x) => x.container === 'b')).toMatchObject({ health: 'warn', healthNote: 'langsam' })
  })

  it('adds label-only services and manual links, groups them and puts Links last', () => {
    const groups = mergeServices(
      base({
        containers: [ct('grafana', { labels: { 'quadeck.url': 'http://nas:3001' } })],
        manual: [
          { id: 1, name: 'Router', url: 'http://192.168.1.1/', icon: null, group: null, healthCheck: false },
          { id: 2, name: 'Drucker', url: 'http://drucker.lan/', icon: 'brother', group: 'Netzwerk', healthCheck: true },
        ],
        httpHealth: new Map([['http://192.168.1.1/', { health: 'bad' as const }]]),
      }),
    )
    expect(groups.map((g) => g.name)).toEqual(['Netzwerk', 'System', 'Links'])
    expect(groups.find((g) => g.name === 'Links')!.note).toBe('manuell angelegt')
    const router = flat(groups).find((s) => s.name === 'Router')!
    expect(router).toMatchObject({ key: 'manual:1', manualId: 1, health: 'unknown' }) // health check disabled
    expect(flat(groups).find((s) => s.name === 'Drucker')!.icon).toEqual({ kind: 'dash', slug: 'brother' })
    expect(flat(groups).find((s) => s.key === 'ct:grafana')).toMatchObject({ source: 'label', url: 'http://nas:3001/' })
  })

  it('ignores label URLs that are not http(s)', () => {
    const containers = [ct('evil', { labels: { 'quadeck.url': 'file:///etc/shadow' } }), ct('js', { labels: { 'quadeck.url': 'javascript:alert(1)' } })]
    expect(flat(mergeServices(base({ containers })))).toEqual([])
    const cand = [{ host: 'a.x', url: 'https://a.x', upstreams: ['evil:1'], provider: 'caddy' }]
    expect(flat(mergeServices(base({ candidates: cand, containers })))[0]!.url).toBe('https://a.x')
  })

  it('keys a second route to the same container by host', () => {
    const s = flat(
      mergeServices(
        base({
          candidates: [
            { host: 'a.x', url: 'https://a.x', upstreams: ['app:1'], provider: 'caddy' },
            { host: 'b.x', url: 'https://b.x/admin', upstreams: ['app:2'], provider: 'caddy' },
          ],
          containers: [ct('app')],
        }),
      ),
    )
    expect(s.map((x) => x.key).sort()).toEqual(['ct:app', 'host:b.x/admin'])
  })
})

const flat = (g: ReturnType<typeof mergeServices>) => g.flatMap((x) => x.items)

describe('upstream probe for health checks', () => {
  it('maps upstreams to addresses the host can reach', () => {
    const jf = ct('jellyfin', { ips: ['10.88.0.5'], aliases: ['jf'] })
    const noIp = ct('app', { ports: [{ hostPort: 18080, containerPort: 8080, protocol: 'tcp' }] })
    expect(probeUrl('jellyfin:8096', jf, local)).toBe('http://10.88.0.5:8096')
    expect(probeUrl('jf:8096', jf, local)).toBe('http://10.88.0.5:8096')
    expect(probeUrl('app:8080', noIp, local)).toBe('http://127.0.0.1:18080')
    expect(probeUrl('app:9999', noIp, local)).toBeUndefined()
    expect(probeUrl('localhost:3000', undefined, local)).toBe('http://127.0.0.1:3000')
    expect(probeUrl('192.168.1.30:8123', undefined, local)).toBe('http://192.168.1.30:8123')
    expect(probeUrl('jellyfin', jf, local)).toBeUndefined()
  })

  it('is set on Caddy services, not when a label sets the URL', () => {
    const s = flat(
      mergeServices({
        candidates: [{ host: 'borg.home', url: 'https://borg.home', upstreams: ['borg-web-ui:8081'], provider: 'caddy' }],
        containers: [ct('borg-web-ui', { ips: ['10.88.0.9'] })],
        manual: [],
        overrides: [],
        httpHealth: new Map(),
        localHosts: local,
      }),
    )
    expect(s[0]!.probe).toBe('http://10.88.0.9:8081')
  })
})

describe('checkTarget', () => {
  const fake = (results: Record<string, HttpHealth>) => async (u: string) => results[u]!

  it('uses the public URL when it answers', async () => {
    const r = await checkTarget({ url: 'https://a.home', probe: 'http://10.0.0.1:80' }, fake({ 'https://a.home': { health: 'ok', note: 'HTTP 200' } }))
    expect(r).toEqual({ health: 'ok', note: 'HTTP 200' })
  })

  it('falls back to the upstream when the server cannot resolve the public name', async () => {
    const r = await checkTarget(
      { url: 'https://borg.home', probe: 'http://10.88.0.9:8081' },
      fake({ 'https://borg.home': { health: 'bad', note: 'nicht erreichbar: getaddrinfo ENOTFOUND borg.home' }, 'http://10.88.0.9:8081': { health: 'ok', note: 'HTTP 200 · 3 ms' } }),
    )
    expect(r.health).toBe('ok')
    expect(r.note).toContain('Upstream http://10.88.0.9:8081')
  })

  it('stays red when both fail', async () => {
    const r = await checkTarget(
      { url: 'https://x.home', probe: 'http://10.0.0.2:80' },
      fake({ 'https://x.home': { health: 'bad', note: 'nicht erreichbar: ENOTFOUND' }, 'http://10.0.0.2:80': { health: 'bad', note: 'nicht erreichbar: ECONNREFUSED' } }),
    )
    expect(r.health).toBe('bad')
    expect(r.note).toContain('ECONNREFUSED')
  })
})
