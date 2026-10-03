import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '~/server/exec'
import { clientCalendar, clientCommand, clientExcludes, clientScript, defaultClientPlan, parseClientPlan, sq, type ClientPlan } from '~/shared/backup-client'

const plan = (over: Partial<ClientPlan> = {}): ClientPlan => ({ ...defaultClientPlan(), ...over })

describe('client plan', () => {
  it('accepts home and absolute folders', () => {
    const { plan: p, error } = parseClientPlan({ ...plan(), folders: ['~/Dokumente', '~', '/etc/nginx', '~/Dokumente'] })
    expect(error).toBeUndefined()
    expect(p!.folders).toEqual(['~/Dokumente', '~', '/etc/nginx'])
  })
  it.each([['relative', ['Dokumente']], ['root', ['/']], ['dot-dot', ['~/../etc']], ['trailing slash', ['~/a/']], ['double slash', ['~//a']], ['newline', ['~/a\nb']], ['none', []], ['~user', ['~bob/x']]])('refuses %s folders', (_n, folders) => {
    expect(parseClientPlan({ ...plan(), folders }).error).toBeTruthy()
  })
  it('refuses bad schedules, retention and patterns', () => {
    expect(parseClientPlan({ ...plan(), schedule: { every: 'minutely', time: '12:00' } }).error).toBeTruthy()
    expect(parseClientPlan({ ...plan(), keep: { daily: 0, weekly: 0, monthly: 0 } }).error).toBeTruthy()
    expect(parseClientPlan({ ...plan(), exclude: { presets: [], patterns: ['a\nb'] } }).error).toBeTruthy()
  })
  it('calendar and excludes', () => {
    expect(clientCalendar({ every: 'hourly', time: '12:15' })).toBe('*-*-* *:15:00')
    expect(clientCalendar({ every: '6h', time: '09:30' })).toBe('*-*-* 3/6:30:00')
    expect(clientCalendar({ every: 'daily', time: '12:00' })).toBe('*-*-* 12:00:00')
    expect(clientCalendar({ every: 'weekly', time: '20:00' })).toBe('Sun *-*-* 20:00:00')
    expect(clientExcludes(plan({ exclude: { presets: ['caches', 'downloads'], patterns: ['*.mkv'] } }))).toEqual(['~/.cache', '~/Downloads', '*.mkv'])
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
    writeFileSync(join(dir, 'setup.sh'), clientScript(input({ plan: plan({ folders: ["~/Bob's files", '~/a b'], exclude: { presets: ['caches', 'nobackup'], patterns: ['*.$weird'], maxSizeGB: 2 } }) })))
    writeFileSync(join(dir, 'cmd.sh'), clientCommand())
    for (const f of ['setup.sh', 'cmd.sh']) expect((await run(['sh', '-n', join(dir, f)])).code).toBe(0)
    const text = clientScript(input())
    expect(text).toContain("RESTIC_REPOSITORY='rest:http://nas.lan:8000/laptop/'")
    expect(text).toContain("CALENDAR='*-*-* 12:00:00'")
    expect(text).not.toContain('QUADECK_REPO_PASSWORD=') // the repository password never comes from the server
  })
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
    const restic = (...args: string[]) => run(['restic', ...args], { env: { ...env, RESTIC_REPOSITORY: join(root, 'repo'), RESTIC_PASSWORD_FILE: join(home, '.config/quadeck-backup/password') }, timeoutMs: 60_000 })
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

    const check = await run([cmd, 'check'], { env: s.env, timeoutMs: 60_000 })
    expect(check.code).toBe(0)
    expect(check.stdout).toContain('Dry run')

    // New settings: paused, another folder. The repository password stays.
    const r2 = await s.script(plan({ folders: ['~/Bilder'], active: false }), 2)
    expect(r2.code).toBe(0)
    expect(readFileSync(join(conf, 'password'), 'utf8')).toBe('client-secret\n')
    expect(readFileSync(join(conf, 'folders'), 'utf8')).toBe(`${s.home}/Bilder\n`)
    expect(readFileSync(join(conf, 'env'), 'utf8')).toContain('QUADECK_VERSION=2')
    expect(s.calls()).toContain('systemctl --user disable --now quadeck-backup.timer')
  }, 120_000)

  it('stops when the password on the computer does not open the repository', async () => {
    const s = sandbox()
    expect((await s.script(plan())).code).toBe(0)
    writeFileSync(join(s.home, '.config/quadeck-backup/password'), 'wrong\n')
    const r = await s.script(plan(), 2)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('does not open it')
  }, 60_000)

  it('refuses to run as root', async () => {
    if (process.getuid?.() !== 0) return
    const s = sandbox()
    // in this sandbox we are root: the script must say so instead of backing up root's home
    const r = await run(['sh', '-c', clientScript(input({ repo: join(s.root, 'repo') }))], { env: { ...s.env, QUADECK_ALLOW_ROOT: '' } })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('not as root')
  })
})
