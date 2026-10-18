// `quadeck backup …` on the server, as root: the same reads and writes as the Backups page, for a
// person in a shell or an agent (`--json` on every command). It works on the backup directory
// directly, like the timer's `quadeck backup run`; checks and storage are the backend's.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { HttpError } from '~/server/auth'
import { type BackupClient, type BackupPlan, CLIENT_NAME, clientConnected, clientOnline, defaultPlan, parseBackupPlan, parseSecrets, REPO_SECRETS } from '~/shared/backup'
import { type ClientPlan, parseClientPlan } from '~/shared/backup-client'
import { localize, localizeDeep } from '~/shared/i18n'
import type { BackupBackend } from './backend'

export interface BackupCliDeps {
  backup: BackupBackend & { runBackup?: () => Promise<{ status: string }>; runCheck?: () => Promise<{ status: string }> }
  out: (text: string) => void
  err: (text: string) => void
  /** A file's text; `-` is stdin. */
  read: (path: string) => string
  /** Writes a file, creating its folder (skill install). */
  write?: (path: string, text: string) => void
  home?: string
}

export const BACKUP_CLI_HELP = `quadeck backup – the server backup and the clients, as root (add --json for scripts and agents)

  quadeck backup status [--refresh]       plan, last runs, next run, repository (--refresh: read the snapshots now)
  quadeck backup snapshots [--refresh]    the snapshots in the repository
  quadeck backup suggest                  folders, exclusions and units the Quadlets suggest, with the reasons
  quadeck backup dirs <path>              sub-folders of a folder, the disk it is on and its free space
  quadeck backup sizes <path>… [--exclude <path>]…   size of folders (du)
  quadeck backup plan show                the plan as JSON
  quadeck backup plan draft               a new plan from the suggestions (to edit and set)
  quadeck backup plan set -f <file|-> [--secrets <file>] [--dry-run]
                                          check a plan, show what changes; without --dry-run save it
                                          (creates or opens the repository, writes the timer)
  quadeck backup run | check              back up now / check the repository (what the timers run)
  quadeck backup clients                  the backup target for other computers and its clients (plan, online, waiting)
  quadeck backup client plan show <name>
  quadeck backup client plan set <name> -f <file|-> [--dry-run]
  quadeck backup guide [--skill]          how an agent goes about setting up a backup (as a SKILL.md)
  quadeck backup skill install [--dir <dir>]   that guide as a skill for Claude Code (no root needed;
                                          default ~/.claude/skills/quadeck-server-backup)

--secrets: KEY=value lines with the target's credentials (S3, B2, REST); stored ones stay when left out.`

/** The guide as a skill: Claude Code reads the head to know when to load it. */
export const BACKUP_CLI_SKILL_HEAD = `---
name: quadeck-server-backup
description: Set up or change the backup of this Quadeck server and of the computers that back up to it (restic) with \`sudo quadeck backup\` – what to back up from the containers, what to leave out, sizes, the target disk, schedule and retention, checked with a dry run before saving. Use when the person asks about backups on this server or of its clients.
---

`

