import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LinkStore, SystemBackup, accessPassword, clientRepoStatus, parseEnvFile } from '~/server/backup/backend'
import { defaultClientPlan } from '~/shared/backup-client'
import { run } from '~/server/exec'
import { parseJobSpec } from '~/server/packages/job'
import {
  backupAlert,
  backupArgs,
  backupRunFrom,
  backupUnits,
  checkCalendar,
  defaultPlan,
  excludeFile,
  forgetArgs,
  onCalendar,
  parseBackupPlan,
  parseLs,
  parseSecrets,
  parseSnapshots,
  retentionEstimate,
  suggestBackup,
  type BackupPlan,
  clientRepo,
  parseClientChange,
  parseTargetConfig,
  parseWarnDays,
  staleClients,
  targetQuadlet,
} from '~/shared/backup'
import { lintQuadlet } from '~/shared/ini'

const plan = (over: Partial<BackupPlan> = {}): BackupPlan => ({
  repo: { kind: 'local', location: '/mnt/backup/restic' },
  paths: ['/srv/app', 'volume:caddy-data', '/etc'],
  exclude: { presets: ['caches', 'temp', 'nobackup'], dirs: ['/srv/app/cache'], patterns: ['**/.DS_Store'] },
  stop: ['db.service'],
  schedule: { every: 'daily', time: '02:00' },
  keep: { daily: 7, weekly: 4, monthly: 6 },
  check: 'monthly',
  passwordSaved: false,
  ...over,
})

describe('parseBackupPlan', () => {
  it('accepts a sound plan and normalises it', () => {
    const { plan: p, error } = parseBackupPlan({ ...plan(), paths: ['/srv/app', '/srv/app', 'volume:caddy-data'], exclude: { presets: ['caches', 'bogus'], dirs: [], patterns: ['  *.iso ', ''] }, extra: 1 })
    expect(error).toBeUndefined()
    expect(p!.paths).toEqual(['/srv/app', 'volume:caddy-data'])
    expect(p!.exclude).toEqual({ presets: ['caches'], dirs: [], patterns: ['*.iso'] })
    expect(p).not.toHaveProperty('extra')
  })

  it.each([
    ['relative path', { paths: ['srv/app'] }],
    ['root itself', { paths: ['/'] }],
    ['dot-dot', { paths: ['/srv/../etc'] }],
    ['trailing slash', { paths: ['/srv/app/'] }],
    ['control character', { paths: ['/srv/a\nb'] }],
    ['no paths', { paths: [] }],
    ['bad volume name', { paths: ['volume:-rf'] }],
    ['repo inside a source', { repo: { kind: 'local', location: '/srv/app/backup' } }],
    ['source inside the repo', { repo: { kind: 'local', location: '/srv' } }],
    ['relative repo', { repo: { kind: 'local', location: 'backup' } }],
    ['repo with spaces', { repo: { kind: 'sftp', location: 'nas:/a b' } }],
    ['unknown repo kind', { repo: { kind: 'ftp', location: 'x' } }],
    ['rest url with credentials', { repo: { kind: 'rest', location: 'https://u:p@host/repo' } }],
    ['sftp host as an ssh option', { repo: { kind: 'sftp', location: '-oProxyCommand:x' } }],
    ['sftp user as an ssh option', { repo: { kind: 'sftp', location: '-Fx@host:/x' } }],
    ['s3 host starting with a dash', { repo: { kind: 's3', location: '-x/bucket' } }],
    ['unit starting with a dash', { stop: ['-x.service'] }],
    ['not a service', { stop: ['db.timer'] }],
    ['bad time', { schedule: { every: 'daily', time: '25:00' } }],
    ['bad interval', { schedule: { every: 'hourly', time: '02:00' } }],
    ['nothing kept', { keep: { daily: 0, weekly: 0, monthly: 0 } }],
    ['negative keep', { keep: { daily: -1, weekly: 4, monthly: 6 } }],
    ['pattern with newline', { exclude: { presets: [], dirs: [], patterns: ['a\nb'] } }],
    ['relative exclude dir', { exclude: { presets: [], dirs: ['cache'], patterns: [] } }],
    ['size limit zero', { exclude: { presets: [], dirs: [], patterns: [], maxSizeGB: 0 } }],
  ])('refuses %s', (_name, over) => {
    expect(parseBackupPlan({ ...plan(), ...over }).error).toBeTruthy()
  })

  it('takes the target forms restic knows', () => {
    for (const repo of [
      { kind: 'sftp', location: 'backup@nas.lan:/srv/restic' },
      { kind: 's3', location: 's3.eu-central-1.amazonaws.com/bucket/server' },
      { kind: 'b2', location: 'my-bucket:server' },
      { kind: 'rest', location: 'https://backup.home.lan/server/' },
    ])
      expect(parseBackupPlan({ ...plan(), repo }).error).toBeUndefined()
  })

  it('credentials: only the names the target needs, no newlines', () => {
    expect(parseSecrets('b2', { B2_ACCOUNT_ID: 'id', B2_ACCOUNT_KEY: 'key', AWS_ACCESS_KEY_ID: 'x', PATH: '/evil' })).toEqual({ secrets: { B2_ACCOUNT_ID: 'id', B2_ACCOUNT_KEY: 'key' } })
    expect(parseSecrets('rest', { RESTIC_REST_PASSWORD: 'a\nRESTIC_REPOSITORY=/tmp' }).error).toBeTruthy()
    expect(parseSecrets('local', { RESTIC_PASSWORD: 'x' })).toEqual({ secrets: {} })
  })
})

