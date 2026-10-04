import { beforeEach, describe, expect, it } from 'vitest'
import { run } from '~/server/exec'
import { cleanStorage, fixtureApi, readStorage, type PodmanApi, type QuadletRefs } from '~/server/quadlets/storage'
import { PRUNE_CALENDAR, PRUNE_COMMAND, cleanupPlan, confirmItems, defaultSelection, normalizeImage, parseItems, parseSelection, planSize, quadletKey, storageSummary, type CleanupSelection, type PodmanStorage } from '~/shared/podman-storage'

const refs: QuadletRefs = {
  images: [
    { file: 'jellyfin.container', image: 'docker.io/jellyfin/jellyfin:latest' },
    { file: 'immich.container', image: 'ghcr.io/immich-app/immich-server:release' },
    { file: 'immich-ml.container', image: 'ghcr.io/immich-app/immich-machine-learning:release' },
    { file: 'caddy.container', image: 'caddy:2' },
  ],
  volumes: [],
  networks: [{ file: 'immich.network', name: 'immich' }],
}
const g = globalThis as unknown as { __qdPodmanFixture?: unknown }
const fresh = () => {
  delete g.__qdPodmanFixture
  return fixtureApi('fixtures/demo')
}
const read = (api: PodmanApi) => readStorage(api, refs, () => ({ size: 100, used: 40 }))
const sel = (o: Partial<CleanupSelection> = {}): CleanupSelection => ({ containers: false, dangling: false, unusedImages: false, networks: false, volumes: [], ...o })
const labels = (s: PodmanStorage, o: Partial<CleanupSelection>) => cleanupPlan(s, sel(o)).map((i) => `${i.kind}:${i.label}`)

describe('names', () => {
  it('normalizes image references like Podman resolves them', () => {
    expect(normalizeImage('caddy:2')).toBe('docker.io/library/caddy:2')
    expect(normalizeImage('alpine')).toBe('docker.io/library/alpine:latest')
    expect(normalizeImage('jellyfin/jellyfin')).toBe('docker.io/jellyfin/jellyfin:latest')
    expect(normalizeImage('ghcr.io/immich-app/immich-server:release')).toBe('ghcr.io/immich-app/immich-server:release')
    expect(normalizeImage('localhost/mine')).toBe('localhost/mine:latest')
    expect(normalizeImage('registry.local:5000/x')).toBe('registry.local:5000/x:latest')
    expect(normalizeImage('quay.io/a/b@sha256:abc')).toBe('quay.io/a/b@sha256:abc')
  })
  it('reads keys from Quadlet files', () => {
    const text = '[Container]\n# Image=old\nImage = docker.io/x/y:1 \nVolume=a:/b\n[Volume]\nVolumeName=data\n'
    expect(quadletKey(text, 'Image')).toBe('docker.io/x/y:1')
    expect(quadletKey(text, 'VolumeName')).toBe('data')
    expect(quadletKey(text, 'NetworkName')).toBeUndefined()
  })
  it('accepts only well-formed requests', () => {
    expect(parseItems([{ kind: 'image', id: 'abc' }, { kind: 'host', id: 'x' }, { kind: 'volume', id: '../etc' }, { kind: 'volume', id: '-rf' }, null, 'x'])).toEqual([{ kind: 'image', id: 'abc' }])
    expect(parseItems('nope')).toEqual([])
    expect(parseSelection({ containers: true, volumes: ['a', 3], networks: 'yes' })).toEqual({ containers: true, dangling: false, unusedImages: false, networks: false, volumes: ['a'] })
  })
  it('the timer command is valid sh and never touches volumes', async () => {
    expect((await run(['sh', '-n', '-c', PRUNE_COMMAND])).code).toBe(0)
    expect(PRUNE_COMMAND).not.toMatch(/volume|system prune|-a\b|--all/)
    expect(PRUNE_COMMAND).toContain('label!=PODMAN_SYSTEMD_UNIT')
    expect(PRUNE_CALENDAR.weekly).toBe('Sun *-*-* 04:00:00')
  })
})