export const BACKUP_CLI_GUIDE = `# Setting up Quadeck backups from the command line

You are on a Quadeck server. The commands need root: run them with \`sudo\`. Quadeck backs up the server with restic and is the backup
target (a restic rest-server) for other computers at home. Every command takes --json.

## The server backup

1. Look at what there is:
   - \`quadeck backup status --json\`: is there a plan, how did the last runs go.
   - \`quadeck backup suggest --json\`: folders of the containers (from the Quadlets). \`checked\`
     is the suggestion; \`reason\` says why one is not checked: \`broad\` (a whole disk or home),
     \`contains\` (holds folders of other containers), \`media\` (movies, music, downloads: big and
     usually replaceable). \`readOnly\` folders are mounted read-only (a library). \`excludes\` are
     folders an app rebuilds by itself (caches, thumbnails).
2. Look closer where it is unclear: \`quadeck backup dirs /srv --json\`, \`quadeck backup sizes
   /srv/app/data --exclude /srv/app/data/cache --json\`.
3. Write a plan: start from \`quadeck backup plan draft --json\` (or \`plan show\` to change the
   current one) and edit it. Fields:
   - \`repo\`: \`{ "kind": "local", "location": "/mnt/backup/restic" }\` (also sftp, s3, b2, rest).
     A local target must not be inside a backed-up folder, nor the other way round, and should be
     on another disk (\`dirs <target> --json\` shows the disk).
   - \`paths\`: absolute folders, or \`volume:<name>\` for a podman volume. At most 50.
   - \`exclude\`: \`presets\` (caches, temp, logs, nobackup), \`dirs\` (absolute folders),
     \`patterns\` (restic patterns like \`*.iso\`, \`**/node_modules\`), \`maxSizeGB\` (optional).
   - \`schedule\`: \`{ "every": "daily" | "6h" | "weekly", "time": "02:00" }\`.
   - \`keep\`: snapshots to keep per day/week/month/year, e.g. \`{ "daily": 7, "weekly": 4, "monthly": 12 }\`.
   - \`check\`: monthly, weekly or never (restic check reading 5 % of the data).
4. Check it: \`quadeck backup plan set -f plan.json --dry-run --json\` checks the plan and lists the
   changes, sizes and the target's disk. Show the person what you suggest and why (what is left out
   and how big it is) before you go on.
5. When they agree: \`quadeck backup plan set -f plan.json --json\`. For S3, B2 or REST pass the
   credentials with \`--secrets <file>\` (KEY=value lines), never on the command line.
6. \`quadeck backup run\` makes the first backup now (it can take long); \`status --json\` shows it.

The repository password is generated on the first save; the person should keep it somewhere else
(Backups page → Show password). Do not print or copy it yourself.

## Clients (other computers)

A computer is connected first and gets its plan afterwards:

1. Connect: the person adds it on the Backups page (Clients → + Add client, only a name) and runs
   the command shown there on the computer. It installs \`quadeck-backup\`, asks for the
   repository password and connects to Quadeck – without a plan, so nothing is backed up yet. It
   sends its folder list right away.
2. Set the plan: here with \`client plan set <name> -f plan.json [--dry-run]\`, or on the computer
   with \`quadeck-backup plan set\` (better: \`quadeck-backup guide\` there – it sees its own folders).
   The computer picks up a new plan within about 10 minutes (its agent timer asks Quadeck every 10
   minutes) or with its next backup.

\`quadeck backup clients --json\` lists them: \`plan\` (absent: none yet), \`version\` and \`applied\`
(the version the computer runs: smaller means it is still waiting), \`lastSeen\` (online when
within 25 minutes), \`changed\` (\`by\`: ui, cli or client). \`client plan show <name> --json\` prints
the plan (null when there is none). Fields: \`folders\` (\`~/Documents\` or absolute), \`exclude\`
(\`presets\`: caches, trash, dev, temp, downloads, vms, games, nobackup; \`patterns\`; \`maxSizeGB\`),
\`schedule\` (\`every\`: hourly, 6h, daily, weekly; \`time\`), \`keep\`, \`active\`.
`

interface Args {
  pos: string[]
  json: boolean
  dryRun: boolean
  refresh: boolean
  file?: string
  secrets?: string
  dir?: string
  skill: boolean
  exclude: string[]
}

export function parseCliArgs(argv: string[]): Args {
  const a: Args = { pos: [], json: false, dryRun: false, refresh: false, skill: false, exclude: [] }
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new HttpError(400, `${x} needs a value`)
      return v
    }
    if (x === '--json') a.json = true
    else if (x === '--dry-run' || x === '-n') a.dryRun = true
    else if (x === '--refresh') a.refresh = true
    else if (x === '--skill') a.skill = true
    else if (x === '--dir') a.dir = value()
    else if (x === '-f' || x === '--file') a.file = value()
    else if (x === '--secrets') a.secrets = value()
    else if (x === '--exclude') a.exclude.push(value())
    else if (x.startsWith('--file=')) a.file = x.slice(7)
    else if (x.startsWith('--secrets=')) a.secrets = x.slice(10)
    else if (x.startsWith('--exclude=')) a.exclude.push(x.slice(10))
    else if (x.startsWith('-') && x !== '-') throw new HttpError(400, `unknown option ${x}`)
    else a.pos.push(x)
  }
  return a
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function listChanges(label: string, before: string[] = [], after: string[] = []): string[] {
  return [...after.filter((x) => !before.includes(x)).map((x) => `+ ${label}: ${x}`), ...before.filter((x) => !after.includes(x)).map((x) => `- ${label}: ${x}`)]
}