describe('restic arguments and units', () => {
  it('builds the exclude file and the arguments from the plan', () => {
    const p = plan({ exclude: { presets: ['caches', 'temp', 'logs', 'nobackup'], dirs: ['/srv/app/cache'], patterns: ['*.iso'], maxSizeGB: 4 } })
    expect(excludeFile(p).split('\n')).toEqual(['# Written by Quadeck – changes are overwritten', '*.tmp', '*.part', '*.swp', '.~lock.*', '*.log', '/srv/app/cache', '*.iso', ''])
    expect(backupArgs(p, '/x/excludes', ['/srv/app', '/var/lib/containers/storage/volumes/caddy-data/_data'])).toEqual([
      '--json',
      '--tag',
      'quadeck',
      '--exclude-file',
      '/x/excludes',
      '--exclude-caches',
      '--exclude-if-present',
      '.nobackup',
      '--exclude-larger-than',
      '4G',
      '--',
      '/srv/app',
      '/var/lib/containers/storage/volumes/caddy-data/_data',
    ])
    expect(forgetArgs(plan({ keep: { daily: 7, weekly: 0, monthly: 6 } }))).toEqual(['--tag', 'quadeck', '--prune', '--keep-daily', '7', '--keep-monthly', '6'])
  })

  it('schedules', () => {
    expect(onCalendar({ every: 'daily', time: '02:30' })).toBe('*-*-* 02:30:00')
    expect(onCalendar({ every: '6h', time: '08:15' })).toBe('*-*-* 2/6:15:00')
    expect(onCalendar({ every: 'weekly', time: '23:00' })).toBe('Sun *-*-* 23:00:00')
    expect(checkCalendar(plan({ schedule: { every: 'daily', time: '22:10' } }))).toBe('*-*-01 01:10:00')
    expect(checkCalendar(plan({ check: 'weekly' }))).toBe('Sun *-*-* 05:00:00')
    expect(checkCalendar(plan({ check: 'never' }))).toBeUndefined()
    expect(retentionEstimate({ daily: 7, weekly: 4, monthly: 6 })).toEqual({ count: 16, days: 180 })
  })

  it('writes the units with the binary quoted, the check only when wanted', () => {
    const u = backupUnits(plan(), ['/usr/local/bin/quadeck'])
    expect(u['quadeck-backup.service']).toContain('ExecStart=/usr/local/bin/quadeck backup run\n')
    expect(u['quadeck-backup.service']).toContain('Type=oneshot')
    expect(u['quadeck-backup.timer']).toContain('OnCalendar=*-*-* 02:00:00\nPersistent=true')
    expect(u['quadeck-backup-check.service']).toContain('ExecStart=/usr/local/bin/quadeck backup check')
    const dev = backupUnits(plan({ check: 'never' }), ['/home/me/my bun/bun', '/src/main.ts'])
    expect(dev['quadeck-backup.service']).toContain('ExecStart="/home/me/my bun/bun" /src/main.ts backup run')
    expect(dev['quadeck-backup-check.service']).toBeNull()
    expect(dev['quadeck-backup-check.timer']).toBeNull()
    // The units find the same state directory as the helper.
    expect(backupUnits(plan(), ['/q'], '/srv/qd state')['quadeck-backup.service']).toContain('Environment="QUADECK_BACKUP_DIR=/srv/qd state"\nExecStart=/q backup run')
  })
})

