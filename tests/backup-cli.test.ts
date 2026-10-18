import { describe, expect, it } from 'vitest'
import { FixtureBackup } from '~/server/backup/backend'
import { backupCli, backupPlanChanges, clientPlanChanges, parseCliArgs, parseSecretsFile } from '~/server/backup/cli'
import type { BackupPlan } from '~/shared/backup'
import { defaultClientPlan } from '~/shared/backup-client'

function cli(files: Record<string, string> = {}) {
  const backup = new FixtureBackup()
  const out: string[] = []
  const err: string[] = []
  const deps = {
    backup,
    out: (t: string) => out.push(t),
    err: (t: string) => err.push(t),
    read: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`)
      return files[p]!
    },
  }
  return { backup, out, err, run: (...argv: string[]) => backupCli(argv, deps), json: () => JSON.parse(out.at(-1)!) }
}

const current = async (b: FixtureBackup) => (await b.backupState()).plan!

describe('quadeck backup (CLI)', () => {
  it('parses options anywhere, with values', () => {
    expect(parseCliArgs(['plan', 'set', '-f', 'p.json', '--dry-run', '--json'])).toMatchObject({ pos: ['plan', 'set'], file: 'p.json', dryRun: true, json: true })
    expect(parseCliArgs(['sizes', '/a', '--exclude=/a/c', '/b', '--exclude', '/b/c'])).toMatchObject({ pos: ['sizes', '/a', '/b'], exclude: ['/a/c', '/b/c'] })
    expect(parseCliArgs(['plan', 'set', '-f', '-'])).toMatchObject({ file: '-' })
    expect(() => parseCliArgs(['--bogus'])).toThrow(/unknown option/)
    expect(() => parseCliArgs(['plan', 'set', '-f'])).toThrow(/needs a value/)
  })

  it('status and snapshots as JSON', async () => {
    const c = cli()
    expect(await c.run('status', '--json')).toBe(0)
    expect(c.json().plan.repo.location).toBe('/mnt/backup/restic')
    expect(await c.run('snapshots', '--json')).toBe(0)
    expect(c.json().length).toBeGreaterThan(0)
  })

  it('a dry run lists the changes and saves nothing', async () => {
    const c = cli()
    const plan = await current(c.backup)
    const next = { ...plan, paths: [...plan.paths.filter((p) => p !== '/etc'), '/srv/paperless'], keep: { daily: 14, weekly: 4, monthly: 6 } }
    const files = { 'p.json': JSON.stringify(next) }
    const d = cli(files)
    expect(await d.run('plan', 'set', '-f', 'p.json', '--dry-run', '--json')).toBe(0)
    const r = d.json()
    expect(r.dryRun).toBe(true)
    expect(r.changes).toEqual(['+ folder: /srv/paperless', '- folder: /etc', '~ keep: daily 7, weekly 4, monthly 6 → daily 14, weekly 4, monthly 6'])
    expect((await current(d.backup)).paths).toContain('/etc')
  })

  it('saves a plan, keeping the password confirmation when it is left out', async () => {
    const c = cli()
    const { passwordSaved: _p, ...plan } = await current(c.backup)
    const d = cli({ 'p.json': JSON.stringify({ ...plan, check: 'weekly' }) })
    expect(await d.run('plan', 'set', '-f', 'p.json')).toBe(0)
    const saved = await current(d.backup)
    expect(saved.check).toBe('weekly')
    expect(saved.passwordSaved).toBe(true)
    expect(d.out.at(-1)).toContain('~ check: monthly → weekly')
  })

  it('refuses an invalid plan with exit code 2 and the reason', async () => {
    const c = cli({ 'p.json': JSON.stringify({ repo: { kind: 'local', location: '/srv/data/restic' }, paths: ['/srv/data'] }) })
    expect(await c.run('plan', 'set', '-f', 'p.json', '--json')).toBe(2)
    expect(c.json().error).toBeTruthy()
    const n = cli({ 'p.json': 'not json' })
    expect(await n.run('plan', 'set', '-f', 'p.json')).toBe(2)
    expect(n.err[0]).toMatch(/not JSON/)
    expect(await cli().run('plan', 'set')).toBe(2)
  })

  it('takes only the credentials the target uses, from a file', async () => {
    const c = cli()
    const plan = await current(c.backup)
    const s3 = { ...plan, repo: { kind: 's3', location: 's3.example.com/bucket' } }
    const d = cli({ 'p.json': JSON.stringify(s3), sec: 'AWS_ACCESS_KEY_ID=a\nOTHER=x\n' })
    expect(await d.run('plan', 'set', '-f', 'p.json', '--secrets', 'sec', '--json')).toBe(2)
    expect(d.json().error).toMatch(/OTHER/)
    const e = cli({ 'p.json': JSON.stringify(s3), sec: '# keys\nAWS_ACCESS_KEY_ID=a\nAWS_SECRET_ACCESS_KEY=b\n' })
    expect(await e.run('plan', 'set', '-f', 'p.json', '--secrets', 'sec')).toBe(0)
    expect((await current(e.backup)).repo.kind).toBe('s3')
    expect(parseSecretsFile('A=1\n\n# c\nB = two words\n')).toEqual({ A: '1', B: 'two words' })
  })

  it('a draft from the suggestions is a plan the CLI accepts once it has a target', async () => {
    const c = cli()
    expect(await c.run('plan', 'draft', '--json')).toBe(0)
    const draft = c.json() as BackupPlan
    expect(draft.repo.location).toBe('')
    const d = cli({ 'p.json': JSON.stringify({ ...draft, paths: ['/srv/app'], repo: { kind: 'local', location: '/mnt/backup/restic' } }) })
    expect(await d.run('plan', 'set', '-f', 'p.json', '--dry-run')).toBe(0)
  })

  it("shows and sets a client's plan", async () => {
    const c = cli()
    expect(await c.run('client', 'plan', 'show', 'laptop', '--json')).toBe(0)
    const plan = c.json()
    expect(plan.folders).toContain('~/Projekte')
    const d = cli({ 'p.json': JSON.stringify({ ...plan, folders: [...plan.folders, '~/Musik'] }) })
    expect(await d.run('client', 'plan', 'set', 'laptop', '-f', 'p.json', '--dry-run', '--json')).toBe(0)
    expect(d.json().changes).toEqual(['+ folder: ~/Musik'])
    expect((await d.backup.targetState()).clients.find((x) => x.name === 'laptop')!.version).toBe(4)
    expect(await d.run('client', 'plan', 'set', 'laptop', '-f', 'p.json')).toBe(0)
    const laptop = (await d.backup.targetState()).clients.find((x) => x.name === 'laptop')!
    expect(laptop.version).toBe(5)
    expect(laptop.plan!.folders).toContain('~/Musik')
    expect(await d.run('client', 'plan', 'show', 'nobody', '--json')).toBe(1)
    expect(await d.run('client', 'plan', 'show', '../x')).toBe(2)
  })

  it('lists changes of a client plan', () => {
    const a = defaultClientPlan()
    expect(clientPlanChanges(a, { ...a, active: false, exclude: { ...a.exclude, patterns: ['*.iso'] } })).toEqual(['+ pattern: *.iso', '~ active: true → false'])
    expect(clientPlanChanges(undefined, a)).toEqual(['+ new plan'])
  })

  it('lists changes of a server plan', () => {
    const a: BackupPlan = {
      repo: { kind: 'local', location: '/mnt/b' },
      paths: ['/srv/a'],
      exclude: { presets: ['caches'], dirs: [], patterns: [] },
      stop: [],
      schedule: { every: 'daily', time: '02:00' },
      keep: { daily: 7, weekly: 4, monthly: 12 },
      check: 'monthly',
      passwordSaved: true,
    }
    expect(backupPlanChanges(a, a)).toEqual([])
    expect(backupPlanChanges(a, { ...a, repo: { kind: 'local', location: '/mnt/c' }, schedule: { every: '6h', time: '01:00' }, exclude: { ...a.exclude, maxSizeGB: 2 } })).toEqual([
      '~ target: local:/mnt/b → local:/mnt/c',
      '~ max file size (GB): none → 2',
      '~ schedule: daily 02:00 → 6h 01:00',
    ])
  })

  it('help and guide need nothing; an unknown command is a usage error', async () => {
    const c = cli()
    expect(await c.run()).toBe(0)
    expect(c.out[0]).toContain('quadeck backup plan set')
    expect(await c.run('guide')).toBe(0)
    expect(c.out[1]).toContain('--dry-run')
    expect(await c.run('nope')).toBe(2)
  })
})
