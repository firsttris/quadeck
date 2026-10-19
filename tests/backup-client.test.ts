import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SystemBackup } from '~/server/backup/backend'
import { localCa } from '~/server/caddy/backend'
import { run } from '~/server/exec'
import type { AgentKind } from '~/shared/backup-agent'
import {
  CA_TMP,
  type ClientPlan,
  clientCalendar,
  clientCommand,
  clientExcludes,
  clientForgetArgs,
  clientScript,
  defaultClientPlan,
  parseClientPlan,
  reviewCommands,
  ruleKind,
  ruleProblem,
  setupCommand,
  sq,
} from '~/shared/backup-client'

const plan = (over: Partial<ClientPlan> = {}): ClientPlan => ({ ...defaultClientPlan(), ...over })

describe('client plan', () => {
  it('accepts home and absolute folders', () => {
    const { plan: p, error } = parseClientPlan({ ...plan(), folders: ['~/Dokumente', '~', '/etc/nginx', '~/Dokumente'] })
    expect(error).toBeUndefined()
    expect(p!.folders).toEqual(['~/Dokumente', '~', '/etc/nginx'])
  })
  it.each([
    ['relative', ['Dokumente']],
    ['root', ['/']],
    ['dot-dot', ['~/../etc']],
    ['trailing slash', ['~/a/']],
    ['double slash', ['~//a']],
    ['newline', ['~/a\nb']],
    ['none', []],
    ['~user', ['~bob/x']],
  ])('refuses %s folders', (_n, folders) => {
    expect(parseClientPlan({ ...plan(), folders }).error).toBeTruthy()
  })
  it('refuses bad schedules, retention and patterns', () => {
    expect(parseClientPlan({ ...plan(), schedule: { every: 'minutely', time: '12:00' } }).error).toBeTruthy()
    expect(parseClientPlan({ ...plan(), keep: { daily: 0, weekly: 0, monthly: 0 } }).error).toBeTruthy()
    expect(parseClientPlan({ ...plan(), keep: { daily: 0, weekly: 0, monthly: 0, yearly: 5 } }).plan?.keep).toEqual({ daily: 0, weekly: 0, monthly: 0, yearly: 5 })
    expect(parseClientPlan({ ...plan(), keep: { daily: 7, weekly: 0, monthly: 0, yearly: -2 } }).error).toBeTruthy()
    expect(clientForgetArgs(plan({ keep: { daily: 7, weekly: 4, monthly: 12, yearly: 10 } }))).toBe('--keep-daily 7 --keep-weekly 4 --keep-monthly 12 --keep-yearly 10')
    expect(parseClientPlan({ ...plan(), exclude: { presets: [], patterns: ['a\nb'] } }).error).toBeTruthy()
  })
  it('calendar and excludes', () => {
    expect(clientCalendar({ every: 'hourly', time: '12:15' })).toBe('*-*-* *:15:00')
    expect(clientCalendar({ every: '6h', time: '09:30' })).toBe('*-*-* 3/6:30:00')
    expect(clientCalendar({ every: 'daily', time: '12:00' })).toBe('*-*-* 12:00:00')
    expect(clientCalendar({ every: 'weekly', time: '20:00' })).toBe('Sun *-*-* 20:00:00')
    expect(clientExcludes(plan({ exclude: { presets: ['caches', 'downloads'], patterns: ['*.mkv'] } }))).toEqual(['~/.cache', '~/Downloads', '*.mkv'])
  })
  it('own exclusions: what kind a rule is, and rules that would leave out everything', () => {
    expect(ruleKind('*.mkv')).toBe('type')
    expect(ruleKind('**/build')).toBe('pattern')
    expect(ruleKind('*.tar.gz')).toBe('type')
    expect(ruleKind('~/Videos/Aufnahmen')).toBe('path')
    expect(ruleKind('cache?')).toBe('pattern')
    for (const bad of ['', '/', '~', '*', '**', '~/*', 'a\nb', 'x'.repeat(301)]) expect(ruleProblem(bad), JSON.stringify(bad)).toBe(true)
    for (const ok of ['*.iso', '**/.git', '~/Videos', 'node_modules']) expect(ruleProblem(ok), ok).toBe(false)
  })
  it('sh quoting survives any text', async () => {
    for (const s of ["it's", 'a"b$c`d\\e', '$(rm -rf /)', ' spaced ']) {
      const r = await run(['sh', '-c', `printf %s ${sq(s)}`])
      expect(r.stdout).toBe(s)
    }
  })
})

const input = (over: Partial<Parameters<typeof clientScript>[0]> = {}) => ({
  name: 'laptop',
  repo: 'rest:http://nas.lan:8000/laptop/',
  user: 'laptop',
  access: 'Abc23xyz',
  appendOnly: false,
  plan: plan(),
  version: 3,
  quadeckUrl: 'http://nas.lan:8484',
  ...over,
})

describe('client script', () => {
  it('is valid sh, both the setup and the installed command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qd-sh-'))
    writeFileSync(
      join(dir, 'setup.sh'),
      clientScript(input({ plan: plan({ folders: ["~/Bob's files", '~/a b'], exclude: { presets: ['caches', 'nobackup'], patterns: ['*.$weird'], maxSizeGB: 2 } }) })),
    )
    writeFileSync(join(dir, 'cmd.sh'), clientCommand())
    writeFileSync(join(dir, 'noplan.sh'), clientScript(input({ plan: undefined, agentToken: 'a'.repeat(32) })))
    for (const f of ['setup.sh', 'noplan.sh', 'cmd.sh']) expect((await run(['sh', '-n', join(dir, f)])).code).toBe(0)
    const text = clientScript(input())
    expect(text).toContain("RESTIC_REPOSITORY='rest:http://nas.lan:8000/laptop/'")
    expect(text).toContain("CALENDAR='*-*-* 12:00:00'")
    expect(text).not.toContain('QUADECK_REPO_PASSWORD=') // the repository password never comes from the server
  })
})