describe('suggestions from the Quadlets', () => {
  const files = [
    { name: 'jellyfin.container', content: '[Container]\nImage=docker.io/jellyfin/jellyfin:latest\nVolume=/srv/jellyfin/config:/config:Z\nVolume=/srv/jellyfin/cache:/cache:Z\nVolume=/mnt/storage/media:/media:ro\n' },
    { name: 'immich.container', content: '[Container]\nImage=ghcr.io/immich-app/immich-server:release\nVolume=/srv/immich/upload/:/usr/src/app/upload:Z\nVolume=/etc/localtime:/etc/localtime:ro\n' },
    { name: 'immich-db.container', content: '[Container]\nImage=docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0\nVolume=immich-db.volume:/var/lib/postgresql/data\n' },
    { name: 'immich-db.volume', content: '[Volume]\n' },
    { name: 'caddy.container', content: '[Container]\nImage=docker.io/library/caddy:2\nVolume=/etc/caddy:/etc/caddy:Z\nVolume=caddy-data:/data\nVolume=/run/podman/podman.sock:/var/run/docker.sock\n' },
  ]
  it('offers the data folders and volumes, skips sockets and what apps rebuild', () => {
    const s = suggestBackup(files)
    expect(s.paths).toEqual([
      { path: '/etc/caddy', from: 'caddy', checked: true },
      { path: 'volume:caddy-data', from: 'caddy', checked: true },
      { path: 'volume:systemd-immich-db', from: 'immich-db', checked: true },
      { path: '/srv/immich/upload', from: 'immich', checked: true },
      { path: '/srv/jellyfin/config', from: 'jellyfin', checked: true },
      { path: '/mnt/storage/media', from: 'jellyfin', checked: false, readOnly: true },
      { path: '/etc', from: 'System', checked: true },
    ])
    expect(s.excludes.map((e) => e.path)).toEqual(['/srv/immich/upload/thumbs', '/srv/immich/upload/encoded-video', '/srv/jellyfin/cache'])
    expect(s.stop.filter((x) => x.database).map((x) => x.unit)).toEqual(['immich-db.service'])
    const d = defaultPlan(s)
    expect(d.stop).toEqual(['immich-db.service'])
    expect(d.paths).not.toContain('/mnt/storage/media')
    expect(parseBackupPlan({ ...d, repo: { kind: 'local', location: '/mnt/backup/restic' } }).error).toBeUndefined()
  })
})

describe('restic output', () => {
  const out = [
    '{"message_type":"status","percent_done":0.5}',
    '{"message_type":"error","error":{"message":"permission denied"},"during":"archival","item":"/srv/app/secret"}',
    '{"message_type":"error","error":{},"during":"scan","item":"/srv/app/gone"}',
    '{"message_type":"summary","files_new":2,"files_changed":1,"data_added":2105,"total_files_processed":10,"total_bytes_processed":600,"snapshot_id":"0b48d009ee9f"}',
  ].join('\n')
  it('a run with unreadable files is a warning, a crash a failure', () => {
    expect(backupRunFrom(3, out, '', 1, 2)).toMatchObject({ status: 'warning', snapshot: '0b48d009ee9f', filesNew: 2, files: 10, added: 2105, errors: ['/srv/app/secret: permission denied', '/srv/app/gone'] })
    expect(backupRunFrom(0, out.split('\n').filter((l) => !l.includes('error')).join('\n'), '', 1, 2).status).toBe('ok')
    expect(backupRunFrom(1, '', 'Fatal: unable to open repository\n', 1, 2)).toMatchObject({ status: 'failed', message: 'Fatal: unable to open repository' })
    expect(backupRunFrom(3, '', '', 1, 2).status).toBe('failed') // 3 without a summary: nothing was saved
  })

  it('snapshots take their sizes from our run records', () => {
    const json = JSON.stringify([
      { time: '2026-10-01T02:00:00Z', id: 'aaaa1111bbbb', short_id: 'aaaa1111', paths: ['/srv'], tags: ['quadeck'] },
      { time: '2026-10-02T02:00:00Z', id: 'cccc2222dddd', short_id: 'cccc2222', paths: ['/srv'], tags: ['quadeck'] },
    ])
    const s = parseSnapshots(json, [{ kind: 'backup', startedAt: 0, endedAt: 0, status: 'ok', snapshot: 'aaaa1111bbbb', files: 5, bytes: 9, added: 3, errors: [] }])
    expect(s.map((x) => x.short)).toEqual(['cccc2222', 'aaaa1111'])
    expect(s[1]).toMatchObject({ files: 5, bytes: 9, added: 3 })
    expect(parseSnapshots('garbage')).toEqual([])
  })

  it('ls: only the direct children, folders first', () => {
    const ls = [
      '{"time":"2026-10-03T20:34:52Z","id":"x","struct_type":"snapshot"}',
      '{"name":"a","type":"dir","path":"/srv/a","mtime":"2026-10-03T20:34:33Z","struct_type":"node"}',
      '{"name":"z.txt","type":"file","path":"/srv/a/z.txt","size":3,"mtime":"2026-10-03T20:34:33Z","struct_type":"node"}',
      '{"name":"b","type":"dir","path":"/srv/a/b","mtime":"2026-10-03T20:34:33Z","struct_type":"node"}',
      '{"name":"deep","type":"file","path":"/srv/a/b/deep","size":1,"struct_type":"node"}',
    ].join('\n')
    expect(parseLs(ls, '/srv/a').map((e) => e.name)).toEqual(['b', 'z.txt'])
    expect(parseLs(ls, '/srv/a')[1]).toMatchObject({ type: 'file', size: 3 })
    expect(parseLs('{"name":"srv","type":"dir","path":"/srv","struct_type":"node"}', '/').map((e) => e.path)).toEqual(['/srv'])
  })

  it('alerts when the last backup failed or none succeeded for days', () => {
    const now = Date.parse('2026-10-05T12:00:00Z')
    const ok = { kind: 'backup' as const, startedAt: 0, endedAt: Date.parse('2026-10-04T02:00:00Z'), status: 'ok' as const, errors: [] }
    expect(backupAlert({ plan: plan(), runs: [ok] }, 2, now)).toBeUndefined()
    expect(backupAlert({ plan: plan(), runs: [ok] }, 1, now)).toBeTruthy()
    expect(backupAlert({ plan: plan(), runs: [{ ...ok, status: 'failed', message: 'disk gone' }, ok] }, 2, now)).toContain('disk gone')
    expect(backupAlert({ plan: plan(), runs: [{ ...ok, kind: 'check', status: 'failed' }, ok] }, 2, now)).toBeUndefined()
    expect(backupAlert({ plan: undefined, runs: [] }, 2, now)).toBeUndefined()
  })
})