function valueChange(label: string, before: unknown, after: unknown, show = (v: unknown) => (v === undefined ? 'none' : typeof v === 'string' ? v : JSON.stringify(v))): string[] {
  return same(before, after) ? [] : [`~ ${label}: ${show(before)} → ${show(after)}`]
}

const keepText = (k?: BackupPlan['keep']) => (k ? `daily ${k.daily}, weekly ${k.weekly}, monthly ${k.monthly}${k.yearly ? `, yearly ${k.yearly}` : ''}` : 'none')

/** What a new server plan changes, one line per change (`+` added, `-` removed, `~` changed). */
export function backupPlanChanges(before: BackupPlan | undefined, after: BackupPlan): string[] {
  if (!before) return ['+ new plan']
  return [
    ...valueChange('target', `${before.repo.kind}:${before.repo.location}`, `${after.repo.kind}:${after.repo.location}`),
    ...listChanges('folder', before.paths, after.paths),
    ...listChanges('preset', before.exclude.presets, after.exclude.presets),
    ...listChanges('excluded folder', before.exclude.dirs, after.exclude.dirs),
    ...listChanges('pattern', before.exclude.patterns, after.exclude.patterns),
    ...valueChange('max file size (GB)', before.exclude.maxSizeGB, after.exclude.maxSizeGB),
    ...listChanges('stopped unit', before.stop, after.stop),
    ...valueChange('schedule', before.schedule, after.schedule, (v) => {
      const s = v as BackupPlan['schedule']
      return `${s.every} ${s.time}`
    }),
    ...valueChange('keep', before.keep, after.keep, (v) => keepText(v as BackupPlan['keep'])),
    ...valueChange('check', before.check, after.check),
  ]
}

/** What a new client plan changes. */
export function clientPlanChanges(before: ClientPlan | undefined, after: ClientPlan): string[] {
  if (!before) return ['+ new plan']
  return [
    ...listChanges('folder', before.folders, after.folders),
    ...listChanges('preset', before.exclude.presets, after.exclude.presets),
    ...listChanges('pattern', before.exclude.patterns, after.exclude.patterns),
    ...valueChange('max file size (GB)', before.exclude.maxSizeGB, after.exclude.maxSizeGB),
    ...valueChange('schedule', before.schedule, after.schedule, (v) => {
      const s = v as ClientPlan['schedule']
      return `${s.every} ${s.time}`
    }),
    ...valueChange('keep', before.keep, after.keep, (v) => keepText(v as ClientPlan['keep'])),
    ...valueChange('active', before.active, after.active),
  ]
}

const human = (n?: number) => {
  if (n === undefined) return '?'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}
const when = (t?: number) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '–')

/** A client in one line: connected or not, its plan and whether it runs it, its last backup. */
export function clientLine(c: BackupClient, now = Date.now()): string {
  const seen = !clientConnected(c) ? 'never connected' : clientOnline(c, now) ? 'online' : c.lastSeen ? `last seen ${when(c.lastSeen)}` : 'connected'
  const plan = !c.plan
    ? 'no plan yet'
    : `plan v${c.version ?? 0} ${c.applied && c.applied.version >= (c.version ?? 0) ? 'applied' : 'waiting for the computer'}${c.changed ? ` (changed ${c.changed.by === 'client' ? 'on the computer' : `in Quadeck${c.changed.by === 'cli' ? ' (cli)' : ''}`} ${when(c.changed.at)})` : ''}: ${c.plan.folders.join(' ')}`
  const queued = c.actions?.length ? `, asked: ${c.actions.join(' ')}` : ''
  return `${c.name}${c.disabled ? ' (disabled)' : ''}: ${seen}, ${plan}${queued}; last backup ${when(c.lastAt)}, ${c.snapshots ?? 0} snapshots`
}

