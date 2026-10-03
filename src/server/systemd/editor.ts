// systemd unit editor: read a unit with all its files, check changes with
// `systemd-analyze verify`, write own units and drop-ins in /etc/systemd/system
// (vendor files stay untouched), keep earlier versions. SystemUnitEditor runs
// where root is; FixtureUnitEditor keeps demo files in memory.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { HttpError } from '../auth'
import { run } from '../exec'
import { parseShow, quadletOf } from '../collectors/systemd'
import { validContent } from '../quadlets/backend'
import { msg } from '~/shared/i18n'
import type { Diagnostic, Revision } from '~/shared/quadlets'
import { NEW_UNIT, PROTECTED_UNIT, UNIT_DIR, assertUnit, lintUnit, originOf, writablePath, type UnitDetail, type UnitFilePart, type UnitValidateResult, type UnitWriteResult } from '~/shared/unit-files'
import { LEGACY_MANAGED_HEADER, MANAGED_HEADER } from '~/shared/timers'

export interface UnitEditorAdmin {
  unitDetail(unit: string): Promise<UnitDetail>
  validateUnitFile(unit: string, path: string, content: string): Promise<UnitValidateResult>
  unitFileHistory(unit: string, path: string): Promise<Revision[]>
  unitFileRevision(unit: string, path: string, id: string): Promise<string>
}

/** Writes; the caller has checked the unlock. */
export interface UnitEditorBackend extends UnitEditorAdmin {
  writeUnitFile(unit: string, path: string, content: string, restart: boolean): Promise<UnitWriteResult>
  deleteUnitFile(unit: string, path: string): Promise<void>
  createUnit(unit: string, content: string, enable: boolean): Promise<UnitWriteResult>
  setUnitEnabled(unit: string, enabled: boolean): Promise<void>
}

export function validUnit(unit: string) {
  try {
    assertUnit(unit)
  } catch (e) {
    throw new HttpError(400, (e as Error).message)
  }
}

function notProtected(unit: string) {
  if (PROTECTED_UNIT.test(unit)) throw new HttpError(403, msg('systemd_belongsQuadeckItselfNotChanged', { unit }))
}

/**
 * Maps `systemd-analyze verify` output to diagnostics: lines about our temp
 * copy get the original path and line, other files of the unit are named.
 */
export function verifyDiagnostics(output: string, unit: string, tmp: string, edited: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const seen = new Set<string>()
  for (const raw of output.split('\n')) {
    const l = raw.trim()
    if (!l || /^Binding to IPv6/.test(l)) continue
    const at = l.match(/^(\/\S+?):(\d+): (.*)$/)
    let message: string
    let line: number | undefined
    if (at) {
      if (!at[1]!.includes(unit)) continue
      if (at[1] === edited) {
        line = Number(at[2])
        message = at[3]!
      } else if (at[1]!.startsWith(tmp + '/')) message = msg('systemd_mainFileLine', { value: at[2] }) + `: ${at[3]}`
      else message = `${at[1]}:${at[2]}: ${at[3]}`
    } else if (l.startsWith(`${unit}: `) || l.startsWith(`Unit ${unit} `)) message = l.replace(`${unit}: `, '')
    else continue
    message = message.split(tmp + '/').join('')
    if (seen.has(message + line)) continue
    seen.add(message + line)
    const core = at ? at[3]! : message
    const warning = /^Unknown (key|section|lvalue)|is not executable|not found|deprecated/i.test(core) && !/Refusing/.test(core)
    if (/has a bad unit file setting/.test(message) && out.some((d) => d.severity === 'error')) continue
    out.push({ line, severity: warning ? 'warning' : 'error', message })
  }
  return out
}

/**
 * Checks a unit file in a temp directory: the edited file plus the fragment;
 * drop-ins elsewhere are loaded by systemd from their usual places (a copy
 * with the same name in the temp directory wins).
 */