describe('client script without restic or a reachable Quadeck', () => {
  // A PATH with only what the script needs before the restic check, plus the given stand-ins.
  const bare = (tools: string[]) => {
    const root = mkdtempSync(join(tmpdir(), 'qd-bare-'))
    const bin = join(root, 'bin')
    mkdirSync(bin)
    symlinkSync(Bun.which('id')!, join(bin, 'id'))
    for (const t of tools) {
      writeFileSync(join(bin, t), '#!/bin/sh\nexit 0\n')
      chmodSync(join(bin, t), 0o755)
    }
    writeFileSync(join(root, 'setup.sh'), clientScript(input()))
    return run(['/bin/sh', join(root, 'setup.sh')], { env: { HOME: root, PATH: bin, QUADECK_ALLOW_ROOT: '1' } })
  }
  it('says how to install restic: brew first, else the package manager', async () => {
    const brew = await bare(['brew', 'apt-get'])
    expect(brew.code).not.toBe(0)
    expect(brew.stderr).toContain('install it first: brew install restic')
    if (existsSync('/run/ostree-booted')) return
    expect((await bare(['apt-get'])).stderr).toContain('install it first: sudo apt install restic')
    expect((await bare([])).stderr).toContain('restic is not installed\n')
  })

  it("says when this computer does not trust Quadeck's certificate", async () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-tls-'))
    const conf = join(root, '.config/quadeck-backup')
    const bin = join(root, 'bin')
    mkdirSync(conf, { recursive: true })
    mkdirSync(bin)
    writeFileSync(join(conf, 'env'), "QUADECK_NAME='laptop'\nQUADECK_VERSION=1\nQUADECK_URL='https://nas.lan'\nQUADECK_TOKEN='tok'\n")
    writeFileSync(join(root, 'cmd.sh'), clientCommand())
    const curl = (code: number) => {
      writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" > "${root}/curl-args"\necho "curl: (${code}) some error" >&2\nexit ${code}\n`)
      chmodSync(join(bin, 'curl'), 0o755)
      return run(['sh', join(root, 'cmd.sh'), 'plan', 'show'], { env: { HOME: root, XDG_CONFIG_HOME: '', PATH: `${bin}:${process.env.PATH}` } })
    }
    const tls = await curl(60)
    expect(tls.code).not.toBe(0)
    expect(tls.stderr).toContain("does not trust Quadeck's certificate at https://nas.lan")
    expect(tls.stderr).toContain('run the setup command from Quadeck once more (Backups → Clients → laptop → Show command)')
    expect(readFileSync(join(root, 'curl-args'), 'utf8')).not.toContain('--cacert')
    expect((await curl(7)).stderr).toContain('cannot reach Quadeck at https://nas.lan')
    // With Caddy's CA from the setup: every call trusts it; a failure means the CA changed.
    writeFileSync(join(conf, 'ca.crt'), ROOT)
    const changed = await curl(60)
    expect(readFileSync(join(root, 'curl-args'), 'utf8')).toMatch(new RegExp(`^--cacert ${conf}/ca.crt -sS `))
    expect(changed.stderr).toContain(`no longer comes from the CA stored in ${conf}/ca.crt`)
  })
})

const ROOT = readFileSync('tests/fixtures/caddy-root.crt', 'utf8')
const hasOpenssl = !!Bun.which('openssl')

/** A CA and a certificate from it for 127.0.0.1, like Caddy's `tls internal`. */
async function testCa() {
  const d = mkdtempSync(join(tmpdir(), 'qd-ca-'))
  const ossl = async (...args: string[]) => expect((await run(['openssl', ...args], { timeoutMs: 30_000 })).code).toBe(0)
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes']
  await ossl('req', '-x509', ...ec, '-keyout', join(d, 'ca.key'), '-out', join(d, 'ca.crt'), '-days', '2', '-subj', '/CN=Test Local Authority')
  await ossl('req', ...ec, '-keyout', join(d, 'leaf.key'), '-out', join(d, 'leaf.csr'), '-subj', '/CN=127.0.0.1')
  writeFileSync(join(d, 'ext'), 'subjectAltName=IP:127.0.0.1\n')
  await ossl(
    'x509',
    '-req',
    '-in',
    join(d, 'leaf.csr'),
    '-CA',
    join(d, 'ca.crt'),
    '-CAkey',
    join(d, 'ca.key'),
    '-CAcreateserial',
    '-out',
    join(d, 'leaf.crt'),
    '-days',
    '2',
    '-extfile',
    join(d, 'ext'),
  )
  return { ca: readFileSync(join(d, 'ca.crt'), 'utf8'), cert: readFileSync(join(d, 'leaf.crt'), 'utf8'), key: readFileSync(join(d, 'leaf.key'), 'utf8') }
}
// curl straight to 127.0.0.1, not through a proxy of the test machine
const NO_PROXY = { NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '' }