describe('restore job spec', () => {
  it('checks snapshot, paths, target and units', () => {
    expect(parseJobSpec({ kind: 'backup-restore', snapshot: 'aaaa1111', paths: ['/srv/a'], stop: ['db.service'], target: '/srv/restore/x' })).toEqual({ kind: 'backup-restore', snapshot: 'aaaa1111', paths: ['/srv/a'], stop: ['db.service'], target: '/srv/restore/x' })
    for (const bad of [
      { snapshot: 'x; rm', paths: ['/srv/a'], stop: [] },
      { snapshot: 'aaaa1111', paths: [], stop: [] },
      { snapshot: 'aaaa1111', paths: ['srv'], stop: [] },
      { snapshot: 'aaaa1111', paths: ['/srv/a'], stop: [], target: '/' },
      { snapshot: 'aaaa1111', paths: ['/srv/a'], stop: ['--now.service'] },
    ])
      expect(() => parseJobSpec({ kind: 'backup-restore', ...bad })).toThrow()
  })
})

// ---------- against the real restic ----------

const hasRestic = !!Bun.which('restic')

describe.skipIf(!hasRestic)('SystemBackup with restic', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-backup-'))
    const src = join(root, 'srv')
    mkdirSync(join(src, 'app/cache'), { recursive: true })
    mkdirSync(join(src, 'app/skip'), { recursive: true })
    mkdirSync(join(src, 'app/sub'), { recursive: true })
    writeFileSync(join(src, 'app/data.txt'), 'important')
    writeFileSync(join(src, 'app/sub/deep.txt'), 'deep')
    writeFileSync(join(src, 'app/cache/big.bin'), 'cache')
    writeFileSync(join(src, 'app/upload.tmp'), 'temp')
    writeFileSync(join(src, 'app/skip/.nobackup'), '')
    writeFileSync(join(src, 'app/skip/x.txt'), 'x')
    const calls: string[] = []
    const active = new Set(['db.service'])
    const exec = async (argv: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }) => {
      if (argv[0] === 'systemctl') {
        calls.push(argv.join(' '))
        if (argv[1] === 'is-active') return { code: active.has(argv[2]!) ? 0 : 3, stdout: active.has(argv[2]!) ? 'active\n' : 'inactive\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      }
      if (argv[0] === 'restic' && argv[1] === 'backup') calls.push('restic backup')
      return run(argv, opts)
    }
    const dir = join(root, 'state')
    const unitDir = join(root, 'units')
    mkdirSync(unitDir)
    const b = new SystemBackup({ dir, unitDir, self: ['/usr/local/bin/quadeck'], exec, log: () => {} })
    const p = plan({ repo: { kind: 'local', location: join(root, 'repo') }, paths: [join(src, 'app')], exclude: { presets: ['caches', 'temp', 'nobackup'], dirs: [join(src, 'app/cache')], patterns: [] }, stop: ['db.service'] })
    return { root, src, dir, unitDir, calls, b, p, exec }
  }

  it('sets up, backs up with excludes and stopped units, lists, downloads and restores', async () => {
    const { root, src, dir, unitDir, calls, b, p } = setup()
    await b.saveBackupPlan(p, {})
    expect(existsSync(join(root, 'repo/config'))).toBe(true)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'password')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(unitDir, 'quadeck-backup.service'), 'utf8')).toContain('ExecStart=/usr/local/bin/quadeck backup run')
    expect(calls).toContain('systemctl enable --now quadeck-backup.timer')

    calls.length = 0
    const r = await b.runBackup()
    expect(r.status).toBe('ok')
    expect(r.snapshot).toMatch(/^[0-9a-f]{64}$/)
    // The database is stopped only around restic itself.
    expect(calls.filter((c) => !c.includes('is-active'))).toEqual(['systemctl stop db.service', 'restic backup', 'systemctl start db.service'])

    const state = await b.backupState()
    expect(state.snapshots).toHaveLength(1)
    expect(state.repoSize).toBeGreaterThan(0)
    expect(state.runs[0]).toMatchObject({ kind: 'backup', status: 'ok' })

    const snap = state.snapshots[0]!.id
    const top = await b.backupLs(snap, join(src, 'app'))
    // cache dir (exclude dir) and *.tmp (preset) are not in the backup; a folder with .nobackup stays empty
    expect(top.map((e) => e.name)).toEqual(['skip', 'sub', 'data.txt'])
    expect((await b.backupLs(snap, join(src, 'app/skip'))).map((e) => e.name)).toEqual(['.nobackup']) // only the marker, not x.txt

    // Compared with today: changed and deleted files are marked.
    writeFileSync(join(src, 'app/data.txt'), 'changed!!')
    rmSync(join(src, 'app/sub/deep.txt'))
    expect((await b.backupLs(snap, join(src, 'app'))).find((e) => e.name === 'data.txt')?.now).toBe('changed')
    expect((await b.backupLs(snap, join(src, 'app/sub')))[0]).toMatchObject({ name: 'deep.txt', now: 'missing' })

    const file = await b.backupDump(snap, join(src, 'app/data.txt'))
    expect(await file.text()).toBe('important')
    const zip = new Uint8Array(await (await b.backupDump(snap, join(src, 'app/sub'))).arrayBuffer())
    expect(String.fromCharCode(zip[0]!, zip[1]!)).toBe('PK')
    await expect(b.backupDump(snap, join(src, 'app/nothere'))).rejects.toMatchObject({ status: 404 })

    // Into a new folder …
    const target = join(root, 'restore')
    expect(await b.restore({ snapshot: snap, paths: [join(src, 'app/sub')], target, stop: [] })).toBe(0)
    expect(readFileSync(join(target, src, 'app/sub/deep.txt'), 'utf8')).toBe('deep')
    // … and in place, with the units stopped around it.
    calls.length = 0
    expect(await b.restore({ snapshot: snap, paths: [join(src, 'app/sub/deep.txt'), join(src, 'app/data.txt')], stop: ['db.service'] })).toBe(0)
    expect(readFileSync(join(src, 'app/sub/deep.txt'), 'utf8')).toBe('deep')
    expect(readFileSync(join(src, 'app/data.txt'), 'utf8')).toBe('important')
    expect(calls.filter((c) => !c.includes('is-active'))).toEqual(['systemctl stop db.service', 'systemctl start db.service'])

    expect((await b.runCheck()).status).toBe('ok')
  }, 120_000)

  it('never creates a new repository over one it cannot open (wrong password)', async () => {
    const { root, dir, b, p } = setup()
    await b.saveBackupPlan(p, {})
    const before = readFileSync(join(root, 'repo/config'))
    writeFileSync(join(dir, 'password'), 'not-the-password\n')
    await expect(b.saveBackupPlan(p, {})).rejects.toMatchObject({ status: 422 })
    expect(readFileSync(join(root, 'repo/config'))).toEqual(before)
  }, 60_000)

  it('keeps working credentials when new ones do not open the repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-backup-creds-'))
    const dir = join(root, 'state')
    const seen: (string | undefined)[] = []
    const exec = async (argv: string[], opts?: { env?: Record<string, string> }) => {
      if (argv[0] !== 'restic') return { code: 0, stdout: '', stderr: '' }
      seen.push(opts?.env?.AWS_ACCESS_KEY_ID)
      return opts?.env?.AWS_ACCESS_KEY_ID === 'good' ? { code: 0, stdout: '{}', stderr: '' } : { code: 1, stdout: '', stderr: 'Fatal: unable to open config file: 403 Forbidden' }
    }
    const b = new SystemBackup({ dir, unitDir: join(root, 'units'), self: ['/usr/local/bin/quadeck'], exec, log: () => {} })
    mkdirSync(join(root, 'units'))
    const s3 = plan({ repo: { kind: 's3', location: 's3.example.com/bucket/restic' } })
    await b.saveBackupPlan(s3, { AWS_ACCESS_KEY_ID: 'good', AWS_SECRET_ACCESS_KEY: 'secret' })
    await expect(b.saveBackupPlan(s3, { AWS_ACCESS_KEY_ID: 'typo' })).rejects.toMatchObject({ status: 422 })
    expect(seen.at(-1)).toBe('typo') // the check used the new key …
    expect(readFileSync(join(dir, 'env'), 'utf8')).toContain('AWS_ACCESS_KEY_ID=good') // … but it was not stored
  })

  it('refuses a target on a disk that is not there', async () => {
    const { root, b, p } = setup()
    await expect(b.saveBackupPlan({ ...p, repo: { kind: 'local', location: join(root, 'not-mounted/restic') } }, {})).rejects.toMatchObject({ status: 422 })
    expect(existsSync(join(root, 'not-mounted'))).toBe(false)
  })

  it('a failed backup is recorded and the stopped units are started again', async () => {
    const { root, calls, b, p } = setup()
    await b.saveBackupPlan(p, {})
    rmSync(join(root, 'repo'), { recursive: true })
    calls.length = 0
    const r = await b.runBackup()
    expect(r.status).toBe('failed')
    expect(r.message).toBeTruthy()
    expect(calls).toContain('systemctl start db.service')
    expect((await b.backupState()).runs[0]!.status).toBe('failed')
  }, 60_000)

  it('credentials go to a root-only env file; switching off keeps the password', async () => {
    const { dir, unitDir, b, p } = setup()
    await expect(b.saveBackupPlan({ ...p, repo: { kind: 'rest', location: 'http://127.0.0.1:9/x' } }, {})).rejects.toMatchObject({ status: 400 })
    await b.saveBackupPlan(p, {})
    expect(parseEnvFile(readFileSync(join(dir, 'env'), 'utf8'))).toEqual({})
    const pw = await b.backupPassword()
    await b.disableBackup()
    expect(existsSync(join(unitDir, 'quadeck-backup.timer'))).toBe(false)
    expect((await b.backupState()).plan).toBeUndefined()
    expect(readFileSync(join(dir, 'password'), 'utf8').trim()).toBe(pw)
  }, 60_000)
})

