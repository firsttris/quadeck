// /etc/fstab configurator. All checks and the write sequence live in
// FstabManager; what touches the machine is behind FstabHost, so the demo
// fixtures run the very same checks.
//
// Safety, in order: form checks → whole-file checks (protected lines stay,
// no duplicate targets) → device, file system and driver against the host →
// `findmnt --verify` → systemd's fstab generator on the new file (which
// entries would stop the boot) → test mount with the chosen options →
// atomic write with backup and history → daemon-reload → start/remount the
// mount unit. Any failure after writing restores the old file.

import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpError } from '../auth'
import { run } from '../exec'
import { tr } from '~/shared/i18n'
import { UnitHistory } from '../systemd/editor'
import type { Diagnostic, Revision } from '~/shared/quadlets'
import {
  FSTAB_PATH,
  FS_PACKAGE,
  FstabConflict,
  USERSPACE_OPTION,
  applyChange,
  checkFile,
  checkInput,
  isBlockSpec,
  isBootCritical,
  isNetworkSpec,
  knownOption,
  mountUnit,
  newlyCritical,
  parseFstab,
  protectedLinesChanged,
  specMatches,
  systemReason,
  targetProblem,
  type BlockDevice,
  type EntryInput,
  type FstabChange,
  type FstabCheck,
  type FstabEntry,
  type FstabState,
  type MountView,
} from '~/shared/fstab'

export interface FstabAdmin {
  fstabState(): Promise<FstabState>
  validateFstab(change: FstabChange): Promise<FstabCheck>
  fstabRevision(id: string): Promise<string>
}

/** Writes; the caller has checked the unlock. */
export interface FstabBackend extends FstabAdmin {
  applyFstab(change: FstabChange, confirmCritical: boolean): Promise<FstabState>
  mountAction(target: string, action: 'mount' | 'unmount'): Promise<FstabState>
}

export interface MountInfo {
  source: string
  fstype: string
}

export interface FstabHost {
  readonly path: string
  read(): string
  /** Atomic, keeps the previous file as <path>.quadeck-bak. */
  write(text: string): void
  devices(): Promise<BlockDevice[]>
  /** Mounted targets → source. */
  mounts(): Promise<Map<string, MountInfo>>
  usage(target: string): Promise<{ size: number; used: number } | undefined>
  driver(fstype: string): Promise<boolean>
  dirState(path: string): 'missing' | 'empty' | 'nonempty' | 'file'
  mkdir(path: string): void
  rmdirIfEmpty(path: string): void
  /** findmnt --verify output for the file, undefined without findmnt. */
  verify(text: string): Promise<string | undefined>
  /** Units in local-fs.target.requires generated from the file, undefined without the generator. */
  critical(text: string): Promise<Set<string> | undefined>
  /** Error message, or undefined when the test mount worked. */
  testMount(e: EntryInput): Promise<string | undefined>
  systemctl(args: string[]): Promise<{ ok: boolean; message: string }>
  usedBy(target: string): string[]
  history: { list(): Revision[]; read(id: string): string; saved(before: string, after: string): void }
}

const norm = (raw: string) => raw.trim().split(/\s+/).join(' ')
const fsCompatible = (want: string, have: string) =>
  want === 'auto' || want === have || (have === 'ntfs' && ['ntfs3', 'ntfs-3g', 'ntfs'].includes(want)) || (['ext2', 'ext3'].includes(have) && want === 'ext4') || (have === 'vfat' && want === 'msdos')

export class FstabManager implements FstabBackend {
  constructor(private host: FstabHost) {}

  private async context() {
    const [devices, mounts] = await Promise.all([this.host.devices(), this.host.mounts()])
    const rootSource = mounts.get('/')?.source.replace(/\[.*\]$/, '')
    const rootDev = devices.find((d) => d.path === rootSource || d.mountpoints.includes('/'))
    const text = this.host.read()
    const rootSpecs = [
      ...parseFstab(text)
        .entries.filter((e) => e.file === '/')
        .map((e) => e.spec),
      ...(rootDev ? [`UUID=${rootDev.uuid}`, `PARTUUID=${rootDev.partuuid}`, `LABEL=${rootDev.label}`, rootDev.path].filter((s) => !s.endsWith('=undefined')) : []),
    ]
    return { devices, mounts, rootSpecs, text }
  }