describe("setup command with Caddy's local CA", () => {
  const sha = 'ab'.repeat(32)

  it('without a CA: as before; with one: fetch, check, then trust it', () => {
    expect(setupCommand('http://nas.lan:8484', 'tok')).toBe('curl -fsSL http://nas.lan:8484/api/backup/script/tok | sh')
    expect(setupCommand('https://quadeck.lan', 'tok', { sha256: sha })).toBe(
      `curl -fsSLk https://quadeck.lan/ca.crt -o /tmp/quadeck-ca.crt && echo "${sha}  /tmp/quadeck-ca.crt" | sha256sum -c && curl -fsSL --cacert /tmp/quadeck-ca.crt https://quadeck.lan/api/backup/script/tok | sh`,
    )
    expect(reviewCommands('http://nas.lan', 'tok')).toBe('curl -fsSL http://nas.lan/api/backup/script/tok -o quadeck-backup-setup.sh\nless quadeck-backup-setup.sh\nsh quadeck-backup-setup.sh')
    expect(reviewCommands('https://quadeck.lan', 'tok', { sha256: sha }).split('\n')).toEqual([
      'curl -fsSLk https://quadeck.lan/ca.crt -o /tmp/quadeck-ca.crt',
      `echo "${sha}  /tmp/quadeck-ca.crt" | sha256sum -c`,
      'curl -fsSL --cacert /tmp/quadeck-ca.crt https://quadeck.lan/api/backup/script/tok -o quadeck-backup-setup.sh',
      'less quadeck-backup-setup.sh',
      'sh quadeck-backup-setup.sh',
    ])
  })

  it('the script brings the CA along; restic gets it only for a repository served with it', async () => {
    const withCa = clientScript(input({ quadeckUrl: 'https://quadeck.lan', ca: ROOT }))
    expect(withCa).toContain(`CA=${sq(ROOT)}`)
    expect(withCa).not.toContain('RESTIC_CACERT')
    const both = clientScript(input({ quadeckUrl: 'https://quadeck.lan', repo: 'rest:https://quadeck.lan:8000/laptop/', ca: ROOT, resticCa: true }))
    expect(both).toContain('RESTIC_CACERT="$CONF/ca.crt"')
    expect(clientScript(input())).toContain("CA=''")
    const dir = mkdtempSync(join(tmpdir(), 'qd-sh-'))
    writeFileSync(join(dir, 'ca.sh'), both)
    expect((await run(['sh', '-n', join(dir, 'ca.sh')])).code).toBe(0)
  })

  it('a setup link carries the CA when Caddy serves its address with it, and tells restic when the repository is served so too', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-link-'))
    const b = new SystemBackup({ dir: join(root, 'state'), unitDir: join(root, 'units'), exec: run, log: () => {} })
    await b.saveTarget({ dataDir: join(root, 'backups'), port: 8000, appendOnly: false, url: 'https://quadeck.lan:8000' })
    await b.addClient('laptop', 3)
    const ca = localCa(ROOT)
    const plain = await b.clientLink('laptop', 'http://nas.lan:8484', async () => undefined)
    expect(plain.ca).toBeUndefined()
    expect(await b.redeemClientLink(plain.token)).toContain("CA=''")
    const link = await b.clientLink('laptop', 'https://quadeck.lan', async (u) => (u.startsWith('https://quadeck.lan') ? ca : undefined))
    expect(link.ca).toEqual({ sha256: ca.sha256, fingerprint: ca.fingerprint })
    const script = (await b.redeemClientLink(link.token))!
    expect(script).toContain(`CA=${sq(ROOT)}`)
    expect(script).toContain('RESTIC_CACERT="$CONF/ca.crt"')
    // the repository with a public certificate: restic keeps the system's CAs
    const onlyQuadeck = await b.clientLink('laptop', 'https://quadeck.lan', async (u) => (u === 'https://quadeck.lan' ? ca : undefined))
    expect(await b.redeemClientLink(onlyQuadeck.token)).not.toContain('RESTIC_CACERT')
  })

  it.skipIf(!hasOpenssl)(
    'runs in sh, bash and fish; a CA with another fingerprint stops it before anything runs',
    async () => {
      const t = await testCa()
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        tls: { cert: t.cert, key: t.key },
        fetch: (req) => {
          const path = new URL(req.url).pathname
          if (path === '/ca.crt') return new Response(t.ca)
          if (path === '/api/backup/script/tok') return new Response('#!/bin/sh\necho "script ran in $0"\n')
          return new Response('not found', { status: 404 })
        },
      })
      const origin = `https://127.0.0.1:${server.port}`
      const good = { sha256: localCa(t.ca).sha256 }
      const dir = mkdtempSync(join(tmpdir(), 'qd-review-'))
      try {
        for (const shell of ['sh', 'dash', 'bash', 'fish'].filter((x) => Bun.which(x))) {
          rmSync(CA_TMP, { force: true })
          const ok = await run([shell, '-c', setupCommand(origin, 'tok', good)], { env: NO_PROXY, timeoutMs: 30_000 })
          expect(ok.stdout, `${shell}: ${ok.stderr}`).toContain('script ran in sh')
          rmSync(CA_TMP, { force: true })
          const bad = await run([shell, '-c', setupCommand(origin, 'tok', { sha256: 'ab'.repeat(32) })], { env: NO_PROXY, timeoutMs: 30_000 })
          expect(bad.code, shell).not.toBe(0)
          expect(bad.stdout).not.toContain('script ran')
          // Review first: the same steps, the script only read (cat instead of less) before it runs.
          rmSync(join(dir, 'quadeck-backup-setup.sh'), { force: true })
          const review = reviewCommands(origin, 'tok', good).replace('less ', 'cat ')
          const r = await run([shell, '-c', `cd ${dir} && ${review.replace(/\n/g, ' && ')}`], { env: NO_PROXY, timeoutMs: 30_000 })
          expect(r.stdout, `${shell}: ${r.stderr}`).toContain('script ran in quadeck-backup-setup.sh')
        }
        // Without the CA the script is not fetched at all.
        expect((await run(['sh', '-c', `curl -fsSL ${origin}/api/backup/script/tok | sh`], { env: NO_PROXY, timeoutMs: 30_000 })).stdout).not.toContain('script ran')
      } finally {
        server.stop(true)
        rmSync(CA_TMP, { force: true })
      }
    },
    60_000,
  )
})