export async function verifyUnitFile(unit: string, path: string, kind: 'fragment' | 'dropin', content: string, fragment: string | undefined): Promise<UnitValidateResult> {
  const local = lintUnit(content, kind)
  if (local.some((d) => d.severity === 'error')) return { ok: false, diagnostics: local }
  if (unit.includes('@')) return { ok: true, diagnostics: local, skipped: msg('systemd_systemdOnlyChecksTemplateUnits') }
  if (!Bun.which('systemd-analyze')) return { ok: true, diagnostics: local, skipped: msg('systemd_systemdAnalyzeMissingSyntaxChecked') }
  const tmp = mkdtempSync(join(tmpdir(), 'quadeck-verify-'))
  try {
    writeFileSync(join(tmp, unit), kind === 'fragment' ? content : (fragment ?? ''))
    if (kind === 'dropin') {
      mkdirSync(join(tmp, `${unit}.d`))
      writeFileSync(join(tmp, `${unit}.d`, basename(path)), content)
    }
    const r = await run(['systemd-analyze', 'verify', '--man=no', '--', join(tmp, unit)], { timeoutMs: 30_000 })
    const diagnostics = [...local, ...verifyDiagnostics(`${r.stderr}\n${r.stdout}`, unit, tmp, kind === 'fragment' ? join(tmp, unit) : join(tmp, `${unit}.d`, basename(path)))]
    return { ok: !diagnostics.some((d) => d.severity === 'error'), diagnostics }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------- history ----------

const KEEP = 30

export class UnitHistory {
  constructor(private dir: string) {}

  private folder(path: string) {
    return join(this.dir, encodeURIComponent(path))
  }

  list(path: string): Revision[] {
    let files: string[] = []
    try {
      files = readdirSync(this.folder(path))
    } catch {
      return []
    }
    return files
      .map((f) => f.match(/^(\d+)-(\d+)\.(original|saved|deleted)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ id: `${m[1]}-${m[2]}`, date: Number(m[1]), message: m[3] === 'original' ? msg('common_history_original') : m[3] === 'saved' ? msg('notifications_saved') : msg('systemd_beforeDeletion') }))
      .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))
  }

  read(path: string, id: string): string {
    if (!/^\d+-\d+$/.test(id)) throw new HttpError(400, msg('systemd_invalidVersion'))
    const f = readdirSync(this.folder(path)).find((x) => x.startsWith(`${id}.`))
    if (!f) throw new HttpError(404, msg('common_errors_versionNotFound'))
    return readFileSync(join(this.folder(path), f), 'utf8')
  }

  private seq = 0
  add(path: string, content: string, kind: 'original' | 'saved' | 'deleted') {
    const dir = this.folder(path)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, `${Date.now()}-${++this.seq % 1000}.${kind}`), content, { mode: 0o600 })
    const all = this.list(path)
    for (const r of all.slice(KEEP)) for (const f of readdirSync(dir).filter((x) => x.startsWith(`${r.id}.`))) rmSync(join(dir, f), { force: true })
  }

  /** Before the first change of a file, its state then. */
  saved(path: string, before: string | undefined, after: string) {
    if (before !== undefined && !this.list(path).length) this.add(path, before, 'original')
    this.add(path, after, 'saved')
  }
}

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

function atomicWrite(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
  const tmp = `${path}.quadeck-tmp`
  writeFileSync(tmp, content.endsWith('\n') ? content : content + '\n', { mode: 0o644 })
  renameSync(tmp, path)
}

const isManagedTimer = (content: string | undefined) => !!content && (content.includes(MANAGED_HEADER) || content.includes(LEGACY_MANAGED_HEADER))

export class SystemUnitEditor implements UnitEditorBackend {
  private history: UnitHistory

  constructor(
    private dir = process.env.QUADECK_UNIT_DIR || UNIT_DIR,
    historyDir = process.env.QUADECK_UNIT_HISTORY || '/var/lib/quadeck-helper/unit-history',
  ) {
    this.history = new UnitHistory(historyDir)
  }

  private async props(unit: string) {
    const r = await run(['systemctl', 'show', '-p', 'Id,Description,LoadState,ActiveState,UnitFileState,FragmentPath,DropInPaths,SourcePath', '--', unit])
    if (r.code !== 0) throw new HttpError(503, `systemctl: ${(r.stderr || r.stdout).trim()}`)
    return parseShow(r.stdout)[0] ?? {}
  }