  async fstabState(): Promise<FstabState> {
    const { devices, mounts, rootSpecs, text } = await this.context()
    const { entries } = parseFstab(text)
    const views: MountView[] = []
    for (const e of entries) {
      const device = devices.find((d) => specMatches(e.spec, d))
      const mounted = mounts.has(e.file)
      const local = isBlockSpec(e.spec) && !['tmpfs', 'swap', 'proc', 'none'].includes(e.vfstype)
      views.push({
        ...e,
        system: systemReason(e, rootSpecs),
        device,
        mounted,
        mountedAt: !mounted ? device?.mountpoints.find((m) => m !== e.file) : undefined,
        ...(mounted ? await this.host.usage(e.file) : {}),
        bootCritical: isBootCritical(e),
        missing: local && !device,
        usedBy: this.host.usedBy(e.file),
      })
    }
    const free = devices.filter((d) => !entries.some((e) => specMatches(e.spec, d)) && !d.mountpoints.some((m) => systemReason({ spec: '', file: m, vfstype: d.fstype })))
    return { path: this.host.path, content: text, entries: views, devices: free, history: this.host.history.list() }
  }

  async fstabRevision(id: string) {
    return this.host.history.read(id)
  }

  async validateFstab(change: FstabChange): Promise<FstabCheck> {
    const ctx = await this.context()
    const before = ctx.text
    const out: Diagnostic[] = []
    const actions: string[] = []
    let usedBy: string[] = []
    let createDir: string | undefined
    let after: string
    try {
      after = applyChange(before, change)
    } catch (e) {
      if (e instanceof FstabConflict) throw new HttpError(409, e.message)
      throw e
    }
    const result = (extra: Partial<FstabCheck> = {}): FstabCheck => ({
      ok: !out.some((d) => d.severity === 'error'),
      diagnostics: out,
      before,
      after,
      bootCritical: [],
      actions,
      usedBy,
      createDir,
      ...extra,
    })

    // The entry being changed, and the one it replaces.
    const old = change.kind === 'update' || change.kind === 'remove' ? parseFstab(before).entries.find((e) => e.line === change.line) : undefined
    if (old && systemReason(old, ctx.rootSpecs)) {
      out.push({ severity: 'error', message: `${old.file}: ${systemReason(old, ctx.rootSpecs)}` + tr(' – wird hier nicht geändert', ' – is not changed here') })
      return result()
    }
    if (change.kind === 'add' || change.kind === 'update') out.push(...checkInput(change.entry))
    if (change.kind === 'restore' && /\x00/.test(change.content)) out.push({ severity: 'error', message: tr('Ungültiger Inhalt', 'Invalid content') })
    const prot = protectedLinesChanged(before, after, ctx.rootSpecs)
    if (prot) out.push({ severity: 'error', message: prot })
    out.push(...checkFile(after, ctx.rootSpecs))
    if (out.some((d) => d.severity === 'error')) return result()

    // Entries that are new or different after the change.
    const oldLines = new Set(parseFstab(before).entries.map((e) => norm(e.raw)))
    const changed = parseFstab(after).entries.filter((e) => !oldLines.has(norm(e.raw)))
    const label = (e: FstabEntry) => (changed.length > 1 ? `${e.file}: ` : '')
    for (const e of changed) {
      const bad = e.vfstype === 'swap' ? undefined : targetProblem(e.file)
      if (bad) {
        out.push({ line: e.line, severity: 'error', message: `${label(e)}${bad}` })
        continue
      }
      const local = !isNetworkSpec(e.spec) && !e.options.includes('_netdev')
      if (!local) {
        out.push({ line: e.line, severity: 'warning', message: label(e) + tr('Netzlaufwerk – Quelle und Erreichbarkeit prüft Quadeck nicht', 'Network drive – Quadeck does not check the source or whether it is reachable') })
        continue
      }
      if (!isBlockSpec(e.spec)) {
        if (!(await this.host.driver(e.vfstype))) out.push({ line: e.line, severity: 'error', message: label(e) + tr(`Für ${e.vfstype} fehlt das Programm`, `The program for ${e.vfstype} is missing`) })
        out.push({ line: e.line, severity: 'warning', message: label(e) + tr(`Quelle ${e.spec} ist kein Laufwerk – nur der Eintrag selbst wird geprüft`, `Source ${e.spec} is not a drive – only the entry itself is checked`) })
        continue
      }
      const dev = ctx.devices.find((d) => specMatches(e.spec, d))
      if (!dev) out.push({ line: e.line, severity: isBootCritical(e) || change.kind === 'add' ? 'error' : 'warning', message: label(e) + tr(`Kein Gerät mit ${e.spec} gefunden`, `No device with ${e.spec} found`) })
      else if (!fsCompatible(e.vfstype, dev.fstype)) out.push({ line: e.line, severity: 'error', message: label(e) + tr(`Auf ${dev.path} ist ${dev.fstype || 'kein Dateisystem'}, nicht ${e.vfstype}`, `${dev.path} has ${dev.fstype || 'no file system'}, not ${e.vfstype}`) })
      const type = e.vfstype === 'auto' ? dev?.fstype : e.vfstype
      if (type && !(await this.host.driver(type))) out.push({ line: e.line, severity: 'error', message: label(e) + tr(`Treiber für ${type} fehlt${FS_PACKAGE[type] ? ` – Paket ${FS_PACKAGE[type]} installieren` : ''}`, `Driver for ${type} is missing${FS_PACKAGE[type] ? ` – install package ${FS_PACKAGE[type]}` : ''}`) })
      const at = ctx.mounts.get(e.file)
      const same = at && dev && (at.source.replace(/\[.*\]$/, '') === dev.path || specMatches(at.source, dev))
      if (at && !same && !(old && old.file === e.file)) out.push({ line: e.line, severity: 'error', message: label(e) + tr(`Unter ${e.file} ist schon ${at.source} eingehängt`, `${at.source} is already mounted at ${e.file}`) })
      const elsewhere = dev?.mountpoints.filter((m) => m !== e.file && m !== old?.file)
      if (elsewhere?.length) out.push({ line: e.line, severity: 'warning', message: label(e) + tr(`${dev!.path} ist schon unter ${elsewhere.join(', ')} eingehängt – das bleibt so, bis zum nächsten Neustart`, `${dev!.path} is already mounted at ${elsewhere.join(', ')} – that stays so until the next reboot`) })
      const dir = this.host.dirState(e.file)
      if (dir === 'file') out.push({ line: e.line, severity: 'error', message: label(e) + tr(`${e.file} ist eine Datei, kein Verzeichnis`, `${e.file} is a file, not a directory`) })
      if (dir === 'nonempty' && !at) out.push({ line: e.line, severity: 'warning', message: label(e) + tr(`${e.file} ist nicht leer – der Inhalt ist verdeckt, solange die Platte eingehängt ist`, `${e.file} is not empty – its content is hidden while the disk is mounted`) })
      if (dir === 'missing' && change.kind !== 'restore') createDir = e.file
    }

    // What mount(8) itself says about the new file.
    const verify = await this.host.verify(after)
    if (verify) out.push(...verifyDiagnostics(verify, changed, createDir))

    // Which entries would stop the boot – systemd's own generator decides.
    let critical: string[]
    const [genBefore, genAfter] = await Promise.all([this.host.critical(before), this.host.critical(after)])
    if (genBefore && genAfter) {
      const targets = new Map(parseFstab(after).entries.map((e) => [mountUnit(e.file), e.file]))
      critical = [...genAfter].filter((u) => !genBefore.has(u)).map((u) => targets.get(u) ?? u)
    } else critical = newlyCritical(before, after)

    // The steps, for the confirmation.
    if (change.kind === 'remove' && old) {
      usedBy = this.host.usedBy(old.file)
      if (usedBy.length) out.push({ severity: 'warning', message: tr(`${old.file} wird noch benutzt: `, `${old.file} is still in use: `) + usedBy.join(', ') })
      if (ctx.mounts.has(old.file)) actions.push(tr(`${old.file} aushängen (${mountUnit(old.file)} stoppen)`, `Unmount ${old.file} (stop ${mountUnit(old.file)})`))
    }
    for (const e of changed) {
      if (isBlockSpec(e.spec) && !ctx.mounts.has(e.file) && change.kind !== 'restore') actions.push(tr(`Probemount von ${e.spec} mit ${e.options.join(',') || 'defaults'}`, `Test mount of ${e.spec} with ${e.options.join(',') || 'defaults'}`))
    }
    if (createDir) actions.push(tr(`Verzeichnis ${createDir} anlegen`, `Create directory ${createDir}`))
    actions.push(tr(`${this.host.path} schreiben (vorherige Fassung als ${this.host.path}.quadeck-bak und im Verlauf)`, `Write ${this.host.path} (previous version as ${this.host.path}.quadeck-bak and in the history)`), 'systemctl daemon-reload')
    if (change.kind === 'add' || change.kind === 'update') {
      const e = change.entry
      const wasMounted = old && ctx.mounts.has(old.file)
      if (wasMounted && old.file === e.file && old.spec === e.spec) actions.push(tr(`${e.file} mit den neuen Optionen neu einhängen (remount)`, `Remount ${e.file} with the new options (remount)`))
      else if (!e.options.includes('noauto')) actions.push(tr(`${e.file} einhängen (${mountUnit(e.file)} starten)`, `Mount ${e.file} (start ${mountUnit(e.file)})`))
    }
    return result({ bootCritical: critical })
  }