const hasRestic = !!Bun.which('restic')

describe.skipIf(!hasRestic)('client script on a (sandboxed) computer', () => {
  const sandbox = () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-client-'))
    const home = join(root, 'home')
    const bin = join(root, 'bin')
    mkdirSync(join(home, 'Dokumente/node_modules/pkg'), { recursive: true })
    mkdirSync(join(home, 'Bilder'), { recursive: true })
    mkdirSync(join(home, '.cache'), { recursive: true })
    writeFileSync(join(home, 'Dokumente/brief.txt'), 'Hallo')
    writeFileSync(join(home, 'Dokumente/upload.tmp'), 'temp')
    writeFileSync(join(home, 'Dokumente/node_modules/pkg/index.js'), 'x')
    writeFileSync(join(home, 'Bilder/foto.jpg'), 'jpg')
    mkdirSync(join(home, "Bob's Fotos"))
    writeFileSync(join(home, "Bob's Fotos/x.jpg"), 'x')
    mkdirSync(bin)
    // systemctl/journalctl stand-ins: record the calls.
    for (const t of ['systemctl', 'journalctl']) {
      writeFileSync(join(bin, t), `#!/bin/sh\necho "${t} $*" >> "${root}/calls"\ncase "$*" in *start*quadeck-backup.service*) exec "$HOME/.local/bin/quadeck-backup" run ;; esac\nexit 0\n`)
      chmodSync(join(bin, t), 0o755)
    }
    const env = { HOME: home, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: '', QUADECK_REPO_PASSWORD: 'client-secret', QUADECK_ALLOW_ROOT: '1', RESTIC_CACHE_DIR: join(root, 'cache') }
    const script = (p: ClientPlan, version = 1) => {
      writeFileSync(join(root, 'setup.sh'), clientScript(input({ repo: join(root, 'repo'), plan: p, version })))
      return run(['sh', join(root, 'setup.sh')], { env, timeoutMs: 60_000 })
    }
    const restic = (...args: string[]) =>
      run(['restic', ...args], { env: { ...env, RESTIC_REPOSITORY: join(root, 'repo'), RESTIC_PASSWORD_FILE: join(home, '.config/quadeck-backup/password') }, timeoutMs: 60_000 })
    return { root, home, env, script, restic, calls: () => (existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8') : '') }
  }

  it('installs, backs up with the exclusions, updates without touching the password', async () => {
    const s = sandbox()
    // XDG_CONFIG_HOME empty: falls back to ~/.config
    const r = await s.script(plan({ folders: ['~/Dokumente', '~/Bilder', "~/Bob's Fotos", '~/gone'] }))
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const conf = join(s.home, '.config/quadeck-backup')
    expect(statSync(conf).mode & 0o777).toBe(0o700)
    expect(statSync(join(conf, 'env')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(conf, 'password'), 'utf8')).toBe('client-secret\n')
    expect(readFileSync(join(conf, 'folders'), 'utf8')).toBe(`${s.home}/Dokumente\n${s.home}/Bilder\n${s.home}/Bob's Fotos\n${s.home}/gone\n`)
    expect(readFileSync(join(conf, 'excludes'), 'utf8')).toContain(`${s.home}/.cache`)
    expect(existsSync(join(s.root, 'repo/config'))).toBe(true)
    expect(readFileSync(join(s.home, '.config/systemd/user/quadeck-backup.timer'), 'utf8')).toContain('OnCalendar=*-*-* 12:00:00')
    expect(s.calls()).toContain('systemctl --user enable --now quadeck-backup.timer')

    const cmd = join(s.home, '.local/bin/quadeck-backup')
    const now = await run([cmd, 'now'], { env: s.env, timeoutMs: 60_000 })
    expect(now.code).toBe(0)
    const ls = await s.restic('ls', 'latest')
    expect(ls.stdout).toContain('/Dokumente/brief.txt')
    expect(ls.stdout).toContain('/Bilder/foto.jpg')
    expect(ls.stdout).toContain("/Bob's Fotos/x.jpg") // spaces and quotes survive
    expect(now.stderr + now.stdout).not.toContain('none of the folders') // a missing folder is only skipped
    expect(ls.stdout).not.toContain('upload.tmp') // temp preset
    expect(ls.stdout).not.toContain('node_modules') // dev preset
    const snaps = JSON.parse((await s.restic('snapshots', '--json')).stdout) as { tags: string[] }[]
    expect(snaps).toHaveLength(1)
    expect(snaps[0]!.tags).toEqual(['quadeck'])

    // check: the size without and with the exclusions, and what the next run would upload
    const check = await run([cmd, 'check'], { env: s.env, timeoutMs: 60_000 })
    expect(check.code).toBe(0)
    expect(check.stdout).toContain('Folders, without exclusions:')
    expect(check.stdout).toMatch(/Without exclusions: +\S+/)
    expect(check.stdout).toMatch(/Backed up: +\S+ in 3 files \(\S+ left out by the exclusions\)/) // brief.txt, foto.jpg, x.jpg
    expect(check.stdout).toMatch(/New on the next run: +\S+ to upload/) // only the new snapshot's metadata
    const files = await run([cmd, 'check', '--files'], { env: s.env, timeoutMs: 60_000 })
    expect(files.code).toBe(0)
    expect(files.stdout).toContain('brief.txt')
    expect(files.stdout).not.toContain('upload.tmp')

    // New settings: paused, another folder. The repository password stays.
    const r2 = await s.script(plan({ folders: ['~/Bilder'], active: false }), 2)
    expect(r2.code).toBe(0)
    expect(readFileSync(join(conf, 'password'), 'utf8')).toBe('client-secret\n')
    expect(readFileSync(join(conf, 'folders'), 'utf8')).toBe(`${s.home}/Bilder\n`)
    expect(readFileSync(join(conf, 'env'), 'utf8')).toContain('QUADECK_VERSION=2')
    expect(s.calls()).toContain('systemctl --user disable --now quadeck-backup.timer')
  }, 120_000)

  it('finds standard folders under the other language or where xdg-user-dirs puts them', async () => {
    const s = sandbox()
    // English names in the plan, German folders on the computer; Music moved by xdg-user-dirs
    mkdirSync(join(s.home, 'Medien/Lieder'), { recursive: true })
    writeFileSync(join(s.home, 'Medien/Lieder/song.mp3'), 'mp3')
    const bin = join(s.root, 'bin')
    writeFileSync(join(bin, 'xdg-user-dir'), `#!/bin/sh\ncase "$1" in MUSIC) echo "$HOME/Medien/Lieder" ;; *) echo "$HOME" ;; esac\n`)
    chmodSync(join(bin, 'xdg-user-dir'), 0o755)
    expect((await s.script(plan({ folders: ['~/Documents', '~/Pictures', '~/Music'] }))).code).toBe(0)
    const cmd = join(s.home, '.local/bin/quadeck-backup')
    expect((await run([cmd, 'run'], { env: s.env, timeoutMs: 60_000 })).code).toBe(0)
    const ls = (await s.restic('ls', 'latest')).stdout
    expect(ls).toContain('/Dokumente/brief.txt')
    expect(ls).toContain('/Bilder/foto.jpg')
    expect(ls).toContain('/Medien/Lieder/song.mp3')
  }, 120_000)

  it('stops when the password on the computer does not open the repository', async () => {
    const s = sandbox()
    expect((await s.script(plan())).code).toBe(0)
    writeFileSync(join(s.home, '.config/quadeck-backup/password'), 'wrong\n')
    const r = await s.script(plan(), 2)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('does not open it')
  }, 60_000)

  it('says so when the backup server cannot be reached, instead of waiting', async () => {
    const s = sandbox()
    writeFileSync(join(s.root, 'setup.sh'), clientScript(input({ repo: 'rest:http://127.0.0.1:1/laptop/' })))
    const r = await run(['sh', join(s.root, 'setup.sh')], { env: s.env, timeoutMs: 60_000 })
    expect(r.code).not.toBe(0)
    expect(r.stdout).toContain('Connecting to http://127.0.0.1:1/laptop/')
    expect(r.stderr).toContain('cannot reach the backup server at http://127.0.0.1:1/laptop/')
    expect(r.stderr).toContain('connection refused') // restic's own error
    expect(r.stderr).not.toContain('Creating the repository')
  }, 60_000)

  it('runs the restic the setup found, also without it on PATH', async () => {
    const s = sandbox()
    // restic in a folder only the setup's PATH has (like brew's), logging its calls
    const rbin = join(s.root, 'rbin')
    mkdirSync(rbin)
    writeFileSync(join(rbin, 'restic'), `#!/bin/sh\necho "$1" >> "${s.root}/restic-calls"\nexec ${Bun.which('restic')} "$@"\n`)
    chmodSync(join(rbin, 'restic'), 0o755)
    writeFileSync(join(s.root, 'setup.sh'), clientScript(input({ repo: join(s.root, 'repo') })))
    expect((await run(['sh', join(s.root, 'setup.sh')], { env: { ...s.env, PATH: `${rbin}:${s.env.PATH}` }, timeoutMs: 60_000 })).code).toBe(0)
    const conf = join(s.home, '.config/quadeck-backup')
    expect(readFileSync(join(conf, 'env'), 'utf8')).toContain(`QUADECK_RESTIC='${join(rbin, 'restic')}'`)
    const cmd = join(s.home, '.local/bin/quadeck-backup')
    expect((await run([cmd, 'run'], { env: s.env, timeoutMs: 60_000 })).code).toBe(0)
    expect(readFileSync(join(s.root, 'restic-calls'), 'utf8')).toContain('backup')
    // The stored one gone: restic from PATH.
    writeFileSync(join(conf, 'env'), readFileSync(join(conf, 'env'), 'utf8').replace(/QUADECK_RESTIC='[^']*'/, "QUADECK_RESTIC='/nonexistent/restic'"))
    expect((await run([cmd, 'run'], { env: s.env, timeoutMs: 60_000 })).code).toBe(0)
    // Running the setup again refreshes it.
    expect((await s.script(plan(), 2)).code).toBe(0)
    expect(readFileSync(join(conf, 'env'), 'utf8')).toContain(`QUADECK_RESTIC='${Bun.which('restic')}'`)
  }, 120_000)

  /** A Quadeck for the client: the agent endpoint of the route, on the helper's backend. */
  const quadeck = async (root: string, override?: { settings?: string }) => {
    mkdirSync(root, { recursive: true })
    const b = new SystemBackup({ dir: join(root, 'state'), unitDir: join(root, 'units'), exec: run, log: () => {} })
    await b.saveTarget({ dataDir: join(root, 'backups'), port: 8000, appendOnly: false, url: 'http://nas:8000' })
    await b.addClient('laptop', 3)
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url)
        const name = url.pathname.split('/').pop()!
        const kind = url.searchParams.get('do') as AgentKind
        if (override?.settings && kind === 'settings') return new Response(override.settings)
        try {
          const reply = await b.clientAgent(name, (req.headers.get('authorization') ?? '').slice(7), kind, req.method === 'POST' ? await req.text() : '')
          return 'text' in reply ? new Response(reply.text) : Response.json(reply.json)
        } catch (e) {
          return new Response((e as Error).message, { status: (e as { status?: number }).status ?? 500 })
        }
      },
    })
    const token = /QUADECK_TOKEN='([^']+)'/.exec((await b.redeemClientLink((await b.clientLink('laptop', 'http://x')).token))!)![1]!
    return { b, server, token, url: `http://127.0.0.1:${server.port}` }
  }
  const laptop = async (b: SystemBackup) => (await b.targetState()).clients.find((c) => c.name === 'laptop')!
  const until = async (ok: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await ok()); i++) await Bun.sleep(100)
  }

  it('talks to Quadeck: scan, new settings before a run, the run report, a plan from the client', async () => {
    const s = sandbox()
    const q = await quadeck(s.root)
    // curl's command line, as other users would see it in ps
    const realCurl = Bun.which('curl')!
    writeFileSync(join(s.root, 'bin/curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${s.root}/curl-args"\nexec ${realCurl} "$@"\n`)
    chmodSync(join(s.root, 'bin/curl'), 0o755)
    try {
      await q.b.setClientPlan('laptop', plan({ folders: ['~/Dokumente'] }))
      writeFileSync(join(s.root, 'setup.sh'), clientScript(input({ repo: join(s.root, 'repo'), plan: plan({ folders: ['~/Dokumente'] }), version: 1, agentToken: q.token, quadeckUrl: q.url })))
      const r = await run(['sh', join(s.root, 'setup.sh')], { env: s.env, timeoutMs: 60_000 })
      expect(r.code).toBe(0)
      // The setup sends the folder list in the background.
      await until(async () => (await q.b.clientInventory('laptop')) !== null)
      const inv = (await q.b.clientInventory('laptop'))!
      expect(inv.home).toBe(s.home)
      expect(inv.dirs.find((d) => d.path === '~/Dokumente/node_modules')?.marks).toEqual(['dev'])
      expect(inv.dirs.find((d) => d.path === '~/.cache')?.marks).toEqual(['caches'])

      // A change in Quadeck reaches the client before its next run, without a new script.
      // 0.5 GB: restic takes no fraction (0.5G fails), the client gets whole MiB.
      await q.b.setClientPlan('laptop', plan({ folders: ['~/Dokumente', '~/Bilder'], exclude: { presets: ['caches'], patterns: [], maxSizeGB: 0.5 }, schedule: { every: '6h', time: '01:30' } }))
      const cmd = join(s.home, '.local/bin/quadeck-backup')
      const ran = await run([cmd, 'run'], { env: s.env, timeoutMs: 60_000 })
      expect(ran.stderr).not.toContain('quadeck-backup:')
      expect(ran.code).toBe(0)
      const conf = join(s.home, '.config/quadeck-backup')
      expect(readFileSync(join(conf, 'folders'), 'utf8')).toBe(`${s.home}/Dokumente\n${s.home}/Bilder\n`)
      expect(readFileSync(join(conf, 'env'), 'utf8')).toContain('QUADECK_VERSION=2')
      expect(readFileSync(join(conf, 'env'), 'utf8')).toContain("QUADECK_FLAGS='--exclude-caches --exclude-larger-than 512M'")
      expect(readFileSync(join(s.home, '.config/systemd/user/quadeck-backup.timer'), 'utf8')).toContain('OnCalendar=*-*-* 1/6:30:00')
      const ls = (await s.restic('ls', 'latest')).stdout
      expect(ls).toContain('/Bilder/foto.jpg')
      expect(ls).toContain('node_modules') // dev is off now
      let c = await laptop(q.b)
      expect(c.applied?.version).toBe(2)
      expect(c.runs?.[0]).toMatchObject({ status: 'ok', files: 4 })

      // The plan as JSON, a draft tried without saving, then set from the client.
      const shown = JSON.parse((await run([cmd, 'plan', 'show'], { env: s.env })).stdout)
      expect(shown.plan.folders).toEqual(['~/Dokumente', '~/Bilder'])
      // The edited output of plan show, as the guide says.
      writeFileSync(join(s.root, 'draft.json'), JSON.stringify({ ...shown, plan: { ...shown.plan, folders: ['~/Bilder'], keep: { daily: 1, weekly: 0, monthly: 0 } } }))
      const check = await run([cmd, 'check', '--plan', join(s.root, 'draft.json'), '--json'], { env: s.env, timeoutMs: 60_000 })
      expect(check.code).toBe(0)
      expect(JSON.parse(check.stdout)).toMatchObject({ files: 1 })
      expect((await laptop(q.b)).version).toBe(2)
      const set = await run([cmd, 'plan', 'set', '-f', join(s.root, 'draft.json')], { env: s.env, timeoutMs: 60_000 })
      expect(set.code).toBe(0)
      c = await laptop(q.b)
      expect(c).toMatchObject({ version: 3, changed: { by: 'client' }, plan: { folders: ['~/Bilder'], keep: { daily: 7, weekly: 4, monthly: 12 } } }) // the retention stays Quadeck's
      expect(readFileSync(join(conf, 'folders'), 'utf8')).toBe(`${s.home}/Bilder\n`)
      // The guide as a skill for Claude Code, in the user's own skills.
      // Run by a bare name from its folder, which is not on PATH: the skill is still written.
      expect((await run(['sh', '-c', `cd "${join(s.home, '.local/bin')}" && sh quadeck-backup skill install`], { env: s.env })).code).toBe(0)
      expect(readFileSync(join(s.home, '.claude/skills/quadeck-backup/SKILL.md'), 'utf8')).toMatch(/^---\nname: quadeck-backup\ndescription: .+\n---\n\n# Setting up/)

      const args = readFileSync(join(s.root, 'curl-args'), 'utf8')
      expect(args).toContain('do=report')
      expect(args).not.toContain(q.token)

      // A wrong token: the client says so and backs up with what it has.
      writeFileSync(join(conf, 'env'), readFileSync(join(conf, 'env'), 'utf8').replace(/QUADECK_TOKEN='[^']+'/, `QUADECK_TOKEN='${'x'.repeat(32)}'`))
      const sync = await run([cmd, 'sync'], { env: s.env })
      expect(sync.code).not.toBe(0)
      expect(sync.stderr).toContain('401')
      const again = await run([cmd, 'run'], { env: s.env, timeoutMs: 60_000 })
      expect(again.code).toBe(0)
      expect(again.stderr).toContain('backing up with the last ones')
    } finally {
      q.server.stop(true)
    }
  }, 180_000)

  it('connects without a plan, then takes a plan and tasks from its agent timer (poll)', async () => {
    const s = sandbox()
    const q = await quadeck(s.root)
    try {
      writeFileSync(join(s.root, 'setup.sh'), clientScript(input({ repo: join(s.root, 'repo'), plan: undefined, version: 0, agentToken: q.token, quadeckUrl: q.url })))
      const r = await run(['sh', join(s.root, 'setup.sh')], { env: s.env, timeoutMs: 60_000 })
      expect(r.stderr).toBe('')
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('laptop is connected to Quadeck – no backup plan yet')
      expect(r.stdout).toContain('quadeck-backup guide')
      const conf = join(s.home, '.config/quadeck-backup')
      const units = join(s.home, '.config/systemd/user')
      expect(readFileSync(join(conf, 'folders'), 'utf8')).toBe('')
      expect(existsSync(join(s.root, 'repo/config'))).toBe(true) // the repository is there already
      expect(s.calls()).toContain('systemctl --user disable --now quadeck-backup.timer')
      expect(s.calls()).not.toContain('enable --now quadeck-backup.timer')
      expect(s.calls()).toContain('systemctl --user enable --now quadeck-backup-agent.timer')
      const agentTimer = readFileSync(join(units, 'quadeck-backup-agent.timer'), 'utf8')
      expect(agentTimer).toContain('OnCalendar=*:0/10')
      expect(agentTimer).toContain('RandomizedDelaySec=2min')
      expect(agentTimer).toContain('Persistent=true')
      expect(readFileSync(join(units, 'quadeck-backup-agent.service'), 'utf8')).toContain('quadeck-backup poll')
      // The end of the script told Quadeck: connected, and the folder list follows.
      let c = await laptop(q.b)
      expect(c).toMatchObject({ applied: { version: 0 }, lastSeen: expect.any(Number) })
      expect(c.plan).toBeUndefined()
      await until(async () => (await q.b.clientInventory('laptop')) !== null)
      expect((await q.b.clientInventory('laptop'))!.home).toBe(s.home)

      const cmd = join(s.home, '.local/bin/quadeck-backup')
      const nothing = await run([cmd, 'run'], { env: s.env, timeoutMs: 60_000 })
      expect(nothing.code).not.toBe(0)
      expect(nothing.stderr).toContain('no backup plan yet')
      const idle = await run([cmd, 'poll'], { env: s.env, timeoutMs: 60_000 })
      expect(idle.code).toBe(0)
      expect(idle.stdout).toBe('')

      // A plan in Quadeck and "back up now": the next poll takes the plan and starts the service.
      await q.b.setClientPlan('laptop', plan({ folders: ['~/Bilder'], schedule: { every: 'weekly', time: '12:00' } }))
      await q.b.clientAction('laptop', 'run')
      const polled = await run([cmd, 'poll'], { env: s.env, timeoutMs: 60_000 })
      expect(polled.code).toBe(0)
      expect(polled.stdout).toContain('settings version 1')
      expect(readFileSync(join(conf, 'folders'), 'utf8')).toBe(`${s.home}/Bilder\n`)
      expect(readFileSync(join(units, 'quadeck-backup.timer'), 'utf8')).toContain('OnCalendar=Sun *-*-* 12:00:00')
      expect(s.calls()).toContain('systemctl --user start --no-block quadeck-backup.service')
      expect((await s.restic('ls', 'latest')).stdout).toContain('/Bilder/foto.jpg')
      c = await laptop(q.b)
      expect(c.applied?.version).toBe(1)
      expect(c.actions).toBeUndefined()
      expect(c.runs?.[0]).toMatchObject({ status: 'ok' })

      const gone = await run([cmd, 'uninstall'], { env: s.env })
      expect(gone.code).toBe(0)
      expect(s.calls()).toContain('disable --now quadeck-backup.timer quadeck-backup-agent.timer')
      expect(existsSync(join(units, 'quadeck-backup-agent.timer'))).toBe(false)
      expect(existsSync(join(units, 'quadeck-backup.timer'))).toBe(false)
    } finally {
      q.server.stop(true)
    }
  }, 180_000)

  it.skipIf(!hasOpenssl)(
    "connects to a Quadeck behind Caddy's local CA: the command checks it, the script keeps it for every call",
    async () => {
      const s = sandbox()
      const t = await testCa()
      const b = new SystemBackup({ dir: join(s.root, 'state'), unitDir: join(s.root, 'units'), exec: run, log: () => {} })
      await b.saveTarget({ dataDir: join(s.root, 'backups'), port: 8000, appendOnly: false, url: 'http://nas:8000' })
      await b.addClient('laptop', 3)
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        tls: { cert: t.cert, key: t.key },
        fetch: async (req) => {
          const url = new URL(req.url)
          if (url.pathname === '/ca.crt') return new Response(t.ca)
          if (url.pathname.startsWith('/api/backup/script/')) {
            const script = (await b.redeemClientLink(url.pathname.split('/').pop()!)) ?? 'exit 1'
            // the repository of this sandbox instead of the rest server
            return new Response(script.replace(/^RESTIC_REPOSITORY=.*$/m, `RESTIC_REPOSITORY=${sq(join(s.root, 'repo'))}`))
          }
          try {
            const kind = url.searchParams.get('do') as AgentKind
            const reply = await b.clientAgent('laptop', (req.headers.get('authorization') ?? '').slice(7), kind, req.method === 'POST' ? await req.text() : '')
            return 'text' in reply ? new Response(reply.text) : Response.json(reply.json)
          } catch (e) {
            return new Response((e as Error).message, { status: (e as { status?: number }).status ?? 500 })
          }
        },
      })
      const origin = `https://127.0.0.1:${server.port}`
      try {
        const link = await b.clientLink('laptop', origin, async (u) => (u === origin ? localCa(t.ca) : undefined))
        expect(link.ca?.sha256).toBe(localCa(t.ca).sha256)
        rmSync(CA_TMP, { force: true })
        const r = await run(['sh', '-c', setupCommand(origin, link.token, link.ca)], { env: { ...s.env, ...NO_PROXY }, timeoutMs: 60_000 })
        expect(r.code, r.stderr).toBe(0)
        expect(r.stdout).toContain('laptop is connected to Quadeck')
        const conf = join(s.home, '.config/quadeck-backup')
        expect(readFileSync(join(conf, 'ca.crt'), 'utf8')).toBe(t.ca)
        expect(readFileSync(join(conf, 'env'), 'utf8')).not.toContain('RESTIC_CACERT') // the repository is not behind Caddy here
        expect(existsSync(CA_TMP)).toBe(false) // the script tidied up
        expect((await laptop(b)).lastSeen).toBeDefined()
        // Later calls (the agent timer) trust the stored CA, not the system's.
        const polled = await run([join(s.home, '.local/bin/quadeck-backup'), 'poll'], { env: { ...s.env, ...NO_PROXY } })
        expect(polled.code, polled.stderr).toBe(0)
        writeFileSync(join(conf, 'ca.crt'), ROOT)
        const other = await run([join(s.home, '.local/bin/quadeck-backup'), 'poll'], { env: { ...s.env, ...NO_PROXY } })
        expect(other.code).not.toBe(0)
        expect(other.stderr).toContain('no longer comes from the CA stored in')
      } finally {
        server.stop(true)
        rmSync(CA_TMP, { force: true })
      }
    },
    120_000,
  )

  it('settings from Quadeck are data: lines that do not pass the checks change nothing', async () => {
    const s = sandbox()
    const pwned = join(s.root, 'pwned')
    const bad = [
      `quadeck-settings 1\nversion 9\nactive 1\ncalendar $(touch ${pwned})\nfolder ~/x\nend\n`,
      `quadeck-settings 1\nversion 9\nactive 1\ncalendar *-*-* 12:00:00\nmaxsize 2; touch ${pwned}\nfolder ~/x\nend\n`,
      `quadeck-settings 1\nversion 9\nactive 1\ncalendar *-*-* 12:00:00\nkeep daily 1 --password-command=touch\nfolder ~/x\nend\n`,
      'quadeck-settings 1\nversion 9\nactive 1\ncalendar *-*-* 12:00:00\nfolder ~/x\n', // cut off: no end
    ]
    for (const settings of bad) {
      const q = await quadeck(join(s.root, String(bad.indexOf(settings))), { settings })
      try {
        writeFileSync(join(s.root, 'setup.sh'), clientScript(input({ repo: join(s.root, 'repo'), plan: plan({ folders: ['~/Dokumente'] }), version: 1, agentToken: q.token, quadeckUrl: q.url })))
        expect((await run(['sh', join(s.root, 'setup.sh')], { env: s.env, timeoutMs: 60_000 })).code).toBe(0)
        const r = await run([join(s.home, '.local/bin/quadeck-backup'), 'sync'], { env: s.env })
        expect(r.code).not.toBe(0)
        const conf = join(s.home, '.config/quadeck-backup')
        expect(readFileSync(join(conf, 'folders'), 'utf8')).toBe(`${s.home}/Dokumente\n`)
        expect(readFileSync(join(conf, 'env'), 'utf8')).toContain('QUADECK_VERSION=1')
      } finally {
        q.server.stop(true)
      }
    }
    expect(existsSync(pwned)).toBe(false)
  }, 180_000)

  it('refuses to run as root', async () => {
    if (process.getuid?.() !== 0) return
    const s = sandbox()
    // in this sandbox we are root: the script must say so instead of backing up root's home
    const r = await run(['sh', '-c', clientScript(input({ repo: join(s.root, 'repo') }))], { env: { ...s.env, QUADECK_ALLOW_ROOT: '' } })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('not as root')
  })
})