  async unitDetail(unit: string): Promise<UnitDetail> {
    validUnit(unit)
    const p = await this.props(unit)
    const fragmentPath = p.FragmentPath || undefined
    if (p.LoadState === 'not-found' && !fragmentPath) throw new HttpError(404, msg('systemd_doesNotExist', { unit }))
    const protectedUnit = PROTECTED_UNIT.test(unit)
    const parts: UnitFilePart[] = []
    if (fragmentPath) {
      const own = writablePath(unit, fragmentPath, this.dir) === 'fragment' && !lstatSync(fragmentPath, { throwIfNoEntry: false })?.isSymbolicLink()
      parts.push({ path: fragmentPath, kind: 'fragment', origin: originOf(fragmentPath), content: read(fragmentPath) ?? '', editable: own && !protectedUnit })
    }
    for (const d of (p.DropInPaths ?? '').split(/\s+/).filter(Boolean)) {
      const kind = writablePath(unit, d, this.dir)
      parts.push({ path: d, kind: 'dropin', origin: originOf(d), content: read(d) ?? '', editable: kind === 'dropin' && !protectedUnit && !lstatSync(d, { throwIfNoEntry: false })?.isSymbolicLink() })
    }
    const origin = fragmentPath ? originOf(fragmentPath) : 'vendor'
    const override = `${this.dir}/${unit}.d/override.conf`
    return {
      unit,
      description: p.Description || undefined,
      loadState: p.LoadState ?? 'unknown',
      activeState: p.ActiveState ?? 'unknown',
      unitFileState: p.UnitFileState || undefined,
      parts,
      overridePath: protectedUnit || origin === 'transient' || parts.some((x) => x.path === override) ? undefined : override,
      readonly: protectedUnit ? msg('systemd_belongsQuadeckItselfChangesHere') : origin === 'transient' ? msg('systemd_transientUnitSystemdRunDisappears') : undefined,
      quadlet: quadletOf(p.SourcePath)?.file,
      managedTimer: isManagedTimer(parts[0]?.content),
      template: unit.includes('@') && !!fragmentPath && basename(fragmentPath) !== unit,
      canDelete: parts[0]?.kind === 'fragment' && parts[0].editable,
    }
  }

  private async target(unit: string, path: string) {
    validUnit(unit)
    notProtected(unit)
    const kind = writablePath(unit, path, this.dir)
    if (!kind) throw new HttpError(403, msg('systemd_notChangePackageFilesOverride', { path, dir: this.dir }))
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new HttpError(409, msg('systemd_symlinkWillNotOverwritten', { path }))
    return kind
  }

  async validateUnitFile(unit: string, path: string, content: string) {
    validContent(content)
    const kind = await this.target(unit, path)
    const p = kind === 'dropin' ? await this.props(unit) : {}
    return verifyUnitFile(unit, path, kind, content, p.FragmentPath ? read(p.FragmentPath) : undefined)
  }

  async unitFileHistory(unit: string, path: string) {
    validUnit(unit)
    if (!writablePath(unit, path, this.dir)) return []
    return this.history.list(path)
  }

  async unitFileRevision(unit: string, path: string, id: string) {
    validUnit(unit)
    if (!writablePath(unit, path, this.dir)) throw new HttpError(404, msg('systemd_noHistory'))
    return this.history.read(path, id)
  }

  private async reload() {
    const r = await run(['systemctl', 'daemon-reload'], { timeoutMs: 60_000 })
    if (r.code !== 0) throw new Error(`daemon-reload: ${(r.stderr || r.stdout).trim()}`)
  }

  private async restartIfActive(unit: string): Promise<UnitWriteResult> {
    const state = (await run(['systemctl', 'is-active', '--', unit])).stdout.trim()
    if (state !== 'active' && state !== 'activating' && state !== 'reloading') return { restarted: false }
    const r = await run(['systemctl', 'restart', '--', unit], { timeoutMs: 120_000 })
    if (r.code !== 0) return { restarted: false, warning: msg('systemd_savedButDoesNotRestart', { unit, value: (r.stderr || r.stdout).trim() }) }
    return { restarted: true }
  }