describe('reading storage', () => {
  let s: PodmanStorage
  beforeEach(async () => {
    s = await read(fresh())
  })

  it('knows what uses what', () => {
    const img = (name: string) => s.images.find((i) => i.names.includes(name))!
    expect(img('docker.io/library/caddy:2').quadlets).toEqual(['caddy.container']) // short Image= matched
    expect(img('docker.io/library/caddy:2').usedBy).toHaveLength(1)
    expect(img('docker.io/library/alpine:3').usedBy).toHaveLength(3) // scratch, test-alpine, watchtower-test
    expect(img('docker.io/library/nextcloud:29').usedBy).toEqual([])
    const old = s.images.filter((i) => i.dangling)
    expect(old.map((i) => i.previously)).toEqual(['ghcr.io/immich-app/immich-server:release', 'docker.io/jellyfin/jellyfin:latest', 'ghcr.io/immich-app/immich-machine-learning:release', undefined])
    expect(old.every((i) => i.quadlets.length === 0)).toBe(true) // the old version is not what the Quadlet names
    const vol = (n: string) => s.volumes.find((v) => v.name === n)!
    expect(vol('caddy-data').usedBy).toEqual(['caddy' + '0'.repeat(59)])
    expect(vol('nextcloud-data').usedBy).toEqual([])
    expect(vol('nextcloud-data').size).toBe(2_100_000_000)
    expect(s.volumes.filter((v) => v.anonymous)).toHaveLength(2)
    expect(s.networks.find((n) => n.name === 'immich')?.quadlet).toBe('immich.network')
    expect(s.networks.find((n) => n.name === 'podman')?.builtin).toBe(true)
    expect(s.root).toBe('/var/lib/containers/storage')
    expect(s.disk).toEqual({ size: 100, used: 40 })
    const c = s.containers.find((x) => x.name === 'old-nginx')!
    expect(c).toMatchObject({ state: 'exited', exitCode: 137, volumes: ['3f9c0a' + 'e'.repeat(58)] })
    expect(c.exitedAt).toBeGreaterThan(0)
  })

  it('plans the safe cleanup: nothing in use, nothing a Quadlet owns', () => {
    expect(labels(s, defaultSelection())).toEqual([
      'container:test-alpine',
      'container:old-nginx',
      'container:watchtower-test',
      expect.stringMatching(/^image:[0-9a-f]{12} \(ghcr.io\/immich-app\/immich-server:release\)$/),
      expect.stringMatching(/^image:[0-9a-f]{12} \(docker.io\/jellyfin\/jellyfin:latest\)$/),
      expect.stringMatching(/^image:[0-9a-f]{12} \(ghcr.io\/immich-app\/immich-machine-learning:release\)$/),
      expect.stringMatching(/^image:[0-9a-f]{12}$/),
      'network:nextcloud_default',
      'network:test-net', // only because test-alpine goes with it
    ])
    // Quadlet containers stay even when stopped; so do their images and volumes.
    const all = cleanupPlan(s, { containers: true, dangling: true, unusedImages: true, networks: true, volumes: s.volumes.map((v) => v.name) })
    for (const keep of ['immich-ml', 'qbittorrent', 'scratch', 'caddy-data', 'qbittorrent-config', 'immich', 'podman', 'media', 'docker.io/library/alpine:3', 'lscr.io/linuxserver/qbittorrent:latest', 'ghcr.io/immich-app/immich-machine-learning:release']) expect(all.map((i) => i.label)).not.toContain(keep)
  })

  it('cascades: images, volumes and networks freed by removing their containers', () => {
    expect(labels(s, { networks: true })).toEqual(['network:nextcloud_default'])
    expect(labels(s, { unusedImages: true })).toEqual(['image:docker.io/library/nextcloud:29'])
    expect(labels(s, { containers: true, unusedImages: true }).filter((l) => l.startsWith('image'))).toEqual(['image:docker.io/library/nginx:1.25', 'image:docker.io/library/nextcloud:29'])
    const anon = '3f9c0a' + 'e'.repeat(58)
    expect(labels(s, { volumes: [anon, 'nextcloud-data', 'caddy-data'] })).toEqual(['volume:nextcloud-data']) // anon still used by the stopped old-nginx
    expect(labels(s, { containers: true, volumes: [anon, 'nextcloud-data', 'caddy-data'] }).filter((l) => l.startsWith('volume'))).toEqual(['volume:nextcloud-data', 'volume:3f9c0aeeeeee…'])
  })

  it('summary for the tiles', () => {
    const sum = storageSummary(s)
    expect(sum.images.count).toBe(14)
    expect(sum.images.unused).toBe(6) // 4 old versions + nginx (after its container) + nextcloud
    expect(sum.containers).toMatchObject({ count: 11, running: 6, stopped: 3 })
    expect(sum.volumes.unused).toBe(3)
    expect(sum.volumes.free).toBe(2_100_000_000 + 220_000_000 + 64_000_000)
  })
})