describe('backup target for clients', () => {
  const cfg = { dataDir: '/srv/backups', port: 8000, appendOnly: true, url: 'http://nas.lan:8000' }
  it('checks the target and writes a Quadlet the linter accepts', () => {
    expect(parseTargetConfig({ ...cfg, dataDir: '/srv/backups/', url: 'http://nas.lan:8000/' })).toEqual({ config: cfg })
    for (const bad of [{ dataDir: 'backups' }, { dataDir: '/' }, { port: 0 }, { port: 70000 }, { url: 'nas.lan:8000' }, { url: 'http://u:p@nas/' }, { url: 'http://nas lan' }]) expect(parseTargetConfig({ ...cfg, ...bad }).error).toBeTruthy()
    const q = targetQuadlet(cfg)
    expect(q).toContain('Image=docker.io/restic/rest-server:latest')
    expect(q).toContain('Volume=/srv/backups:/data:Z')
    expect(q).toContain('Environment=OPTIONS="--private-repos --append-only"')
    expect(q).toContain('PublishPort=8000:8000')
    expect(targetQuadlet({ ...cfg, appendOnly: false })).toContain('Environment=OPTIONS="--private-repos"\n')
    expect(lintQuadlet(q, 'container').filter((d) => d.severity === 'error')).toEqual([])
    expect(clientRepo(cfg, 'laptop')).toBe('rest:http://nas.lan:8000/laptop/')
  })

  it('warn days and changes from the browser', () => {
    expect([parseWarnDays(3), parseWarnDays('7'), parseWarnDays(0), parseWarnDays(61), parseWarnDays(null), parseWarnDays(2.5)]).toEqual([3, 7, null, null, null, null])
    expect(parseClientChange({ warnDays: null, disabled: true, name: 'x' })).toEqual({ warnDays: null, disabled: true })
    expect(parseClientChange({})).toEqual({})
  })

  it('overdue clients: by their last backup, or since they were added', () => {
    const now = Date.parse('2026-10-10T12:00:00Z')
    const d = (n: number) => now - n * 86_400_000
    expect(
      staleClients(
        [
          { name: 'ok', created: d(100), warnDays: 3, lastAt: d(1) },
          { name: 'late', created: d(100), warnDays: 3, lastAt: d(9) },
          { name: 'new', created: d(1), warnDays: 3 },
          { name: 'never', created: d(5), warnDays: 3 },
          { name: 'off', created: d(100), warnDays: 3, lastAt: d(9), disabled: true },
          { name: 'quiet', created: d(100), lastAt: d(90) },
        ],
        now,
      ),
    ).toEqual([
      { name: 'late', days: 9, never: false },
      { name: 'never', days: 5, never: true },
    ])
  })

  it('access passwords are long and from a safe alphabet', () => {
    const p = accessPassword()
    expect(p).toMatch(/^[A-Za-z2-9]{28}$/)
    expect(accessPassword()).not.toBe(p)
  })
})