  async applyFstab(change: FstabChange, confirmCritical: boolean): Promise<FstabState> {
    const check = await this.validateFstab(change)
    const err = check.diagnostics.find((d) => d.severity === 'error')
    if (err) throw new HttpError(422, (err.line ? tr(`Zeile ${err.line}: `, `Line ${err.line}: `) : '') + err.message)
    if (check.bootCritical.length && !confirmCritical)
      throw new HttpError(409, tr(`${check.bootCritical.join(', ')} würde den Start blockieren, wenn die Platte fehlt – „nofail“ setzen oder ausdrücklich bestätigen`, `${check.bootCritical.join(', ')} would block the boot if the disk is missing – set “nofail” or confirm explicitly`))
    const mounts = await this.host.mounts()
    const old = change.kind === 'update' || change.kind === 'remove' ? parseFstab(check.before).entries.find((e) => e.line === change.line) : undefined

    // 1. Test mount before the file is touched.
    if (change.kind === 'add' || change.kind === 'update') {
      const e = change.entry
      if (isBlockSpec(e.spec) && !mounts.has(e.file) && !(old && mounts.has(old.file) && old.spec === e.spec)) {
        const fail = await this.host.testMount(e)
        if (fail) throw new HttpError(422, tr('Probemount fehlgeschlagen – fstab bleibt unverändert: ', 'Test mount failed – fstab stays unchanged: ') + fail)
      }
    }

    // 2. Unmount what goes away or moves.
    if (old && mounts.has(old.file) && (change.kind === 'remove' || (change.kind === 'update' && (change.entry.file !== old.file || change.entry.spec !== old.spec)))) {
      for (const u of [mountUnit(old.file, 'automount'), mountUnit(old.file)]) await this.host.systemctl(['stop', '--', u])
      if ((await this.host.mounts()).has(old.file)) throw new HttpError(409, tr(`${old.file} lässt sich nicht aushängen – wird gerade benutzt (z. B. von einem Container, einer Freigabe oder einer offenen Shell)`, `${old.file} cannot be unmounted – it is in use (e.g. by a container, a share or an open shell)`))
    }

    // 3. Write, reload, mount – and undo everything if a step fails.
    const created = check.createDir
    if (created) this.host.mkdir(created)
    this.host.write(check.after)
    const undo = async (why: string): Promise<never> => {
      this.host.write(check.before)
      await this.host.systemctl(['daemon-reload'])
      if (created) this.host.rmdirIfEmpty(created)
      if (old && mounts.has(old.file) && !(await this.host.mounts()).has(old.file)) await this.host.systemctl(['start', '--', mountUnit(old.file)])
      throw new HttpError(422, why + tr(' – die vorherige fstab ist wiederhergestellt', ' – the previous fstab has been restored'))
    }
    const reload = await this.host.systemctl(['daemon-reload'])
    if (!reload.ok) await undo(tr('daemon-reload fehlgeschlagen: ', 'daemon-reload failed: ') + reload.message)
    this.host.history.saved(check.before, check.after)

    if (change.kind === 'add' || change.kind === 'update') {
      const e = change.entry
      const remount = old && mounts.has(old.file) && old.file === e.file && old.spec === e.spec
      if (remount) {
        const r = await this.host.systemctl(['reload', '--', mountUnit(e.file)])
        if (!r.ok) await undo(tr('Neu einhängen mit den neuen Optionen fehlgeschlagen: ', 'Remounting with the new options failed: ') + r.message)
      } else if (!e.options.includes('noauto')) {
        const unit = e.options.includes('x-systemd.automount') ? mountUnit(e.file, 'automount') : mountUnit(e.file)
        const r = await this.host.systemctl(['start', '--', unit])
        if (!r.ok) await undo(tr('Einhängen fehlgeschlagen: ', 'Mounting failed: ') + r.message)
      }
    }
    if (change.kind === 'remove' && old && created === undefined) this.host.rmdirIfEmpty(old.file)
    return this.fstabState()
  }