describe('cleaning up', () => {
  it('removes exactly the confirmed items, in order, and reads back the new state', async () => {
    const api = fresh()
    const before = await read(api)
    const plan = cleanupPlan(before, { ...defaultSelection(), volumes: ['nextcloud-data'] })
    const calls: string[] = []
    const spy: PodmanApi = (p, i) => {
      if (i?.method === 'DELETE') calls.push(p.replace(/^\/v[\d.]+\/libpod/, ''))
      return api(p, i)
    }
    const r = await cleanStorage(spy, refs, plan.map(({ kind, id }) => ({ kind, id })))
    expect(r.skipped).toBe(0)
    expect(r.results.every((x) => x.ok)).toBe(true)
    expect(calls[0]).toMatch(/^\/containers\//)
    expect(calls.findIndex((c) => c.startsWith('/images/'))).toBeGreaterThan(calls.findLastIndex((c) => c.startsWith('/containers/')))
    expect(calls.at(-1)).toMatch(/^\/networks\//)
    expect(calls).toContain('/volumes/nextcloud-data')
    const after = await read(api)
    expect(after.containers).toHaveLength(8)
    expect(after.images.filter((i) => i.dangling)).toHaveLength(0)
    expect(after.volumes.map((v) => v.name)).not.toContain('nextcloud-data')
    expect(planSize(cleanupPlan(after, defaultSelection()))).toBe(0)
  })

  it('skips what is in use by now and never forces', async () => {
    const api = fresh()
    const s = await read(api)
    const nextcloud = s.images.find((i) => i.names.includes('docker.io/library/nextcloud:29'))!
    // a container using nextcloud:29 and nextcloud-data appears between preview and click
    const state = g.__qdPodmanFixture as { containers: unknown[] }
    state.containers.push({ Id: 'beef'.repeat(16), Names: ['nextcloud'], Image: 'docker.io/library/nextcloud:29', ImageID: nextcloud.id, State: 'running', Labels: {}, Networks: ['nextcloud_default'], Mounts: [{ Type: 'volume', Name: 'nextcloud-data' }] })
    const methods: string[] = []
    const r = await cleanStorage(
      (p, i) => {
        if (i?.method) methods.push(`${i.method} ${p}`)
        return api(p, i)
      },
      refs,
      [
        { kind: 'image', id: nextcloud.id },
        { kind: 'volume', id: 'nextcloud-data' },
        { kind: 'network', id: 'nextcloud_default' },
        { kind: 'volume', id: 'caddy-data' },
        { kind: 'container', id: 'jellyfin' + '0'.repeat(56) }, // running, owned by a Quadlet
      ],
    )
    expect(r.results).toEqual([])
    expect(r.skipped).toBe(5)
    expect(methods).toEqual([])
    expect(confirmItems(s, [{ kind: 'image', id: nextcloud.id }])).toHaveLength(1) // it was removable before
  })

  it('reports what Podman refuses', async () => {
    const api = fresh()
    const s = await read(api)
    const old = s.images.find((i) => i.dangling)!
    const refusing: PodmanApi = async (p, i) => (i?.method === 'DELETE' ? new Response(JSON.stringify({ message: 'image is in use by a container' }), { status: 409 }) : api(p, i))
    const r = await cleanStorage(refusing, refs, [{ kind: 'image', id: old.id }])
    expect(r.results).toEqual([{ item: expect.objectContaining({ kind: 'image', id: old.id }), ok: false, error: expect.any(String) }])
    const broken: PodmanApi = async (p, i) => (i?.method === 'DELETE' ? new Response('boom', { status: 500 }) : api(p, i))
    const r2 = await cleanStorage(broken, refs, [{ kind: 'image', id: old.id }])
    expect(r2.results[0]!.error).toBe('boom')
  })

  it('fails clearly when Podman does not answer', async () => {
    const down: PodmanApi = async () => new Response('', { status: 500 })
    await expect(readStorage(down, refs)).rejects.toThrow(/Podman-API/)
  })
})
