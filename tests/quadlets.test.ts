import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diffLines, hunks, MAX_EDITS } from '~/lib/diff'
import { generatedUnit, generatorDiagnostics, missingReferences, SystemPodmanAdmin } from '~/server/quadlets/backend'
import { composeToQuadlets } from '~/server/quadlets/compose'
import { getValue, getValues, lintQuadlet, parseIni, setValues } from '~/shared/ini'
import { assertQuadletName, quadletUnit, removalPlan } from '~/shared/quadlets'
import { getToml, setToml } from '~/shared/toml-edit'

const FILE = `# Jellyfin
[Unit]
Description=Jellyfin

[Container]
Image=docker.io/jellyfin/jellyfin:latest
# Medien nur lesend
Volume=/srv/a:/config:Z
Volume=/mnt/media:/media:ro
Exec=--foo \\
  --bar
Unknown=keep me

[Install]
WantedBy=multi-user.target
`

describe('ini', () => {
  it('parses sections, continuation lines and comments', () => {
    const e = parseIni(FILE)
    expect(getValues(FILE, 'Container', 'Volume')).toEqual(['/srv/a:/config:Z', '/mnt/media:/media:ro'])
    expect(getValue(FILE, 'Container', 'Exec')).toBe('--foo  --bar')
    expect(e.filter((x) => x.kind === 'comment')).toHaveLength(2)
  })

  it('changes one key and keeps everything else byte for byte', () => {
    const out = setValues(FILE, 'Container', 'Image', ['docker.io/jellyfin/jellyfin:10.9'])
    expect(out).toBe(FILE.replace('jellyfin:latest', 'jellyfin:10.9'))
  })

  it('replaces multi values in place, removes surplus ones and appends new keys to the section', () => {
    let out = setValues(FILE, 'Container', 'Volume', ['/x:/y'])
    expect(out).toContain('# Medien nur lesend\nVolume=/x:/y\nExec=--foo')
    expect(getValues(out, 'Container', 'Volume')).toEqual(['/x:/y'])
    out = setValues(out, 'Container', 'PublishPort', ['8096:8096'])
    expect(out).toContain('Unknown=keep me\nPublishPort=8096:8096\n\n[Install]')
    out = setValues(out, 'Container', 'Exec', [])
    expect(out).not.toContain('--bar')
    expect(out).toContain('Unknown=keep me')
  })

  it('creates missing sections ([Unit] at the top)', () => {
    const base = '[Container]\nImage=x\n'
    expect(setValues(base, 'Service', 'Restart', ['always'])).toBe('[Container]\nImage=x\n\n[Service]\nRestart=always\n')
    expect(setValues(base, 'Unit', 'Description', ['d']).startsWith('[Unit]\nDescription=d\n\n[Container]')).toBe(true)
  })

  it('lints quadlet files line by line', () => {
    expect(lintQuadlet(FILE, 'container')).toEqual([{ line: 12, severity: 'warning', message: 'Unbekannter Schlüssel Unknown in [Container]' }])
    const bad = 'Image=x\n[Container]\nContainerName=a\nContainerName=b\nAutoUpdate=sometimes\nnot a line\n[Network]\n'
    const d = lintQuadlet(bad, 'container')
    expect(d.map((x) => [x.line, x.severity])).toEqual([
      [1, 'error'],
      [4, 'warning'],
      [5, 'warning'],
      [6, 'error'],
      [7, 'error'],
      [undefined, 'error'],
    ])
    expect(d.at(-1)!.message).toBe('Image= fehlt')
    expect(lintQuadlet('[Network]\n', 'network')).toEqual([])
    expect(lintQuadlet('[Network]\n', 'container')[1]!.message).toBe('Abschnitt [Container] fehlt')
  })
})

describe('names', () => {
  it('validates names and derives units', () => {
    expect(() => assertQuadletName('jellyfin.container')).not.toThrow()
    expect(() => assertQuadletName('media/jellyfin.container')).not.toThrow()
    for (const bad of ['../x.container', 'a/b/c.container', '.hidden.container', 'x.service', 'x y.container', '/abs.container']) expect(() => assertQuadletName(bad)).toThrow()
    expect(quadletUnit('media/jellyfin.container')).toBe('jellyfin.service')
    expect(quadletUnit('immich.network')).toBe('immich-network.service')
    expect(quadletUnit('app.pod')).toBe('app-pod.service')
  })
})