function readJsonFile(deps: BackupCliDeps, path: string | undefined): unknown {
  if (!path) throw new HttpError(400, 'a plan file is needed: -f <file> (or -f - for stdin)')
  const text = deps.read(path)
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new HttpError(400, `${path}: not JSON (${(e as Error).message})`)
  }
}

/** KEY=value lines; # comments and empty lines are skipped. */
export function parseSecretsFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (!l || l.startsWith('#')) continue
    const i = l.indexOf('=')
    if (i <= 0) throw new HttpError(400, 'secrets: KEY=value lines')
    out[l.slice(0, i).trim()] = l.slice(i + 1).trim()
  }
  return out
}

/** Runs one `quadeck backup …` command; returns the exit code. */
export async function backupCli(argv: string[], deps: BackupCliDeps): Promise<number> {
  let a: Args = { pos: [], json: argv.includes('--json'), dryRun: false, refresh: false, skill: false, exclude: [] }
  const emit = (data: unknown, text: () => string) => deps.out(a.json ? JSON.stringify(localizeDeep(data, 'en'), null, 2) : localize(text(), 'en'))
  try {
    a = parseCliArgs(argv)
    const [cmd, sub, name] = a.pos
    const b = deps.backup
    switch (cmd) {
      case undefined:
      case 'help':
        deps.out(BACKUP_CLI_HELP)
        return 0
      case 'guide':
        deps.out(a.skill ? BACKUP_CLI_SKILL_HEAD + BACKUP_CLI_GUIDE : BACKUP_CLI_GUIDE)
        return 0
      case 'skill': {
        if (sub !== 'install' || !deps.write) throw new HttpError(400, 'usage: quadeck backup skill install [--dir <dir>]')
        const path = join(a.dir ?? join(deps.home ?? homedir(), '.claude/skills/quadeck-server-backup'), 'SKILL.md')
        deps.write(path, BACKUP_CLI_SKILL_HEAD + BACKUP_CLI_GUIDE)
        emit({ path }, () => `Skill written to ${path} – Claude Code uses it when you ask about backups on this server.`)
        return 0
      }
      case 'run':
      case 'check': {
        const fn = cmd === 'run' ? b.runBackup : b.runCheck
        if (!fn) throw new HttpError(500, 'not available')
        const r = await fn.call(b)
        if (a.json) emit(r, () => '')
        return r.status === 'failed' ? 1 : 0
      }
      case 'status': {
        const s = await b.backupState(a.refresh)
        emit(s, () => {
          const lines = [`restic: ${s.installed ? (s.version ?? 'installed') : 'not installed'}`]
          if (!s.plan) return [...lines, 'No backup set up yet. Start with: quadeck backup guide'].join('\n')
          const last = s.runs.find((r) => r.kind === 'backup')
          lines.push(
            `target:    ${s.plan.repo.kind === 'local' ? s.plan.repo.location : `${s.plan.repo.kind}:${s.plan.repo.location}`}${s.target ? ` (${human(s.target.free)} free)` : ''}`,
            `folders:   ${s.plan.paths.join(', ')}`,
            `schedule:  ${s.plan.schedule.every} ${s.plan.schedule.time}, next ${when(s.next)}${s.running ? ` – running: ${s.running}` : ''}`,
            `last run:  ${last ? `${when(last.startedAt)} ${last.status}${last.message ? ` – ${last.message}` : ''}` : 'never'}`,
            `snapshots: ${s.snapshots.length}${s.repoSize !== undefined ? `, ${human(s.repoSize)}` : ''}${s.repoError ? ` – ${s.repoError}` : ''}`,
          )
          if (!s.plan.passwordSaved) lines.push('The repository password is not marked as stored elsewhere yet (Backups page → Show password).')
          return lines.join('\n')
        })
        return 0
      }
      case 'snapshots': {
        const s = await b.backupState(a.refresh)
        emit(s.snapshots, () => (s.snapshots.length ? s.snapshots.map((x) => `${x.short}  ${when(x.time)}  ${human(x.bytes)}  ${x.paths.join(' ')}`).join('\n') : 'No snapshots.'))
        return 0
      }
      case 'suggest': {
        const s = await b.backupSuggest()
        emit(s, () =>
          [
            'Folders ([x] suggested):',
            ...s.paths.map((p) => `  [${p.checked ? 'x' : ' '}] ${p.path}  (${p.from}${p.readOnly ? ', read-only' : ''}${p.reason ? `, ${p.reason}` : ''})`),
            ...(s.excludes.length ? ['Rebuilt by the app (excluded):', ...s.excludes.map((e) => `  ${e.path}  (${e.label}, ${e.from})`)] : []),
          ].join('\n'),
        )
        return 0
      }
      case 'dirs': {
        const l = await b.backupDirs(sub ?? '/', [])
        emit(l, () =>
          [
            l.path + (l.missing ? `  (${sub} does not exist)` : ''),
            ...l.dirs.map((d) => `  ${d}/`),
            ...(l.disk ? [`disk ${l.disk.mount}: ${human(l.disk.free)} free of ${human(l.disk.size)}`] : []),
          ].join('\n'),
        )
        return 0
      }
      case 'sizes': {
        const paths = a.pos.slice(1)
        if (!paths.length) throw new HttpError(400, 'usage: quadeck backup sizes <path>… [--exclude <path>]…')
        const s = await b.backupSizes(paths, a.exclude)
        emit(s, () => [...s.paths.map((p) => `${human(p.bytes).padStart(9)}  ${p.path}`), ...s.excludes.map((p) => `${human(p.bytes).padStart(9)}  ${p.path} (excluded)`)].join('\n'))
        return 0
      }
      case 'plan':
        return await planCommand(sub, a, deps, emit)
      case 'clients': {
        const t = await b.targetState()
        emit(t, () => {
          if (!t.config) return 'No backup target for clients set up (Backups page → Clients).'
          return [`rest-server ${t.config.url}, data in ${t.config.dataDir}${t.config.appendOnly ? ', append-only' : ''}`, ...t.clients.map((c) => `  ${clientLine(c)}`)].join('\n')
        })
        return 0
      }
      case 'client': {
        if (sub !== 'plan') throw new HttpError(400, 'usage: quadeck backup client plan show|set <name> …')
        return await clientPlanCommand(name, a.pos[3], a, deps, emit)
      }
      default:
        throw new HttpError(400, `unknown command: ${cmd} (quadeck backup help)`)
    }
  } catch (e) {
    const message = localize((e as Error).message, 'en')
    if (a.json) deps.out(JSON.stringify({ error: message }, null, 2))
    else deps.err(`quadeck backup: ${message}`)
    return e instanceof HttpError && e.status === 400 ? 2 : 1
  }
}