describe('SystemBackup: clients', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-target-'))
    const b = new SystemBackup({ dir: join(root, 'state'), unitDir: root, exec: run, log: () => {} })
    return { root, b, dataDir: join(root, 'backups') }
  }
  const htpasswd = (dataDir: string) => readFileSync(join(dataDir, '.htpasswd'), 'utf8')

  it('access in .htpasswd: add, disable, enable, renew, remove', async () => {
    const { b, dataDir } = setup()
    await expect(b.addClient('laptop', 3)).rejects.toMatchObject({ status: 409 }) // no target yet
    const q = await b.saveTarget({ dataDir, port: 8000, appendOnly: false, url: 'http://nas:8000' })
    expect(q).toContain(`Volume=${dataDir}:/data:Z`)
    expect(statSync(dataDir).isDirectory()).toBe(true)
    const { password } = await b.addClient('laptop', 3)
    await expect(b.addClient('laptop', 3)).rejects.toMatchObject({ status: 409 })
    await expect(b.addClient('Bad Name', 3)).rejects.toMatchObject({ status: 400 })
    await expect(b.addClient('../etc', 3)).rejects.toMatchObject({ status: 400 })
    const line = htpasswd(dataDir).trim()
    expect(line).toMatch(/^laptop:\$2[aby]\$10\$/)
    expect(await Bun.password.verify(password, line.slice('laptop:'.length))).toBe(true)
    expect(statSync(join(dataDir, '.htpasswd')).mode & 0o777).toBe(0o600)

    await b.addClient('pc', undefined)
    await b.updateClient('laptop', { disabled: true })
    expect(htpasswd(dataDir)).not.toContain('laptop:')
    expect(htpasswd(dataDir)).toContain('pc:')
    await b.updateClient('laptop', { disabled: false })
    expect(htpasswd(dataDir)).toContain(line) // the same access comes back

    const renewed = await b.renewClient('laptop')
    const hash = htpasswd(dataDir).split('\n').find((l) => l.startsWith('laptop:'))!.slice(7)
    expect(await Bun.password.verify(renewed.password, hash)).toBe(true)
    expect(await Bun.password.verify(password, hash)).toBe(false)

    mkdirSync(join(dataDir, 'pc/snapshots'), { recursive: true })
    let st = await b.removeClient('pc', false)
    expect(existsSync(join(dataDir, 'pc'))).toBe(true)
    expect(st.clients.map((c) => c.name)).toEqual(['laptop'])
    await b.addClient('pc', undefined)
    st = await b.removeClient('pc', true)
    expect(existsSync(join(dataDir, 'pc'))).toBe(false)
    expect(htpasswd(dataDir)).not.toContain('pc:')

    // Switched off: the clients stay for the next setup.
    await b.clearTarget()
    expect((await b.targetState()).config).toBeUndefined()
    expect((await b.targetState()).clients.map((c) => c.name)).toEqual(['laptop'])
  })

  it('refuses a data folder whose disk is not there or inside the server repository', async () => {
    const { root, b } = setup()
    await expect(b.saveTarget({ dataDir: join(root, 'nope/backups'), port: 8000, appendOnly: false, url: 'http://nas:8000' })).rejects.toMatchObject({ status: 422 })
    expect(existsSync(join(root, 'nope'))).toBe(false)
  })

  it.skipIf(!hasRestic)('reads the last backup of a client from its repository without the password', async () => {
    const { root, b, dataDir } = setup()
    await b.saveTarget({ dataDir, port: 8000, appendOnly: false, url: 'http://nas:8000' })
    await b.addClient('laptop', 3)
    expect(clientRepoStatus(join(dataDir, 'laptop'))).toEqual({ snapshots: 0 })
    // What a client does through the rest-server, done locally into the same folder.
    mkdirSync(join(root, 'home'))
    writeFileSync(join(root, 'home/doc.txt'), 'hello')
    writeFileSync(join(root, 'pw'), 'client-secret\n')
    const env = { RESTIC_REPOSITORY: join(dataDir, 'laptop'), RESTIC_PASSWORD_FILE: join(root, 'pw'), RESTIC_CACHE_DIR: join(root, 'cache') }
    expect((await run(['restic', 'init'], { env })).code).toBe(0)
    const before = Date.now()
    expect((await run(['restic', 'backup', join(root, 'home')], { env })).code).toBe(0)
    const st = await b.targetState(true)
    const c = st.clients.find((x) => x.name === 'laptop')!
    expect(c.snapshots).toBe(1)
    expect(c.lastAt).toBeGreaterThanOrEqual(before - 1000)
    expect(c.size).toBeGreaterThan(0)
    expect(st.disk?.free).toBeGreaterThan(0)
  }, 60_000)
})

