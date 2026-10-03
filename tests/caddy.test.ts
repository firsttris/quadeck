import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CaddyManager, FixtureCaddyHost, SystemCaddyHost, type CaddyHost } from '~/server/caddy/backend'
import { applyCaddyChange, NO_OPTIONS, renderSite, siteForm, caddyFromQuadlet, configFromCommand, contentHash, isCaddyImage, manualPathProblem, parseCaddyfile, parseCaddyChange } from '~/shared/caddy'

const FILE = `# My proxy
{
	email me@example.com
}

(common) {
	encode gzip
}

import sites/*

jellyfin.home.example {
	reverse_proxy localhost:8096
}

a.example.com, b.example.com {
	reverse_proxy 10.0.0.2:80 10.0.0.3:80 # two upstreams
}

ha.home.example {
	reverse_proxy 192.168.1.30:8123 {
		header_up X-Real-IP {remote_host}
	}
}

secret.example.com {
	basicauth {
		me $2a$14$abc{}
	}
	reverse_proxy "localhost:9000"
}
`

describe('Caddyfile parsing', () => {
  it('finds global options, snippets, imports, simple and custom sites', () => {
    const { blocks, unstructured } = parseCaddyfile(FILE)
    expect(unstructured).toBe(false)
    expect(blocks.map((b) => [b.kind, b.addresses.join(','), b.upstreams?.join(' ')])).toEqual([
      ['global', '', undefined],
      ['snippet', '(common)', undefined],
      ['import', 'import sites/*', undefined],
      ['proxy', 'jellyfin.home.example', 'localhost:8096'],
      ['proxy', 'a.example.com,b.example.com', '10.0.0.2:80 10.0.0.3:80'],
      ['proxy', 'ha.home.example', '192.168.1.30:8123'],
      ['site', 'secret.example.com', undefined],
    ])
    expect(blocks.find((b) => b.addresses[0] === 'ha.home.example')!.line).toBe(20)
  })

  it('treats a single site without braces as text only', () => {
    expect(parseCaddyfile('example.com\nreverse_proxy localhost:80\n').unstructured).toBe(true)
  })

  it('does not get confused by braces in quotes, comments and heredocs', () => {
    const text = 'x.example.com {\n\trespond "}{" 200 # }\n\trespond <<HTML\n\t\t<p>}</p>\n\t\tHTML 200\n}\n\ny.example.com {\n\treverse_proxy y:1\n}\n'
    const { blocks } = parseCaddyfile(text)
    expect(blocks.map((b) => b.addresses[0])).toEqual(['x.example.com', 'y.example.com'])
    expect(blocks[1]!.kind).toBe('proxy')
  })
})

describe('Caddyfile changes', () => {
  it('adds a site at the end and keeps everything else', () => {
    const out = applyCaddyChange(FILE, { kind: 'site', addresses: ['new.example.com'], upstreams: ['localhost:3000'] })
    expect(out.startsWith(FILE.trimEnd())).toBe(true)
    expect(out.endsWith('\n\nnew.example.com {\n\treverse_proxy localhost:3000\n}\n')).toBe(true)
  })

  it('changes a simple site in place, also its addresses', () => {
    const out = applyCaddyChange(FILE, { kind: 'site', previous: 'jellyfin.home.example', addresses: ['tv.home.example'], upstreams: ['localhost:8097'] })
    expect(out).toContain('tv.home.example {\n\treverse_proxy localhost:8097\n}\n\na.example.com')
    expect(out).not.toContain('jellyfin')
    expect(out.replace('tv.home.example {\n\treverse_proxy localhost:8097\n}', '')).toBe(FILE.replace('jellyfin.home.example {\n\treverse_proxy localhost:8096\n}', ''))
  })

  it('deletes a site without leaving a gap', () => {
    const out = applyCaddyChange(FILE, { kind: 'delete', address: 'b.example.com' })
    expect(out).not.toContain('a.example.com')
    expect(out).not.toMatch(/\n\n\n/)
    expect(out).toContain('ha.home.example')
  })

  it('refuses duplicates, custom blocks and bad input', () => {
    expect(() => applyCaddyChange(FILE, { kind: 'site', addresses: ['ha.home.example'], upstreams: ['x:1'] })).toThrow(/gibt es schon \(Zeile 20\)/)
    expect(() => applyCaddyChange(FILE, { kind: 'site', previous: 'secret.example.com', addresses: ['secret.example.com'], upstreams: ['x:1'] })).toThrow(/im Text bearbeiten/)
    expect(() => applyCaddyChange(FILE, { kind: 'site', addresses: ['bad domain'], upstreams: ['x:1'] })).toThrow(/keine gültige Adresse/)
    expect(() => applyCaddyChange(FILE, { kind: 'site', addresses: ['ok.example.com'], upstreams: ['nohost'] })).toThrow(/kein gültiges Ziel/)
    expect(() => applyCaddyChange(FILE, { kind: 'delete', address: 'nope.example.com' })).toThrow(/steht nicht/)
    expect(() => parseCaddyChange({ kind: 'site', addresses: 'x' })).toThrow()
  })
})