  async writeUnitFile(unit: string, path: string, content: string, restart: boolean) {
    const check = await this.validateUnitFile(unit, path, content)
    const err = check.diagnostics.find((d) => d.severity === 'error')
    if (err) throw new HttpError(422, `${err.line ? msg('fstab_line', { line: err.line }) : ''}${err.message}`)
    const before = read(path)
    atomicWrite(path, content)
    this.history.saved(path, before, content)
    await this.reload()
    return restart ? this.restartIfActive(unit) : { restarted: false }
  }

  async deleteUnitFile(unit: string, path: string) {
    const kind = await this.target(unit, path)
    const before = read(path)
    if (before === undefined) throw new HttpError(404, msg('systemd_doesNotExist2', { path }))
    if (kind === 'fragment') await run(['systemctl', 'disable', '--now', '--', unit], { timeoutMs: 120_000 })
    this.history.add(path, before, 'deleted')
    rmSync(path, { force: true })
    if (kind === 'dropin') {
      try {
        rmdirSync(dirname(path)) // only when empty
      } catch {
        // other drop-ins remain
      }
    }
    await this.reload()
    if (kind === 'fragment') await run(['systemctl', 'reset-failed', '--', unit])
  }

  async createUnit(unit: string, content: string, enable: boolean) {
    if (!NEW_UNIT.test(unit)) throw new HttpError(400, msg('systemd_nameLettersDigitsSuffixLike'))
    notProtected(unit)
    const path = `${this.dir}/${unit}`
    const p = await this.props(unit)
    if (existsSync(path) || (p.LoadState && p.LoadState !== 'not-found')) throw new HttpError(409, msg('systemd_alreadyExists', { unit }))
    const check = await verifyUnitFile(unit, path, 'fragment', content, undefined)
    const err = check.diagnostics.find((d) => d.severity === 'error')
    if (err) throw new HttpError(422, `${err.line ? msg('fstab_line', { line: err.line }) : ''}${err.message}`)
    atomicWrite(path, content)
    this.history.saved(path, undefined, content)
    await this.reload()
    if (!enable) return { restarted: false }
    let r = await run(['systemctl', 'enable', '--now', '--', unit], { timeoutMs: 120_000 })
    // Without [Install] there is nothing to enable: just start it.
    if (r.code !== 0 && /no installation config|not meant to be enabled/i.test(r.stderr)) r = await run(['systemctl', 'start', '--', unit], { timeoutMs: 120_000 })
    return r.code === 0 ? { restarted: true } : { restarted: false, warning: msg('systemd_createdButStartFailedSee', { value: (r.stderr || r.stdout).trim() }) }
  }

  async setUnitEnabled(unit: string, enabled: boolean) {
    validUnit(unit)
    notProtected(unit)
    const r = await run(['systemctl', enabled ? 'enable' : 'disable', '--', unit], { timeoutMs: 60_000 })
    if (r.code !== 0) throw new HttpError(422, (r.stderr || r.stdout).trim() || msg('systemd_systemctlFailed', { action: enabled ? 'enable' : 'disable' }))
  }
}

// ---------- fixtures ----------

interface FixtureUnit {
  name: string
  description: string
  active: string
  type?: string | null
  unitFileState?: string
  quadlet?: { file: string }
  timer?: { calendar?: string; unit?: string }
}

const EXEC: Record<string, string> = {
  'restic-backup.service': '/usr/bin/restic backup /srv /home --exclude-caches',
  'snapraid-sync.service': '/usr/bin/snapraid sync',
  'backup-offsite.service': '/usr/local/bin/backup-offsite.sh',
  'smb.service': '/usr/bin/smbd --foreground --no-process-group $SMBDOPTIONS',
}