describe('toml', () => {
  const conf = '# Kurznamen\nunqualified-search-registries = ["docker.io"]\n\n[aliases]\n"x" = "y"\n'
  it('reads and edits single keys, keeping comments', () => {
    expect(getToml(conf, '', 'unqualified-search-registries')).toEqual(['docker.io'])
    let out = setToml(conf, '', 'unqualified-search-registries', ['docker.io', 'quay.io'])
    expect(out).toBe(conf.replace('["docker.io"]', '["docker.io", "quay.io"]'))
    out = setToml(out, '', 'short-name-mode', 'enforcing')
    expect(out.split('\n').slice(0, 3)).toEqual(['# Kurznamen', 'unqualified-search-registries = ["docker.io", "quay.io"]', ''])
    expect(out).toContain('short-name-mode = "enforcing"\n[aliases]')
    out = setToml(out, 'engine', 'image_parallel_copies', 4)
    expect(out).toContain('[engine]\nimage_parallel_copies = 4')
    expect(Bun.TOML.parse(out)).toMatchObject({ 'short-name-mode': 'enforcing', engine: { image_parallel_copies: 4 } })
    expect(setToml(out, '', 'short-name-mode', undefined)).not.toContain('short-name-mode')
  })
})

describe('diff', () => {
  it('produces a minimal line diff with context hunks', () => {
    const a = 'a\nb\nc\nd\ne\nf\ng\nh\ni'
    const b = 'a\nb\nc\nd\nE\nf\ng\nh\ni\nj'
    const d = diffLines(a, b)
    expect(d.filter((l) => l.op !== ' ')).toEqual([
      { op: '-', text: 'e' },
      { op: '+', text: 'E' },
      { op: '+', text: 'j' },
    ])
    const h = hunks(d, 1)
    expect(h.map((l) => (l ? l.op + l.text : null))).toEqual([' d', '-e', '+E', ' f', null, ' i', '+j'])
  })

  it('stays fast and small on large files (the old table needed n·m memory)', () => {
    const big = Array.from({ length: 40_000 }, (_, i) => `line ${i}`).join('\n')
    const t = performance.now()
    const d = diffLines(big, big.replace('line 20000', 'LINE').replace('line 30000\n', ''))
    expect(d.filter((l) => l.op !== ' ')).toEqual([
      { op: '-', text: 'line 20000' },
      { op: '+', text: 'LINE' },
      { op: '-', text: 'line 30000' },
    ])
    expect(performance.now() - t).toBeLessThan(2000)
  })

  it('shows a completely rewritten file as removed and re-added beyond the edit limit', () => {
    const a = Array.from({ length: MAX_EDITS + 10 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: MAX_EDITS + 10 }, (_, i) => `b${i}`).join('\n')
    const d = diffLines(a, b)
    expect(d.filter((l) => l.op === '-').map((l) => l.text).join('\n')).toBe(a)
    expect(d.filter((l) => l.op === '+').map((l) => l.text).join('\n')).toBe(b)
  })

  it('always reproduces both texts', () => {
    for (let r = 0; r < 500; r++) {
      const rnd = () => Array.from({ length: Math.floor(Math.random() * 15) }, () => 'abc'[Math.floor(Math.random() * 3)]).join('\n')
      const a = rnd()
      const b = rnd()
      const d = diffLines(a, b)
      expect(d.filter((l) => l.op !== '+').map((l) => l.text).join('\n')).toBe(a)
      expect(d.filter((l) => l.op !== '-').map((l) => l.text).join('\n')).toBe(b)
    }
  })
})