  async mountAction(target: string, action: 'mount' | 'unmount'): Promise<FstabState> {
    const { rootSpecs, text } = await this.context()
    const e = parseFstab(text).entries.find((x) => x.file === target)
    if (!e) throw new HttpError(404, tr(`${target} steht nicht in der fstab`, `${target} is not in the fstab`))
    if (systemReason(e, rootSpecs)) throw new HttpError(403, `${target}: ${systemReason(e, rootSpecs)}` + tr(' – wird hier nicht ein- oder ausgehängt', ' – is not mounted or unmounted here'))
    if (action === 'mount') {
      if (this.host.dirState(target) === 'missing') this.host.mkdir(target)
      const r = await this.host.systemctl(['start', '--', mountUnit(target)])
      if (!r.ok) throw new HttpError(422, tr('Einhängen fehlgeschlagen: ', 'Mounting failed: ') + r.message)
    } else {
      for (const u of [mountUnit(target, 'automount'), mountUnit(target)]) await this.host.systemctl(['stop', '--', u])
      if ((await this.host.mounts()).has(target)) throw new HttpError(409, tr(`${target} lässt sich nicht aushängen – wird gerade benutzt`, `${target} cannot be unmounted – it is in use`))
    }
    return this.fstabState()
  }
}

/** findmnt --verify output → diagnostics for the changed entries. */
export function verifyDiagnostics(output: string, changed: FstabEntry[], createDir?: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const targets = new Map(changed.map((e) => [e.file, e]))
  let current: FstabEntry | undefined
  for (const raw of output.split('\n')) {
    const parse = raw.match(/^(\d+) parse errors?/)
    if (parse && Number(parse[1]) > 0) out.push({ severity: 'error', message: `findmnt: ${raw.trim()}` })
    if (!raw.startsWith(' ') && !raw.startsWith('\t')) {
      current = targets.get(raw.trim())
      continue
    }
    const m = raw.trim().match(/^\[([EW])\] (.*)$/)
    if (!m || !current) continue
    const msg = m[2]!
    if (/target: No such file or directory/.test(msg) && createDir === current.file) continue
    if (/required source|unreachable source|cannot detect on-disk filesystem/.test(msg)) continue // the device check above says it in plain words
    out.push({ line: current.line, severity: m[1] === 'E' ? 'error' : 'warning', message: `findmnt: ${msg}` })
  }
  return out
}