describe('site options', () => {
  const HASH = '$2b$12$' + 'a'.repeat(53)

  it('reads the options the dialog knows and keeps the rest', () => {
    const ha = parseCaddyfile(FILE).blocks.find((b) => b.addresses[0] === 'ha.home.example')!
    expect(ha.options).toEqual({ ...NO_OPTIONS, proxyExtra: 'header_up X-Real-IP {remote_host}' })
    const block = `nas.lan {
	tls internal
	@outside not remote_ip private_ranges
	respond @outside 403
	basic_auth {
		anna ${HASH}
	}
	encode gzip zstd
	# the UI over HTTPS
	reverse_proxy https://192.168.1.5:8006 {
		transport http {
			tls_insecure_skip_verify
		}
	}
	header Strict-Transport-Security max-age=31536000
}`
    expect(siteForm(block)).toEqual({
      upstreams: ['https://192.168.1.5:8006'],
      options: { lanOnly: true, compress: true, insecureTls: true, tlsInternal: true, auth: { user: 'anna', hash: HASH }, proxyExtra: '', extra: '# the UI over HTTPS\nheader Strict-Transport-Security max-age=31536000' },
    })
    // written back: the same options again
    const again = renderSite(['nas.lan'], ['https://192.168.1.5:8006'], siteForm(block)!.options)
    expect(siteForm(again)).toEqual(siteForm(block))
    expect(again).toContain('\treverse_proxy https://192.168.1.5:8006 {\n\t\ttransport http {\n\t\t\ttls_insecure_skip_verify\n\t\t}\n\t}')
  })

  it('leaves blocks with matchers or several targets to text editing', () => {
    expect(siteForm('a.example.com {\n\treverse_proxy /api/* api:1\n\treverse_proxy web:2\n}')).toBeUndefined()
    expect(siteForm('a.example.com {\n\tfile_server\n}')).toBeUndefined()
    // only half of the LAN rule: kept as it is
    expect(siteForm('a.example.com {\n\t@x not remote_ip private_ranges\n\treverse_proxy a:1\n}')!.options).toMatchObject({ lanOnly: false, extra: '@x not remote_ip private_ranges' })
  })

  it('writes the options into the file, checks them', () => {
    const out = applyCaddyChange(FILE, { kind: 'site', previous: 'ha.home.example', addresses: ['ha.home.example'], upstreams: ['192.168.1.30:8123'], options: { ...NO_OPTIONS, lanOnly: true, compress: true, proxyExtra: 'header_up X-Real-IP {remote_host}' } })
    expect(out).toContain('ha.home.example {\n\t@outside not remote_ip private_ranges\n\trespond @outside 403\n\tencode zstd gzip\n\treverse_proxy 192.168.1.30:8123 {\n\t\theader_up X-Real-IP {remote_host}\n\t}\n}')
    expect(() => applyCaddyChange(FILE, { kind: 'site', addresses: ['x.example.com'], upstreams: ['x:1'], options: { ...NO_OPTIONS, auth: { user: 'a b', password: 'long-enough' } } })).toThrow(/Benutzername/)
    expect(() => applyCaddyChange(FILE, { kind: 'site', addresses: ['x.example.com'], upstreams: ['x:1'], options: { ...NO_OPTIONS, auth: { user: 'anna', password: 'short' } } })).toThrow(/8 Zeichen/)
    expect(() => applyCaddyChange(FILE, { kind: 'site', addresses: ['x.example.com'], upstreams: ['x:1'], options: { ...NO_OPTIONS, extra: 'header {' } })).toThrow(/Klammern/)
    expect(parseCaddyChange({ kind: 'site', addresses: ['a'], upstreams: ['b:1'], options: { lanOnly: true, auth: { user: 'u', password: 'p' } } })).toMatchObject({ options: { lanOnly: true, compress: false, auth: { user: 'u', password: 'p' } } })
  })

  it('edits one block as text, nothing else', () => {
    const out = applyCaddyChange(FILE, { kind: 'block', address: 'secret.example.com', text: 'secret.example.com {\n\treverse_proxy localhost:9001\n}' })
    expect(out).toContain('secret.example.com {\n\treverse_proxy localhost:9001\n}')
    expect(out.replace(/secret\.example\.com \{[\s\S]*$/, '')).toBe(FILE.replace(/secret\.example\.com \{[\s\S]*$/, ''))
    expect(() => applyCaddyChange(FILE, { kind: 'block', address: 'secret.example.com', text: 'a.com {\n}\nb.com {\n}' })).toThrow(/Genau ein Eintrag/)
    expect(() => applyCaddyChange(FILE, { kind: 'block', address: 'secret.example.com', text: 'jellyfin.home.example {\n\treverse_proxy x:1\n}' })).toThrow(/gibt es schon/)
  })
})

describe('finding the Caddyfile', () => {
  it('maps the path inside the container through Volume=', () => {
    const q = caddyFromQuadlet(
      'caddy.container',
      '[Container]\nContainerName=caddy\nImage=docker.io/library/caddy:latest\nVolume=/home/tristan/docker/caddy/Caddyfile:/etc/caddy/Caddyfile:ro\nVolume=/home/tristan/docker/caddy/data:/data\nNetwork=host\n',
    )
    expect(q).toMatchObject({ container: 'caddy', containerPath: '/etc/caddy/Caddyfile', hostPath: '/home/tristan/docker/caddy/Caddyfile' })
  })

  it('follows a mounted directory, Exec= and named volumes', () => {
    expect(caddyFromQuadlet('web.container', '[Container]\nImage=caddy:2\nVolume=/srv/caddy:/etc/caddy:Z\n')).toMatchObject({ container: 'systemd-web', hostPath: '/srv/caddy/Caddyfile' })
    expect(caddyFromQuadlet('c.container', '[Container]\nImage=caddy\nExec=caddy run --config /conf/main.caddyfile --adapter caddyfile\nVolume=/opt/proxy:/conf\n')?.hostPath).toBe('/opt/proxy/main.caddyfile')
    expect(caddyFromQuadlet('c.container', '[Container]\nImage=caddy\nVolume=caddy-config:/etc/caddy\n')).toMatchObject({ hostPath: undefined, volume: { name: 'caddy-config', rest: '/Caddyfile' } })
    expect(caddyFromQuadlet('c.container', '[Container]\nImage=caddy\nVolume=/srv/data:/data\n')?.hostPath).toBeUndefined()
    expect(caddyFromQuadlet('j.container', '[Container]\nImage=jellyfin/jellyfin\n')).toBeUndefined()
  })

  it('recognises Caddy images and config flags', () => {
    expect(['caddy', 'docker.io/library/caddy:2', 'ghcr.io/x/caddy-cloudflare:latest', 'caddy@sha256:abc'].every(isCaddyImage)).toBe(true)
    expect(['lucaslorentz/caddy-docker-proxy', 'nginx', 'caddyfile-linter'].some(isCaddyImage)).toBe(false)
    expect(configFromCommand('/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile')).toEqual({ path: '/etc/caddy/Caddyfile', json: false })
    expect(configFromCommand('caddy run --config=/etc/caddy/caddy.json').json).toBe(true)
  })

  it('checks a path picked by hand', () => {
    expect(manualPathProblem('/home/me/Caddyfile')).toBeUndefined()
    expect(manualPathProblem('/srv/sites.caddyfile')).toBeUndefined()
    expect(manualPathProblem('relative/Caddyfile')).toBeDefined()
    expect(manualPathProblem('/etc/shadow')).toBeDefined()
    expect(manualPathProblem('/proc/1/Caddyfile')).toBeDefined()
  })
})

/** A host where every step can be scripted. */
function scripted(over: Partial<CaddyHost> = {}): CaddyHost & { files: Map<string, string>; calls: string[] } {
  const files = new Map<string, string>([['/home/t/caddy/Caddyfile', 'a.example.com {\n\treverse_proxy localhost:1\n}\n']])
  const calls: string[] = []
  let manual: string | undefined
  const revs: string[] = []
  const host: CaddyHost & { files: Map<string, string>; calls: string[] } = {
    files,
    calls,
    envPath: () => undefined,
    manualPath: () => manual,
    setManualPath: (p) => (manual = p),
    read: (p) => files.get(p),
    isFile: (p) => files.has(p),
    write: (p, c) => {
      calls.push(`write ${c.length}`)
      files.set(p, c)
    },
    quadlets: () => [{ name: 'caddy.container', content: '[Container]\nContainerName=caddy\nImage=docker.io/library/caddy:latest\nVolume=/home/t/caddy/Caddyfile:/etc/caddy/Caddyfile:ro\n' }],
    service: async () => undefined,
    volumePath: async () => undefined,
    api: async () => true,
    apiAdapt: async () => (calls.push('adapt'), undefined),
    apiLoad: async () => (calls.push('load'), undefined),
    containerRunning: async () => true,
    validateInImage: async () => (calls.push('image'), undefined),
    validateOnHost: async () => 'unavailable',
    execReload: async () => (calls.push('exec'), undefined),
    serviceReload: async () => undefined,
    history: { list: () => revs.map((_, i) => ({ id: `${i}`, date: i, message: 'x' })), read: (_p, id) => revs[Number(id)]!, saved: (_p, b, a) => void revs.push(b ?? '', a) },
    ...over,
  }
  return host
}

describe('CaddyManager', () => {
  it('finds the file of the Quadlet and saves: check, history, write, reload', async () => {
    const host = scripted()
    const m = new CaddyManager(host)
    const s = await m.caddyState()
    expect(s.source).toMatchObject({ how: 'quadlet', path: '/home/t/caddy/Caddyfile', container: 'caddy' })
    expect(s.reload).toBe('api')
    const r = await m.applyCaddy({ kind: 'site', addresses: ['b.example.com'], upstreams: ['localhost:2'] }, s.hash)
    expect(host.calls).toEqual(['adapt', expect.stringMatching(/^write/), 'load'])
    expect(r.reloaded).toBe('api')
    expect(r.state.blocks.map((b) => b.addresses[0])).toEqual(['a.example.com', 'b.example.com'])
  })

  it('refuses when Caddy rejects it or the file changed in between – nothing written', async () => {
    const host = scripted({ apiAdapt: async () => 'Caddyfile:2 - unrecognized directive: reverse_prox' })
    const m = new CaddyManager(host)
    await expect(m.applyCaddy({ kind: 'text', content: 'a {\n\treverse_prox x:1\n}\n' }, undefined)).rejects.toThrow(/lehnt die Datei ab.*unrecognized directive/)
    await expect(new CaddyManager(scripted()).applyCaddy({ kind: 'delete', address: 'a.example.com' }, contentHash('old'))).rejects.toThrow(/inzwischen geändert/)
    expect(host.calls.some((c) => c.startsWith('write'))).toBe(false)
  })

  it('restores the old file when the reload fails', async () => {
    const host = scripted({ apiLoad: async () => 'loading new config: tls: bad certificate' })
    const before = host.files.get('/home/t/caddy/Caddyfile')
    await expect(new CaddyManager(host).applyCaddy({ kind: 'delete', address: 'a.example.com' }, undefined)).rejects.toThrow(/alte Datei ist wiederhergestellt/)
    expect(host.files.get('/home/t/caddy/Caddyfile')).toBe(before)
  })

  it('without the API: checks in the image, reloads in the container; stopped Caddy only saves', async () => {
    const host = scripted({ api: async () => false })
    const r = await new CaddyManager(host).applyCaddy({ kind: 'delete', address: 'a.example.com' }, undefined)
    expect(host.calls).toEqual(['image', expect.stringMatching(/^write/), 'exec'])
    expect(r.reloaded).toBe('container')
    const stopped = scripted({ api: async () => false, containerRunning: async () => false })
    const r2 = await new CaddyManager(stopped).applyCaddy({ kind: 'delete', address: 'a.example.com' }, undefined)
    expect(r2.reloaded).toBe('none')
    expect(r2.warning).toMatch(/läuft gerade nicht/)
  })

  it('explains a Quadlet without mount, and takes a path picked by hand', async () => {
    const host = scripted({ quadlets: () => [{ name: 'caddy.container', content: '[Container]\nImage=caddy:2\n' }] })
    const m = new CaddyManager(host)
    expect((await m.caddyState()).problem).toMatch(/steckt im Image.*Volume=/)
    await expect(m.setCaddyPath('/etc/passwd')).rejects.toThrow(/Caddyfile/)
    const s = await m.setCaddyPath('/home/t/caddy/Caddyfile')
    expect(s.source).toMatchObject({ how: 'manual' })
    expect((await m.setCaddyPath(null)).source).toBeUndefined()
  })

  it('demo host: a broken file is refused, a good one goes live', async () => {
    const m = new CaddyManager(new FixtureCaddyHost('fixtures/demo'))
    const s = await m.caddyState()
    expect(s.source).toMatchObject({ how: 'quadlet', path: '/etc/caddy/Caddyfile' })
    expect(s.blocks.filter((b) => b.kind === 'proxy')).toHaveLength(7)
    await expect(m.applyCaddy({ kind: 'text', content: s.content + '\nbroken.example.com {\n' }, s.hash)).rejects.toThrow(/lehnt die Datei ab/)
    const r = await m.applyCaddy({ kind: 'site', addresses: ['new.home.example'], upstreams: ['localhost:9000'] }, s.hash)
    expect(r.state.history).toHaveLength(2)
    // A password from the dialog is stored as a bcrypt hash only.
    const p = await m.applyCaddy({ kind: 'site', addresses: ['priv.home.example'], upstreams: ['localhost:9001'], options: { ...NO_OPTIONS, auth: { user: 'anna', password: 'very-secret-1' } } }, r.state.hash)
    const block = p.state.blocks.find((b) => b.addresses[0] === 'priv.home.example')!
    expect(p.state.content).not.toContain('very-secret-1')
    expect(await Bun.password.verify('very-secret-1', block.options!.auth!.hash!)).toBe(true)
  })
})

describe('SystemCaddyHost', () => {
  it('writes in place: same inode, so a single-file bind mount sees the change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caddy-'))
    const f = join(dir, 'Caddyfile')
    writeFileSync(f, 'a long first version of the file\n')
    const ino = statSync(f).ino
    new SystemCaddyHost('http://127.0.0.1:1', dir, join(dir, 'state.json'), join(dir, 'hist')).write(f, 'short\n')
    expect(statSync(f).ino).toBe(ino)
    expect(readFileSync(f, 'utf8')).toBe('short\n')
  })
})