describe('one-time links for the client script', () => {
  it('a link works once, within 30 minutes, and a new one replaces the old', () => {
    const l = new LinkStore()
    const now = 1_000_000
    const a = l.create('laptop', 'http://nas:8484', now)
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(a.expires).toBe(now + 30 * 60_000)
    expect(l.take(a.token, now + 1000)?.name).toBe('laptop')
    expect(l.take(a.token, now + 2000)).toBeUndefined()
    const b = l.create('laptop', 'x', now)
    expect(l.take(b.token, now + 31 * 60_000)).toBeUndefined()
    const c = l.create('laptop', 'x', now)
    const d = l.create('laptop', 'x', now)
    expect(l.take(c.token, now)).toBeUndefined() // replaced by d
    expect(l.take(d.token, now)?.name).toBe('laptop')
    expect(l.take('../../etc/passwd', now)).toBeUndefined()
  })

  it('redeeming renews the access, records the version and yields the script', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-link-'))
    const dataDir = join(root, 'backups')
    const b = new SystemBackup({ dir: join(root, 'state'), unitDir: root, exec: run, log: () => {} })
    await b.saveTarget({ dataDir, port: 8000, appendOnly: true, url: 'http://nas:8000' })
    const { password: first } = await b.addClient('laptop', 3)
    await b.setClientPlan('laptop', { ...defaultClientPlan(), folders: ['~/Projekte'] })
    let st = await b.targetState()
    expect(st.clients[0]).toMatchObject({ version: 1 })
    expect(st.clients[0]!.applied).toBeUndefined()

    const { token } = await b.clientLink('laptop', 'http://nas:8484')
    const script = (await b.redeemClientLink(token))!
    expect(script).toContain("RESTIC_REPOSITORY='rest:http://nas:8000/laptop/'")
    expect(script).toContain("FOLDERS='~/Projekte'")
    expect(script).toContain('QUADECK_APPEND_ONLY=1')
    const access = /RESTIC_REST_PASSWORD='([A-Za-z2-9]+)'/.exec(script)![1]!
    const hash = readFileSync(join(dataDir, '.htpasswd'), 'utf8').trim().slice('laptop:'.length)
    expect(await Bun.password.verify(access, hash)).toBe(true)
    expect(await Bun.password.verify(first, hash)).toBe(false)
    st = await b.targetState()
    expect(st.clients[0]!.applied).toMatchObject({ version: 1 })
    expect(JSON.stringify(st)).not.toContain(hash) // hashes never leave the helper
    expect(await b.redeemClientLink(token)).toBeUndefined()

    // A later change shows as not applied until the next script.
    await b.setClientPlan('laptop', { ...defaultClientPlan(), folders: ['~/Projekte', '~/Bilder'] })
    expect((await b.targetState()).clients[0]).toMatchObject({ version: 2, applied: { version: 1 } })
    await expect(b.clientLink('nobody', 'http://nas:8484')).rejects.toMatchObject({ status: 404 })
  })
})