// ---------- the real machine ----------

interface LsblkDev {
  name: string
  path?: string
  type: string
  size: number | string | null
  fstype?: string | null
  uuid?: string | null
  partuuid?: string | null
  label?: string | null
  partlabel?: string | null
  model?: string | null
  mountpoints?: (string | null)[]
  children?: LsblkDev[]
}

const NOT_MOUNTABLE = new Set(['swap', 'LVM2_member', 'linux_raid_member', 'crypto_LUKS', 'zfs_member', 'bcache', 'iso9660', 'squashfs', 'erofs', 'ceph_bluestore', 'drbd'])

export function parseBlockDevices(json: string): BlockDevice[] {
  const data = JSON.parse(json) as { blockdevices?: LsblkDev[] }
  const out: BlockDevice[] = []
  const walk = (d: LsblkDev, disk: string, model?: string) => {
    const m = d.model?.trim() || model
    if (d.fstype && !NOT_MOUNTABLE.has(d.fstype) && d.type !== 'loop' && d.type !== 'rom')
      out.push({
        path: d.path ?? `/dev/${d.name}`,
        name: d.name,
        disk,
        fstype: d.fstype,
        uuid: d.uuid ?? undefined,
        partuuid: d.partuuid ?? undefined,
        label: d.label ?? undefined,
        partlabel: d.partlabel ?? undefined,
        size: Number(d.size) || 0,
        model: m,
        mountpoints: (d.mountpoints ?? []).filter((x): x is string => !!x),
      })
    for (const c of d.children ?? []) walk(c, disk, m)
  }
  for (const d of data.blockdevices ?? []) walk(d, d.name)
  return out
}