function fixtureFragment(u: FixtureUnit): { path: string; content: string } {
  if (u.quadlet)
    return {
      path: `/run/systemd/generator/${u.name}`,
      content: `# Automatically generated by /usr/lib/systemd/system-generators/podman-system-generator\n#\n[X-Container]\n# …\n\n[Unit]\nDescription=${u.description}\nSourcePath=/etc/containers/systemd/${u.quadlet.file}\nRequiresMountsFor=%t/containers\n\n[Service]\nRestart=always\nEnvironment=PODMAN_SYSTEMD_UNIT=%n\nKillMode=mixed\nType=notify\nNotifyAccess=all\nExecStart=/usr/bin/podman run --name ${u.name.replace(/\.service$/, '')} --cidfile=%t/%N.cid --replace --rm --sdnotify=conmon -d …\n`,
    }
  if (u.timer) {
    const vendor = u.name.startsWith('podman-')
    return {
      path: `${vendor ? '/usr/lib/systemd/system' : UNIT_DIR}/${u.name}`,
      content: `[Unit]\nDescription=${u.description}\n\n[Timer]\nOnCalendar=${u.timer.calendar ?? 'daily'}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
    }
  }
  if (u.name.endsWith('.socket')) {
    const listen = (u as FixtureUnit & { socket?: { listen: string[] } }).socket?.listen[0]?.replace(/ \(.*\)$/, '') ?? '/run/x.sock'
    return { path: `/usr/lib/systemd/system/${u.name}`, content: `[Unit]\nDescription=${u.description}\n\n[Socket]\nListenStream=${listen}\nSocketMode=0660\n\n[Install]\nWantedBy=sockets.target\n` }
  }
  const vendor = u.name === 'smb.service'
  return {
    path: `${vendor ? '/usr/lib/systemd/system' : UNIT_DIR}/${u.name}`,
    content: vendor
      ? `[Unit]\nDescription=Samba SMB Daemon\nAfter=network.target nmb.service winbind.service\n\n[Service]\nType=notify\nPIDFile=/run/smbd.pid\nEnvironmentFile=-/etc/sysconfig/samba\nExecStart=${EXEC[u.name]}\nExecReload=/bin/kill -HUP $MAINPID\nLimitNOFILE=16384\n\n[Install]\nWantedBy=multi-user.target\n`
      : `[Unit]\nDescription=${u.description}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=${u.type ?? 'oneshot'}\nExecStart=${EXEC[u.name] ?? '/usr/local/bin/' + u.name.replace(/\.service$/, '')}\nNice=10\n`,
  }
}

export class FixtureUnitEditor implements UnitEditorBackend {
  private units = new Map<string, { description: string; active: string; unitFileState?: string; quadlet?: string }>()
  private files = new Map<string, string>()
  private history = new Map<string, { rev: Revision; content: string }[]>()
  private rev = 0

  constructor(dir: string) {
    const units = JSON.parse(readFileSync(join(dir, 'units.json'), 'utf8')) as FixtureUnit[]
    for (const u of units) {
      this.units.set(u.name, { description: u.description, active: u.active, unitFileState: u.unitFileState, quadlet: u.quadlet?.file })
      const f = fixtureFragment(u)
      this.files.set(f.path, f.content)
    }
    this.files.set(`${UNIT_DIR}/smb.service.d/override.conf`, '# Start Samba after the data disks are mounted\n[Unit]\nRequiresMountsFor=/srv/data\n')
  }

  private pathsOf(unit: string) {
    const frag = [`${UNIT_DIR}/${unit}`, `/usr/lib/systemd/system/${unit}`, `/run/systemd/generator/${unit}`].find((p) => this.files.has(p))
    const dropins = [...this.files.keys()].filter((p) => dirname(p).endsWith(`/${unit}.d`)).sort((a, b) => basename(a).localeCompare(basename(b)))
    return { frag, dropins }
  }

  async unitDetail(unit: string): Promise<UnitDetail> {
    validUnit(unit)
    const u = this.units.get(unit)
    const { frag, dropins } = this.pathsOf(unit)
    if (!u || !frag) throw new HttpError(404, msg('systemd_doesNotExist', { unit }))
    const protectedUnit = PROTECTED_UNIT.test(unit)
    const parts: UnitFilePart[] = [frag, ...dropins].map((p, i) => ({
      path: p,
      kind: i === 0 ? 'fragment' : 'dropin',
      origin: originOf(p),
      content: this.files.get(p)!,
      editable: !protectedUnit && writablePath(unit, p) === (i === 0 ? 'fragment' : 'dropin'),
    }))
    const override = `${UNIT_DIR}/${unit}.d/override.conf`
    return {
      unit,
      description: u.description,
      loadState: 'loaded',
      activeState: u.active,
      unitFileState: u.unitFileState,
      parts,
      overridePath: protectedUnit || this.files.has(override) ? undefined : override,
      quadlet: u.quadlet,
      managedTimer: false,
      template: false,
      canDelete: parts[0]!.editable,
    }
  }

  private target(unit: string, path: string) {
    validUnit(unit)
    notProtected(unit)
    const kind = writablePath(unit, path)
    if (!kind) throw new HttpError(403, msg('systemd_notChangePackageFilesOverride2', { path, UNIT_DIR }))
    return kind
  }

  async validateUnitFile(unit: string, path: string, content: string) {
    validContent(content)
    const kind = this.target(unit, path)
    return verifyUnitFile(unit, path, kind, content, kind === 'dropin' ? this.files.get(this.pathsOf(unit).frag ?? '') : undefined)
  }

  async unitFileHistory(unit: string, path: string) {
    validUnit(unit)
    return (this.history.get(path) ?? []).map((h) => h.rev)
  }

  async unitFileRevision(unit: string, path: string, id: string) {
    validUnit(unit)
    const h = this.history.get(path)?.find((x) => x.rev.id === id)
    if (!h) throw new HttpError(404, msg('common_errors_versionNotFound'))
    return h.content
  }

  private record(path: string, content: string, message: string) {
    const list = this.history.get(path) ?? []
    list.unshift({ rev: { id: `${Date.now()}-${++this.rev}`, date: Date.now(), message }, content })
    this.history.set(path, list.slice(0, 30))
  }

  async writeUnitFile(unit: string, path: string, content: string, restart: boolean) {
    const check = await this.validateUnitFile(unit, path, content)
    const err = check.diagnostics.find((d) => d.severity === 'error')
    if (err) throw new HttpError(422, `${err.line ? msg('fstab_line', { line: err.line }) : ''}${err.message}`)
    const before = this.files.get(path)
    if (before !== undefined && !this.history.get(path)?.length) this.record(path, before, msg('common_history_original'))
    const text = content.endsWith('\n') ? content : content + '\n'
    this.files.set(path, text)
    this.record(path, text, msg('notifications_saved'))
    return { restarted: restart && this.units.get(unit)?.active === 'active' }
  }

  async deleteUnitFile(unit: string, path: string) {
    const kind = this.target(unit, path)
    const before = this.files.get(path)
    if (before === undefined) throw new HttpError(404, msg('systemd_doesNotExist2', { path }))
    this.record(path, before, msg('systemd_beforeDeletion'))
    this.files.delete(path)
    if (kind === 'fragment') {
      this.units.delete(unit)
      for (const d of this.pathsOf(unit).dropins) this.files.delete(d)
    }
  }

  async createUnit(unit: string, content: string, enable: boolean) {
    if (!NEW_UNIT.test(unit)) throw new HttpError(400, msg('systemd_nameLettersDigitsSuffixLike'))
    notProtected(unit)
    if (this.units.has(unit)) throw new HttpError(409, msg('systemd_alreadyExists', { unit }))
    const path = `${UNIT_DIR}/${unit}`
    const check = await verifyUnitFile(unit, path, 'fragment', content, undefined)
    const err = check.diagnostics.find((d) => d.severity === 'error')
    if (err) throw new HttpError(422, `${err.line ? msg('fstab_line', { line: err.line }) : ''}${err.message}`)
    const description = content.match(/^Description=(.*)$/m)?.[1]?.trim() || unit
    this.units.set(unit, { description, active: enable ? 'active' : 'inactive', unitFileState: enable ? 'enabled' : 'disabled' })
    this.files.set(path, content.endsWith('\n') ? content : content + '\n')
    this.record(path, this.files.get(path)!, msg('notifications_saved'))
    return { restarted: enable }
  }

  async setUnitEnabled(unit: string, enabled: boolean) {
    validUnit(unit)
    notProtected(unit)
    const u = this.units.get(unit)
    if (!u) throw new HttpError(404, msg('systemd_doesNotExist', { unit }))
    u.unitFileState = enabled ? 'enabled' : 'disabled'
  }
}