describe('compose import', () => {
  const doc = Bun.YAML.parse(`
services:
  web:
    image: nginx
    container_name: My Web
    ports: ["8080:80", { target: 443, published: 8443 }]
    volumes: ["data:/usr/share/nginx/html", "./conf:/etc/nginx/conf.d:ro"]
    environment: { TZ: Europe/Berlin, EMPTY: null }
    depends_on: [db]
    restart: unless-stopped
    healthcheck: { test: ["CMD-SHELL", "curl -f http://localhost"], interval: 30s }
    command: ["nginx", "-g", "daemon off;"]
    deploy: { replicas: 2 }
  db:
    image: ghcr.io/x/postgres:16
    environment: ["POSTGRES_PASSWORD=secret\\nInjected=1"]
volumes:
  data: {}
`)
  it('turns services into .container files plus network and volumes', () => {
    const r = composeToQuadlets(doc, 'Shop')
    expect(r.files.map((f) => f.name)).toEqual(['Shop.network', 'data.volume', 'web.container', 'db.container'])
    const web = r.files.find((f) => f.name === 'web.container')!.content
    expect(getValue(web, 'Container', 'Image')).toBe('docker.io/library/nginx')
    expect(getValue(web, 'Container', 'ContainerName')).toBe('My-Web')
    expect(getValues(web, 'Container', 'PublishPort')).toEqual(['8080:80', '8443:443'])
    expect(getValues(web, 'Container', 'Volume')).toEqual(['data.volume:/usr/share/nginx/html', './conf:/etc/nginx/conf.d:ro'])
    expect(getValues(web, 'Container', 'Environment')).toEqual(['TZ=Europe/Berlin', 'EMPTY'])
    expect(getValue(web, 'Container', 'Network')).toBe('Shop.network')
    expect(getValue(web, 'Container', 'HealthCmd')).toBe('curl -f http://localhost')
    expect(getValue(web, 'Container', 'Exec')).toBe('nginx -g "daemon off;"')
    expect(getValues(web, 'Unit', 'Requires')).toEqual(['db.service'])
    expect(getValue(web, 'Service', 'Restart')).toBe('always')
    expect(lintQuadlet(web, 'container').filter((d) => d.severity === 'error')).toEqual([])
    const db = r.files.find((f) => f.name === 'db.container')!.content
    expect(getValue(db, 'Container', 'Image')).toBe('ghcr.io/x/postgres:16')
    // A newline in a value must not create a new key.
    expect(getValue(db, 'Container', 'Injected')).toBe('')
    expect(r.warnings).toEqual(expect.arrayContaining(['web: relativer Pfad ./conf – in einen absoluten Pfad ändern', 'web: deploy: wird nicht übernommen']))
  })

  it('reports non-compose input', () => {
    expect(composeToQuadlets({ foo: 1 }, 'x').warnings[0]).toContain('Keine services')
  })
})

describe('generator output', () => {
  it('maps generator errors to lines and extracts the generated unit', () => {
    const content = '[Container]\nImage=x\nFoo=bar\n'
    // Captured from podman 4.9 quadlet -dryrun.
    const stderr = [
      'quadlet-generator[42]: Loading source unit file /tmp/q/web.container',
      `quadlet-generator[42]: converting "web.container": unsupported key 'Foo' in group 'Container' in /tmp/q/web.container`,
      'quadlet-generator[42]: Warning: web.container specifies the image "x" which not a fully qualified image name.',
      'quadlet-generator[42]: converting "other.container": broken',
    ].join('\n')
    expect(generatorDiagnostics(stderr, 'web.container', content)).toEqual([
      { severity: 'error', line: 3, message: `Generator: converting "web.container": unsupported key 'Foo' in group 'Container'` },
      { severity: 'warning', line: undefined, message: 'Generator: web.container specifies the image "x" which not a fully qualified image name.' },
    ])
    expect(missingReferences('[Container]\nNetwork=app.network\nVolume=data.volume:/d\nVolume=/srv:/srv\nNetwork=host\n', 'web.container', ['app.network'])).toEqual([
      { line: 3, severity: 'warning', message: 'data.volume gibt es (noch) nicht – die Unit startet sonst nicht' },
    ])
    expect(generatedUnit('---a.service---\n[Unit]\nA\n---web.service---\n[Unit]\nB\n', 'web.service')).toBe('[Unit]\nB')
  })
})