type Emit = (data: unknown, text: () => string) => void

async function planCommand(sub: string | undefined, a: Args, deps: BackupCliDeps, emit: Emit): Promise<number> {
  const b = deps.backup
  const current = (await b.backupState()).plan
  if (sub === 'show') {
    emit(current ?? null, () => (current ? JSON.stringify(current, null, 2) : 'No plan yet. A draft: quadeck backup plan draft'))
    return 0
  }
  if (sub === 'draft') {
    const draft = defaultPlan(await b.backupSuggest())
    emit(draft, () => JSON.stringify(draft, null, 2))
    return 0
  }
  if (sub !== 'set') throw new HttpError(400, 'usage: quadeck backup plan show|draft|set …')
  const raw = readJsonFile(deps, a.file) as Record<string, unknown>
  // Left out: kept as it is (the confirmation that the password is stored elsewhere is the person's).
  const input = raw && typeof raw === 'object' && !('passwordSaved' in raw) && current ? { ...raw, passwordSaved: current.passwordSaved } : raw
  const { plan, error } = parseBackupPlan(input)
  if (!plan) throw new HttpError(400, error!)
  const changes = backupPlanChanges(current, plan)
  const secretsIn = a.secrets ? parseSecretsFile(deps.read(a.secrets)) : {}
  const unknown = Object.keys(secretsIn).filter((k) => !REPO_SECRETS[plan.repo.kind].includes(k))
  if (unknown.length) throw new HttpError(400, `secrets not used by a ${plan.repo.kind} target: ${unknown.join(', ')}`)
  const s = parseSecrets(plan.repo.kind, secretsIn)
  if (!s.secrets) throw new HttpError(400, s.error!)
  const sizes = await b.backupSizes(plan.paths, plan.exclude.dirs).catch(() => undefined)
  const target = plan.repo.kind === 'local' ? await b.backupDirs(plan.repo.location, plan.paths).catch(() => undefined) : undefined
  const total = sizes?.paths.reduce((n, p) => n + (p.bytes ?? 0), 0)
  const excluded = sizes?.excludes.reduce((n, p) => n + (p.bytes ?? 0), 0)
  const warnings = [
    ...(target?.sameDisk.length ? [`the target is on the same disk as ${target.sameDisk.join(', ')}: if the disk fails, data and backup are both gone`] : []),
    ...(target?.missing && target.path !== plan.repo.location.slice(0, plan.repo.location.lastIndexOf('/')) ? [`${target.path} is the closest folder that exists – is the disk mounted?`] : []),
    ...(sizes?.paths.filter((p) => p.bytes === undefined).map((p) => `${p.path} does not exist (yet)`) ?? []),
  ]
  const report = {
    dryRun: a.dryRun,
    changes,
    sizes: sizes ? { total, excluded, paths: sizes.paths, excludes: sizes.excludes } : undefined,
    ...(target?.disk ? { targetDisk: target.disk } : {}),
    warnings,
    plan,
  }
  const text = () =>
    [
      changes.length ? changes.join('\n') : 'No changes.',
      ...(sizes ? [`size: about ${human(total ?? 0)} without the exclusions${excluded ? `, ${human(excluded)} of it in excluded folders` : ''}`] : []),
      ...(target?.disk ? [`target disk ${target.disk.mount}: ${human(target.disk.free)} free`] : []),
      ...warnings.map((w) => `warning: ${w}`),
      a.dryRun ? '(dry run: nothing saved)' : 'Saved.',
    ].join('\n')
  if (!a.dryRun) await b.saveBackupPlan(plan, s.secrets)
  emit(report, text)
  return 0
}