const GENERATOR = ['/usr/lib/systemd/system-generators/systemd-fstab-generator', '/lib/systemd/system-generators/systemd-fstab-generator']

function readSafe(p: string) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

/** SMB share paths, NFS exports and Quadlet volume sources. */
export function pathsInUse(files: { smb?: string; exports?: string[]; quadlets?: { name: string; text: string }[] }): { path: string; what: string }[] {
  const out: { path: string; what: string }[] = []
  let section = ''
  for (const l of (files.smb ?? '').split('\n')) {
    const s = l.match(/^\s*\[(.+)\]\s*$/)
    if (s) section = s[1]!
    const p = l.match(/^\s*path\s*=\s*(\/\S.*?)\s*$/i)
    if (p) out.push({ path: p[1]!, what: tr(`SMB-Freigabe [${section}]`, `SMB share [${section}]`) })
  }
  for (const t of files.exports ?? [])
    for (const l of t.split('\n')) {
      const p = l.trim().match(/^("[^"]+"|\/\S+)/)
      if (p && !l.trim().startsWith('#')) out.push({ path: p[1]!.replace(/"/g, ''), what: 'NFS-Export' })
    }
  for (const q of files.quadlets ?? [])
    for (const l of q.text.split('\n')) {
      const v = l.match(/^\s*Volume\s*=\s*(\/[^:\s]+)/)
      if (v) out.push({ path: v[1]!, what: q.name })
    }
  return out
}

export const usedUnder = (all: { path: string; what: string }[], target: string) => [...new Set(all.filter((u) => u.path === target || u.path.startsWith(target + '/')).map((u) => u.what))]

export class SystemFstabHost implements FstabHost {
  readonly path: string
  history: FstabHost['history']

  constructor(path = process.env.QUADECK_FSTAB || FSTAB_PATH, historyDir = process.env.QUADECK_FSTAB_HISTORY || '/var/lib/quadeck-helper/fstab-history') {
    this.path = path
    const h = new UnitHistory(historyDir)
    this.history = { list: () => h.list(path), read: (id) => h.read(path, id), saved: (b, a) => h.saved(path, b, a) }
  }

  read() {
    return readSafe(this.path) ?? ''
  }

  write(text: string) {
    if (existsSync(this.path)) copyFileSync(this.path, `${this.path}.quadeck-bak`)
    const tmp = `${this.path}.quadeck-tmp`
    writeFileSync(tmp, text, { mode: 0o644 })
    renameSync(tmp, this.path)
  }

  async devices() {
    const cols = 'NAME,PATH,TYPE,SIZE,FSTYPE,UUID,PARTUUID,LABEL,PARTLABEL,MODEL,MOUNTPOINTS'
    const r = await run(['lsblk', '-J', '-b', '-o', cols])
    if (r.code !== 0) throw new HttpError(503, `lsblk: ${r.stderr.trim()}`)
    return parseBlockDevices(r.stdout)
  }

  async mounts() {
    const r = await run(['findmnt', '-J', '-l', '-o', 'TARGET,SOURCE,FSTYPE'])
    const m = new Map<string, MountInfo>()
    if (r.code !== 0) return m
    for (const f of (JSON.parse(r.stdout) as { filesystems?: { target: string; source: string; fstype: string }[] }).filesystems ?? []) m.set(f.target, { source: f.source, fstype: f.fstype })
    return m
  }

  async usage(target: string) {
    try {
      const s = await statfs(target)
      return { size: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize }
    } catch {
      return undefined
    }
  }

  async driver(fstype: string) {
    if (fstype === 'auto' || fstype === 'none') return true
    // fuse.mergerfs, fuse.sshfs: mount.fuse starts the program of that name.
    if (fstype.startsWith('fuse.')) return !!Bun.which(fstype.slice(5), { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' })
    const proc = readSafe('/proc/filesystems') ?? ''
    if (proc.split('\n').some((l) => l.trim().split(/\s+/).pop() === fstype)) return true
    if (['/usr/sbin', '/sbin', '/usr/bin', '/bin'].some((d) => existsSync(`${d}/mount.${fstype}`))) return true
    return (await run(['modprobe', '-n', '-q', `fs-${fstype}`])).code === 0
  }

  dirState(path: string) {
    try {
      if (!statSync(path).isDirectory()) return 'file' as const
      return readdirSync(path).length ? ('nonempty' as const) : ('empty' as const)
    } catch {
      return 'missing' as const
    }
  }

  mkdir(path: string) {
    mkdirSync(path, { recursive: true, mode: 0o755 })
  }

  rmdirIfEmpty(path: string) {
    try {
      rmdirSync(path)
    } catch {
      // not empty or gone
    }
  }

  private withFile<T>(text: string, fn: (file: string, dir: string) => Promise<T>) {
    const dir = mkdtempSync(join(tmpdir(), 'quadeck-fstab-'))
    writeFileSync(join(dir, 'fstab'), text)
    return fn(join(dir, 'fstab'), dir).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  async verify(text: string) {
    if (!Bun.which('findmnt')) return undefined
    return this.withFile(text, async (file) => {
      const r = await run(['findmnt', '--verify', '--verbose', '--tab-file', file], { timeoutMs: 30_000 })
      return `${r.stdout}\n${r.stderr}`
    })
  }

  async critical(text: string) {
    const gen = GENERATOR.find((g) => existsSync(g))
    if (!gen) return undefined
    return this.withFile(text, async (file, dir) => {
      const out = join(dir, 'out')
      mkdirSync(out)
      const r = await run([gen, out, out, out], { env: { SYSTEMD_FSTAB: file, SYSTEMD_LOG_LEVEL: 'warning' }, timeoutMs: 30_000 })
      if (r.code !== 0) return undefined
      try {
        return new Set(readdirSync(join(out, 'local-fs.target.requires')).filter((u) => u.endsWith('.mount')))
      } catch {
        return new Set<string>()
      }
    })
  }

  async testMount(e: EntryInput) {
    // In the helper's own mount namespace (PrivateTmp) nothing of this is visible outside.
    const dir = mkdtempSync(join(tmpdir(), 'quadeck-mounttest-'))
    try {
      const opts = e.options.filter((o) => !USERSPACE_OPTION(o) || o === 'defaults')
      const argv = ['mount', '-t', e.vfstype, ...(opts.length ? ['-o', opts.join(',')] : []), '--', e.spec, dir]
      const r = await run(argv, { timeoutMs: 60_000 })
      if (r.code !== 0) return (r.stderr || r.stdout).trim().replace(dir, e.file) || tr(`mount endete mit ${r.code}`, `mount exited with ${r.code}`)
      await run(['umount', '--', dir], { timeoutMs: 60_000 })
      return undefined
    } finally {
      try {
        rmdirSync(dir)
      } catch {
        // still busy: left in the private /tmp
      }
    }
  }

  async systemctl(args: string[]) {
    const r = await run(['systemctl', ...args], { timeoutMs: 120_000 })
    return { ok: r.code === 0, message: (r.stderr || r.stdout).trim() }
  }

  usedBy(target: string) {
    const quadletDir = process.env.QUADECK_QUADLET_DIR || '/etc/containers/systemd'
    let quadlets: { name: string; text: string }[] = []
    try {
      quadlets = readdirSync(quadletDir)
        .filter((f) => /\.(container|pod|kube)$/.test(f))
        .map((f) => ({ name: f, text: readSafe(join(quadletDir, f)) ?? '' }))
    } catch {
      // no Quadlets
    }
    let exportsD: string[] = []
    try {
      exportsD = readdirSync('/etc/exports.d')
        .filter((f) => f.endsWith('.exports'))
        .map((f) => readSafe(join('/etc/exports.d', f)) ?? '')
    } catch {
      // none
    }
    const all = pathsInUse({ smb: readSafe(process.env.QUADECK_SMB_CONF || '/etc/samba/smb.conf'), exports: [readSafe(process.env.QUADECK_EXPORTS || '/etc/exports') ?? '', ...exportsD], quadlets })
    return usedUnder(all, target)
  }
}

// ---------- demo fixtures ----------

const FIXTURE_DRIVERS = new Set(['ext4', 'xfs', 'btrfs', 'vfat', 'exfat', 'ntfs3', 'tmpfs', 'swap', 'fuse.mergerfs'])

export class FixtureFstabHost implements FstabHost {
  readonly path = FSTAB_PATH
  private text: string
  private devs: BlockDevice[]
  private mounted = new Map<string, MountInfo>()
  private dirs = new Set<string>()
  private revs: { rev: Revision; content: string }[] = []
  private seq = 0
  private inUse: { path: string; what: string }[]

  constructor(dir: string) {
    this.text = readSafe(join(dir, 'fstab')) ?? ''
    this.devs = JSON.parse(readSafe(join(dir, 'blockdevices.json')) ?? '[]') as BlockDevice[]
    for (const d of this.devs) for (const m of d.mountpoints) this.mounted.set(m, { source: d.path, fstype: d.fstype })
    for (const e of parseFstab(this.text).entries) if (e.vfstype.startsWith('fuse.')) this.mounted.set(e.file, { source: e.spec.replace(/^.*fsname=/, ''), fstype: e.vfstype })
    for (const m of this.mounted.keys()) this.dirs.add(m)
    let quadlets: { name: string; text: string }[] = []
    try {
      quadlets = readdirSync(join(dir, 'quadlets')).map((f) => ({ name: f, text: readSafe(join(dir, 'quadlets', f)) ?? '' }))
    } catch {
      // none
    }
    this.inUse = pathsInUse({ smb: readSafe(join(dir, 'smb.conf')), exports: [readSafe(join(dir, 'exports')) ?? ''], quadlets })
  }

  history: FstabHost['history'] = {
    list: () => this.revs.map((r) => r.rev),
    read: (id) => {
      const r = this.revs.find((x) => x.rev.id === id)
      if (!r) throw new HttpError(404, tr('Version nicht gefunden', 'Version not found'))
      return r.content
    },
    saved: (before, after) => {
      const add = (content: string, message: string) => this.revs.unshift({ rev: { id: `${Date.now()}-${++this.seq}`, date: Date.now() + this.seq, message }, content })
      if (!this.revs.length) add(before, tr('Ursprünglicher Stand', 'Original state'))
      add(after, tr('Gespeichert', 'Saved'))
      this.revs = this.revs.slice(0, 30)
    },
  }

  read() {
    return this.text
  }
  write(text: string) {
    this.text = text
  }
  async devices() {
    return this.devs.map((d) => ({ ...d, mountpoints: [...this.mounted].filter(([, m]) => m.source === d.path).map(([t]) => t) }))
  }
  async mounts() {
    return new Map(this.mounted)
  }
  async usage(target: string) {
    const m = this.mounted.get(target)
    if (m?.fstype.startsWith('fuse.')) return { size: 38e12, used: 31.4e12 }
    const d = this.devs.find((x) => x.path === m?.source)
    return d ? { size: d.size, used: Math.round(d.size * 0.42) } : undefined
  }
  async driver(fstype: string) {
    return fstype === 'auto' || FIXTURE_DRIVERS.has(fstype)
  }
  dirState(path: string) {
    return this.dirs.has(path) ? (this.mounted.has(path) ? ('nonempty' as const) : ('empty' as const)) : ('missing' as const)
  }
  mkdir(path: string) {
    this.dirs.add(path)
  }
  rmdirIfEmpty(path: string) {
    if (!this.mounted.has(path)) this.dirs.delete(path)
  }
  async verify() {
    return undefined
  }
  async critical() {
    return undefined
  }
  async testMount(e: EntryInput) {
    const bad = e.options.find((o) => !USERSPACE_OPTION(o) && !knownOption(o, e.vfstype))
    if (bad) return `mount: ${e.file}: wrong fs type, bad option, bad superblock on ${e.spec}, missing codepage or helper program, or other error (${bad})`
    return undefined
  }
  async systemctl(args: string[]) {
    const [cmd, , unit] = args
    if (cmd === 'daemon-reload') return { ok: true, message: '' }
    const e = parseFstab(this.text).entries.find((x) => unit === mountUnit(x.file) || unit === mountUnit(x.file, 'automount'))
    if (cmd === 'stop') {
      for (const [t] of this.mounted) if (unit === mountUnit(t) || unit === mountUnit(t, 'automount')) this.mounted.delete(t)
      return { ok: true, message: '' }
    }
    if (!e) return { ok: false, message: `Unit ${unit} not found.` }
    if (!isBlockSpec(e.spec)) {
      this.mounted.set(e.file, { source: e.spec, fstype: e.vfstype })
      return { ok: true, message: '' }
    }
    const dev = this.devs.find((d) => specMatches(e.spec, d))
    if (!dev) return { ok: false, message: `Job for ${unit} failed. See "journalctl -xeu ${unit}" for details.` }
    this.mounted.set(e.file, { source: dev.path, fstype: dev.fstype })
    return { ok: true, message: '' }
  }
  usedBy(target: string) {
    return usedUnder(this.inUse, target)
  }
}