describe('SystemPodmanAdmin on a temp directory', () => {
  it('writes with git history, validates first, restores revisions and deletes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-quadlets-'))
    const dir = join(root, 'systemd')
    const calls: string[] = []
    const admin = new SystemPodmanAdmin({ dir, gitDir: join(root, 'git'), confDir: root, manager: async (m: string, _s?: string, ...a: string[]) => (calls.push([m, ...a].join(' ')), '') })
    await expect(admin.writeQuadlet('web.container', '[Container]\n', false)).rejects.toMatchObject({ status: 422 })
    expect(existsSync(join(dir, 'web.container'))).toBe(false)

    const r = await admin.writeQuadlet('web.container', '[Container]\nImage=docker.io/library/nginx\n', true)
    expect(r).toMatchObject({ unit: 'web.service', restarted: true })
    expect(calls).toEqual(['Reload', 'RestartUnit web.service replace'])
    await admin.writeQuadlet('web.container', '[Container]\nImage=docker.io/library/nginx:1.27\n', false)
    expect(await admin.quadlets()).toMatchObject([{ name: 'web.container', type: 'container', unit: 'web.service' }])

    const hist = await admin.quadletHistory('web.container')
    expect(hist.map((h) => h.message)).toEqual(['web.container geändert', 'web.container angelegt'])
    expect(await admin.quadletRevision('web.container', hist[1]!.id)).toBe('[Container]\nImage=docker.io/library/nginx\n')
    await expect(admin.quadletRevision('web.container', 'HEAD~1')).rejects.toMatchObject({ status: 400 })

    await admin.deleteQuadlet('web.container')
    expect(existsSync(join(dir, 'web.container'))).toBe(false)
    expect((await admin.quadletHistory('web.container'))[0]!.message).toBe('web.container gelöscht')
    // The Quadlet directory itself stays free of .git.
    expect(existsSync(join(dir, '.git'))).toBe(false)
  })

  it('deletes with image and volumes, keeps host folders and what others still use', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-remove-'))
    const dir = join(root, 'systemd')
    mkdirSync(dir)
    writeFileSync(join(dir, 'app.container'), '[Container]\nImage=docker.io/library/app:1\nVolume=app-data.volume:/data\nVolume=cache:/cache\nVolume=shared:/s\nVolume=/srv/app:/config:Z\n')
    writeFileSync(join(dir, 'app-data.volume'), '[Volume]\n')
    writeFileSync(join(dir, 'other.container'), '[Container]\nImage=docker.io/library/other\nVolume=shared:/s\n')
    const calls: string[] = []
    const exec = async (argv: string[]) => (calls.push(argv.join(' ')), { code: argv[1] === 'rmi' ? 2 : 0, stdout: '', stderr: argv[1] === 'rmi' ? 'image is in use by a container' : '' })
    const admin = new SystemPodmanAdmin({ dir, gitDir: join(root, 'git'), confDir: root, manager: async (m: string, _s?: string, ...a: string[]) => (calls.push([m, ...a].join(' ')), ''), exec })
    const r = await admin.deleteQuadlet('app.container', { image: true, volumes: true })
    expect(calls).toEqual([
      'systemctl stop app.service',
      'StopUnit app-data-volume.service replace',
      'Reload',
      'podman volume rm -- systemd-app-data',
      'podman volume rm -- cache',
      'podman rmi -- docker.io/library/app:1',
    ])
    expect(r.warnings).toEqual([expect.stringContaining('docker.io/library/app:1')])
    expect(existsSync(join(dir, 'app.container'))).toBe(false)
    expect(existsSync(join(dir, 'app-data.volume'))).toBe(false)
    expect(existsSync(join(dir, 'other.container'))).toBe(true)

    // Without the boxes only the unit and the file go.
    calls.length = 0
    const r2 = await admin.deleteQuadlet('other.container')
    expect(calls).toEqual(['StopUnit other.service replace', 'Reload'])
    expect(r2.warnings).toEqual([])
  })

  it('validates TOML before writing podman configs and keeps a backup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-conf-'))
    writeFileSync(join(root, 'registries.conf'), 'unqualified-search-registries = ["docker.io"]\n')
    const admin = new SystemPodmanAdmin({ dir: join(root, 'systemd'), gitDir: join(root, 'git'), confDir: root, manager: async () => '' })
    await expect(admin.writePodmanConfig('registries.conf', 'broken = [')).rejects.toMatchObject({ status: 422 })
    await expect(admin.writePodmanConfig('storage.conf', 'a = 1')).rejects.toMatchObject({ status: 400 })
    await admin.writePodmanConfig('registries.conf', 'unqualified-search-registries = ["quay.io"]\n')
    expect(readFileSync(join(root, 'registries.conf'), 'utf8')).toContain('quay.io')
    expect(readFileSync(join(root, 'registries.conf.quadeck-bak'), 'utf8')).toContain('docker.io')
    await expect(admin.setAutoUpdateTimer(true, 'daily; rm -rf /')).rejects.toMatchObject({ status: 400 })
  })
})

describe('removalPlan', () => {
  const files = [
    { name: 'app.container', content: '[Container]\nImage=docker.io/library/app:1\nVolume=db.volume:/var/lib/db\nVolume=cache:/cache:Z\nVolume=/srv/app:/config\nVolume=./rel:/x\nVolume=/anonymous\nVolume=-rf:/bad\n' },
    { name: 'db.volume', content: '[Volume]\nVolumeName=appdb\n' },
    { name: 'web.container', content: '[Container]\nImage=docker.io/library/app:1\nVolume=cache:/c\n' },
    { name: 'built.container', content: '[Container]\nImage=app.build\n' },
  ]
  it('lists the image, named volumes and host folders', () => {
    expect(removalPlan('app.container', files)).toEqual({
      image: { name: 'docker.io/library/app:1', shared: true },
      volumes: [
        { name: 'appdb', file: 'db.volume', shared: false },
        { name: 'cache', shared: true },
      ],
      binds: ['/srv/app', './rel'],
    })
  })
  it('offers nothing for images built by Quadlet or other file types', () => {
    expect(removalPlan('built.container', files)).toEqual({ image: undefined, volumes: [], binds: [] })
    expect(removalPlan('db.volume', files)).toEqual({ volumes: [], binds: [] })
  })
})