async function clientPlanCommand(action: string | undefined, clientName: string | undefined, a: Args, deps: BackupCliDeps, emit: Emit): Promise<number> {
  if ((action !== 'show' && action !== 'set') || !clientName || !CLIENT_NAME.test(clientName)) throw new HttpError(400, 'usage: quadeck backup client plan show|set <name> …')
  const t = await deps.backup.targetState()
  const c = t.clients.find((x) => x.name === clientName)
  if (!c) throw new HttpError(404, `no client called ${clientName}`)
  if (action === 'show') {
    emit(c.plan ?? null, () =>
      c.plan ? JSON.stringify(c.plan, null, 2) : `${clientName} has no plan yet. Write one (fields: quadeck backup guide) and set it: quadeck backup client plan set ${clientName} -f plan.json`,
    )
    return 0
  }
  const { plan, error } = parseClientPlan(readJsonFile(deps, a.file))
  if (!plan) throw new HttpError(400, error!)
  const changes = clientPlanChanges(c.plan, plan)
  if (!a.dryRun && changes.length) await deps.backup.setClientPlan(clientName, plan, 'cli')
  emit({ dryRun: a.dryRun, changes, plan }, () =>
    [
      changes.length ? changes.join('\n') : 'No changes.',
      a.dryRun ? '(dry run: nothing saved)' : changes.length ? `Saved. ${clientName} picks it up within about 10 minutes (or with its next backup).` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
  return 0
}

/** Writes a file and its folder (for the skill). */
export function writeOutput(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** Reads a file, `-` for stdin. */
export function readInput(path: string): string {
  return readFileSync(path === '-' ? 0 : path, 'utf8')
}
