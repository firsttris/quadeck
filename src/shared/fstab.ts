// /etc/fstab: parser, writer, option catalogue and the checks that do not need
// the host. Shared by the disks page, the web app and the root helper.

import type { Diagnostic, Revision } from './quadlets'

export interface FstabEntry {
  /** 1-based line in the file. */
  line: number
  raw: string
  spec: string
  file: string
  vfstype: string
  options: string[]
  freq: number
  passno: number
}

/** What the form sends; written as one line. */
export interface EntryInput {
  spec: string
  file: string
  vfstype: string
  options: string[]
  freq: number
  passno: number
  /** Comment above the line (device name, label), without "#". */
  note?: string
}

export type FstabChange =
  | { kind: 'add'; entry: EntryInput }
  /** `original` is the line as it was read; a different line there means someone else changed the file. */
  | { kind: 'update'; line: number; original: string; entry: EntryInput }
  | { kind: 'remove'; line: number; original: string }
  | { kind: 'restore'; content: string }

export interface BlockDevice {
  path: string
  name: string
  /** Whole disk (sda, nvme0n1). */
  disk: string
  fstype: string
  uuid?: string
  partuuid?: string
  label?: string
  partlabel?: string
  size: number
  model?: string
  mountpoints: string[]
}

export interface MountView extends FstabEntry {
  /** Root's file system, /boot, swap and the like: shown, never changed. */
  system?: string
  device?: BlockDevice
  mounted: boolean
  /** Mounted somewhere else than in the file. */
  mountedAt?: string
  size?: number
  used?: number
  bootCritical: boolean
  /** Local block device that is not there. */
  missing: boolean
  /** SMB shares, NFS exports and Quadlet volumes under this path. */
  usedBy: string[]
}

export interface FstabState {
  path: string
  content: string
  entries: MountView[]
  /** File systems that are not in the file. */
  devices: BlockDevice[]
  history: Revision[]
}

export interface FstabCheck {
  ok: boolean
  diagnostics: Diagnostic[]
  before: string
  after: string
  /** Targets that would stop the boot if they fail – they need a confirmation. */
  bootCritical: string[]
  /** Path the change creates as mount point. */
  createDir?: string
  /** What happens to the mount right away. */
  actions: string[]
  usedBy: string[]
}

export const FSTAB_PATH = '/etc/fstab'

// ---------- parse & write ----------

/** fstab escapes: \040 space, \011 tab, \012 newline, \134 backslash. */
export const unescapeField = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
export const escapeField = (s: string) => s.replace(/[\\ \t\n]/g, (c) => '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'))

export function parseFstab(text: string): { entries: FstabEntry[]; diagnostics: Diagnostic[] } {
  const entries: FstabEntry[] = []
  const diagnostics: Diagnostic[] = []
  text.split('\n').forEach((raw, i) => {
    const t = raw.trim()
    if (!t || t.startsWith('#')) return
    const f = t.split(/\s+/)
    const line = i + 1
    if (f.length < 2) return void diagnostics.push({ line, severity: 'error', message: 'Zu wenige Felder – mindestens Quelle und Einhängepunkt' })
    if (f.length > 6) return void diagnostics.push({ line, severity: 'error', message: `${f.length} Felder – fstab hat höchstens 6 (Leerzeichen in Pfaden als \\040 schreiben)` })
    const num = (v: string | undefined, name: string) => {
      if (v === undefined) return 0
      if (!/^\d+$/.test(v)) diagnostics.push({ line, severity: 'error', message: `${name} muss eine Zahl sein, nicht „${v}“` })
      return Number(v) || 0
    }
    entries.push({
      line,
      raw,
      spec: unescapeField(f[0]!),
      file: unescapeField(f[1]!),
      vfstype: f[2] ?? 'auto',
      options: (f[3] ?? 'defaults').split(',').filter(Boolean),
      freq: num(f[4], 'Feld 5 (dump)'),
      passno: num(f[5], 'Feld 6 (Prüfreihenfolge)'),
    })
  })
  return { entries, diagnostics }
}

export function formatEntry(e: EntryInput): string {
  const opts = e.options.length ? e.options.join(',') : 'defaults'
  return [escapeField(e.spec), escapeField(e.file), e.vfstype, opts, String(e.freq), String(e.passno)].join('\t')
}

const NOTE = '# quadeck: '

/** The new file text. Comments and lines Quadeck does not touch stay as they are. */
export function applyChange(text: string, change: FstabChange): string {
  if (change.kind === 'restore') return change.content.endsWith('\n') ? change.content : change.content + '\n'
  const lines = text.replace(/\n$/, '').split('\n')
  if (text === '') lines.length = 0
  const note = (e: EntryInput) => (e.note?.trim() ? `${NOTE}${e.note.trim().replace(/[\r\n]+/g, ' ')}` : undefined)
  if (change.kind === 'add') {
    const n = note(change.entry)
    if (lines.length && lines[lines.length - 1]!.trim() !== '') lines.push('')
    if (n) lines.push(n)
    lines.push(formatEntry(change.entry))
    return lines.join('\n') + '\n'
  }
  const idx = change.line - 1
  if (lines[idx] !== change.original) throw new FstabConflict()
  if (change.kind === 'update') {
    lines[idx] = formatEntry(change.entry)
    const n = note(change.entry)
    if (n && lines[idx - 1]?.startsWith(NOTE)) lines[idx - 1] = n
  } else {
    lines.splice(idx, 1)
    // Our own note above the line goes with it, and so does a blank line left alone.
    if (lines[idx - 1]?.startsWith(NOTE)) lines.splice(idx - 1, 1)
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '') + '\n'
}

export class FstabConflict extends Error {
  constructor() {
    super('Die fstab wurde inzwischen geändert – bitte neu laden')
  }
}

// ---------- what may be touched ----------

const SYSTEM_TARGETS = new Set(['/', '/boot', '/boot/efi', '/efi', '/usr', '/var', '/home', '/sysroot', '/nix', '/gnu'])
const PSEUDO_FS = new Set(['proc', 'sysfs', 'devpts', 'tmpfs', 'devtmpfs', 'efivarfs', 'securityfs', 'cgroup', 'cgroup2', 'debugfs', 'tracefs', 'hugetlbfs', 'mqueue', 'bpf', 'pstore', 'configfs', 'fusectl', 'ramfs', 'overlay', 'squashfs', 'iso9660', 'udf'])
export const NETWORK_FS = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'sshfs', 'fuse.sshfs', 'glusterfs', 'ceph', 'davfs', '9p', 'virtiofs'])

/** Directories that must never become (or be hidden under) a mount point. */
const FORBIDDEN_TARGET = /^\/(?:$|(?:boot|efi|usr|etc|proc|sys|dev|run|tmp|bin|sbin|lib|lib32|lib64|root|var|home|opt|nix|sysroot)\/?$|(?:proc|sys|dev|run|boot|efi|etc|usr|bin|sbin|lib|lib64)\/)/

/** Why an entry is read-only, or undefined when Quadeck may change it. `rootSpecs` are the sources of `/`. */
export function systemReason(e: Pick<FstabEntry, 'spec' | 'file' | 'vfstype'>, rootSpecs: string[] = []): string | undefined {
  if (e.vfstype === 'swap' || e.file === 'none' || e.file === 'swap') return 'Auslagerungsspeicher'
  if (SYSTEM_TARGETS.has(e.file)) return 'Systempartition'
  if (PSEUDO_FS.has(e.vfstype)) return 'Systemdateisystem'
  if (e.file !== '/' && rootSpecs.includes(e.spec)) return 'Teil der Systempartition (Subvolume)'
  if (/^\/(boot|efi|usr|var|etc)\//.test(e.file)) return 'Systemverzeichnis'
  return undefined
}

/** A failed mount of this entry stops the boot in emergency mode. */
export function isBootCritical(e: Pick<FstabEntry, 'vfstype' | 'options' | 'file'>): boolean {
  if (e.vfstype === 'swap' || e.file === 'none') return false
  const o = e.options
  if (o.includes('nofail') || o.includes('noauto') || o.includes('x-systemd.automount')) return false
  if (o.includes('_netdev') || NETWORK_FS.has(e.vfstype)) return false // remote-fs.target does not stop the boot
  return true
}

export const isNetworkSpec = (spec: string) => /^[^/=\s]+:\//.test(spec) || spec.startsWith('//')

/** Names a block device (as opposed to mergerfs branches, a bind mount or tmpfs). */
export const isBlockSpec = (spec: string) => /^(UUID|PARTUUID|LABEL|PARTLABEL|ID)=|^\/dev\//.test(spec)

// ---------- options ----------

export interface OptionDoc {
  name: string
  /** Has a value (name=value). */
  value?: 'number' | 'text' | 'seconds'
  /** File systems it belongs to; none = every file system. */
  fs?: string[]
  text: string
}

const FAT_LIKE = ['vfat', 'exfat', 'ntfs3', 'ntfs', 'ntfs-3g']

export const OPTION_DOCS: OptionDoc[] = [
  { name: 'defaults', text: 'Standardeinstellungen (rw, suid, dev, exec, auto, nouser, async).' },
  { name: 'nofail', text: 'Fehlt die Platte beim Start, bootet der Server trotzdem – ohne diese Option landet er im Notfallmodus.' },
  { name: 'x-systemd.device-timeout', value: 'seconds', text: 'So lange wartet systemd beim Start auf die Platte (Standard 90 s).' },
  { name: 'noauto', text: 'Beim Start nicht einhängen, nur von Hand oder bei Bedarf.' },
  { name: 'x-systemd.automount', text: 'Erst beim ersten Zugriff einhängen – der Start wartet nicht auf die Platte.' },
  { name: 'x-systemd.idle-timeout', value: 'seconds', text: 'Mit Automount: nach so langer Ruhe wieder aushängen (Platte darf schlafen).' },
  { name: 'x-systemd.mount-timeout', value: 'seconds', text: 'Höchstdauer für das Einhängen selbst.' },
  { name: 'x-systemd.requires', value: 'text', text: 'Erst einhängen, wenn diese Unit läuft.' },
  { name: 'x-systemd.after', value: 'text', text: 'Nach dieser Unit einhängen.' },
  { name: 'x-systemd.before', value: 'text', text: 'Vor dieser Unit einhängen.' },
  { name: 'x-systemd.makefs', text: 'Leeres Gerät beim Start formatieren – Vorsicht.' },
  { name: 'x-mount.mkdir', text: 'Einhängepunkt anlegen, falls er fehlt.' },
  { name: 'x-gvfs-show', text: 'Im Dateimanager des Desktops anzeigen.' },
  { name: '_netdev', text: 'Braucht das Netzwerk – erst danach einhängen.' },
  { name: 'noatime', text: 'Keine Zugriffszeiten schreiben – weniger Schreibzugriffe, Platten schlafen länger.' },
  { name: 'relatime', text: 'Zugriffszeit nur selten aktualisieren (Standard).' },
  { name: 'nodiratime', text: 'Keine Zugriffszeiten für Ordner.' },
  { name: 'lazytime', text: 'Zeitstempel nur im Speicher halten und gesammelt schreiben.' },
  { name: 'ro', text: 'Nur lesen.' },
  { name: 'rw', text: 'Lesen und schreiben.' },
  { name: 'auto', text: 'Beim Start einhängen (Standard).' },
  { name: 'user', text: 'Normale Benutzer dürfen einhängen.' },
  { name: 'users', text: 'Jeder Benutzer darf ein- und aushängen.' },
  { name: 'nouser', text: 'Nur root darf einhängen (Standard).' },
  { name: 'owner', text: 'Der Besitzer des Geräts darf einhängen.' },
  { name: 'group', text: 'Die Gruppe des Geräts darf einhängen.' },
  { name: 'exec', text: 'Programme auf der Platte dürfen laufen (Standard).' },
  { name: 'noexec', text: 'Keine Programme von dieser Platte starten.' },
  { name: 'suid', text: 'Setuid-Bits gelten (Standard).' },
  { name: 'nosuid', text: 'Setuid-Bits werden ignoriert – sicherer für Datenplatten.' },
  { name: 'dev', text: 'Gerätedateien gelten (Standard).' },
  { name: 'nodev', text: 'Gerätedateien werden ignoriert – sicherer für Datenplatten.' },
  { name: 'sync', text: 'Sofort schreiben, ohne Puffer – langsam.' },
  { name: 'async', text: 'Gepuffert schreiben (Standard).' },
  { name: 'discard', text: 'TRIM bei jedem Löschen – bei SSDs meist besser den wöchentlichen fstrim.timer nutzen.' },
  { name: 'comment', value: 'text', text: 'Kommentar für andere Programme.' },
  { name: 'errors', value: 'text', fs: ['ext2', 'ext3', 'ext4', 'vfat'], text: 'Bei Fehlern: continue, remount-ro oder panic.' },
  { name: 'commit', value: 'number', fs: ['ext3', 'ext4', 'btrfs'], text: 'Alle so viele Sekunden auf die Platte schreiben.' },
  { name: 'data', value: 'text', fs: ['ext3', 'ext4'], text: 'Journal-Modus: ordered, writeback oder journal.' },
  { name: 'barrier', value: 'number', fs: ['ext4'], text: 'Schreibbarrieren (1 an, 0 aus).' },
  { name: 'nobarrier', fs: ['ext4'], text: 'Ohne Schreibbarrieren – nur mit Batterie-Cache.' },
  { name: 'user_xattr', fs: ['ext4'], text: 'Erweiterte Attribute für Benutzer.' },
  { name: 'acl', fs: ['ext4'], text: 'Zugriffslisten (ACL).' },
  { name: 'inode64', fs: ['xfs'], text: 'Inodes überall auf der Platte anlegen (Standard).' },
  { name: 'logbufs', value: 'number', fs: ['xfs'], text: 'Anzahl der Log-Puffer.' },
  { name: 'allocsize', value: 'text', fs: ['xfs'], text: 'Vorab reservierte Größe beim Schreiben.' },
  { name: 'largeio', fs: ['xfs'], text: 'Große I/O-Größe melden.' },
  { name: 'usrquota', fs: ['xfs', 'ext4'], text: 'Kontingente pro Benutzer.' },
  { name: 'grpquota', fs: ['xfs', 'ext4'], text: 'Kontingente pro Gruppe.' },
  { name: 'subvol', value: 'text', fs: ['btrfs'], text: 'Dieses Subvolume einhängen.' },
  { name: 'subvolid', value: 'number', fs: ['btrfs'], text: 'Subvolume über seine Nummer.' },
  { name: 'compress', value: 'text', fs: ['btrfs'], text: 'Neue Dateien komprimieren, z. B. zstd oder zstd:3.' },
  { name: 'compress-force', value: 'text', fs: ['btrfs'], text: 'Immer komprimieren, auch schlecht komprimierbare Dateien.' },
  { name: 'space_cache', value: 'text', fs: ['btrfs'], text: 'Freiraum-Cache, v2 ist Standard.' },
  { name: 'autodefrag', fs: ['btrfs'], text: 'Kleine Schreibzugriffe automatisch defragmentieren.' },
  { name: 'ssd', fs: ['btrfs'], text: 'Für SSDs optimieren (wird meist erkannt).' },
  { name: 'nossd', fs: ['btrfs'], text: 'Nicht für SSDs optimieren.' },
  { name: 'degraded', fs: ['btrfs'], text: 'Auch mit fehlender Platte im RAID einhängen.' },
  { name: 'uid', value: 'number', fs: FAT_LIKE, text: 'Besitzer aller Dateien (Benutzer-ID) – dieses Dateisystem kennt keine Linux-Rechte.' },
  { name: 'gid', value: 'number', fs: FAT_LIKE, text: 'Gruppe aller Dateien (Gruppen-ID).' },
  { name: 'umask', value: 'text', fs: FAT_LIKE, text: 'Rechte, die entzogen werden, z. B. 022 (andere dürfen nur lesen) oder 002.' },
  { name: 'fmask', value: 'text', fs: FAT_LIKE, text: 'Wie umask, nur für Dateien.' },
  { name: 'dmask', value: 'text', fs: FAT_LIKE, text: 'Wie umask, nur für Ordner.' },
  { name: 'iocharset', value: 'text', fs: ['vfat', 'exfat', 'ntfs3', 'ntfs', 'ntfs-3g', 'cifs'], text: 'Zeichensatz der Dateinamen, z. B. utf8.' },
  { name: 'utf8', fs: ['vfat'], text: 'Dateinamen als UTF-8.' },
  { name: 'shortname', value: 'text', fs: ['vfat'], text: 'Umgang mit kurzen 8.3-Namen.' },
  { name: 'flush', fs: ['vfat', 'exfat'], text: 'Früher schreiben – sicherer bei Wechseldatenträgern.' },
  { name: 'windows_names', fs: ['ntfs3', 'ntfs', 'ntfs-3g'], text: 'Keine Namen anlegen, die Windows nicht öffnen kann.' },
  { name: 'prealloc', fs: ['ntfs3'], text: 'Platz beim Schreiben vorab reservieren – weniger Fragmentierung.' },
  { name: 'force', fs: ['ntfs3'], text: 'Auch einhängen, wenn Windows die Platte als „dirty“ markiert hat.' },
  { name: 'permissions', fs: ['ntfs', 'ntfs-3g'], text: 'Linux-Rechte auf NTFS speichern.' },
  { name: 'big_writes', fs: ['ntfs', 'ntfs-3g'], text: 'Größere Schreibblöcke (schneller).' },
  { name: 'nfsvers', value: 'text', fs: ['nfs', 'nfs4'], text: 'NFS-Version, z. B. 4.2.' },
  { name: 'vers', value: 'text', fs: ['nfs', 'nfs4', 'cifs'], text: 'Protokollversion.' },
  { name: 'credentials', value: 'text', fs: ['cifs', 'smb3'], text: 'Datei mit Benutzer und Passwort.' },
  { name: 'soft', fs: ['nfs', 'nfs4'], text: 'Bei Serverausfall Fehler statt warten.' },
  { name: 'hard', fs: ['nfs', 'nfs4'], text: 'Bei Serverausfall warten (Standard).' },
]

const DOC = new Map(OPTION_DOCS.map((d) => [d.name, d]))

export const optionName = (o: string) => o.split('=')[0]!
export const optionValue = (o: string) => (o.includes('=') ? o.slice(o.indexOf('=') + 1) : undefined)

export function optionDoc(o: string): OptionDoc | undefined {
  const n = optionName(o)
  return DOC.get(n) ?? (n.startsWith('x-systemd.') || n.startsWith('x-') ? { name: n, text: 'Option für systemd oder andere Programme (wird vom Kernel ignoriert).' } : undefined)
}

/** Options that need no driver: mount(8) and systemd handle them. */
export const USERSPACE_OPTION = (o: string) => {
  const n = optionName(o)
  return n.startsWith('x-') || ['nofail', 'noauto', 'auto', '_netdev', 'user', 'users', 'nouser', 'owner', 'group', 'comment', 'defaults'].includes(n)
}

export function knownOption(o: string, fstype: string): boolean {
  const d = optionDoc(o)
  if (!d) return false
  return !d.fs || d.fs.includes(fstype) || fstype === 'auto'
}

// ---------- checks without the host ----------

const OPTION_RE = /^[A-Za-z0-9_.:@%+/=~-]+$/
const SPEC_RE = /^(?:(?:UUID|PARTUUID|LABEL|PARTLABEL|ID)=.+|\/\S+|[A-Za-z0-9_.-]+:\/.*|\/\/\S+|[a-z0-9]+)$/
const FSTYPE_RE = /^[a-z0-9][a-z0-9_.+-]{0,39}$/

/** Mount point a new entry may use. */
export function targetProblem(path: string): string | undefined {
  if (!path.startsWith('/')) return 'Der Einhängepunkt muss ein absoluter Pfad sein (/mnt/…)'
  if (/\/\.\.?(\/|$)/.test(path) || /\/\//.test(path) || (path.length > 1 && path.endsWith('/'))) return 'Pfad ohne „.“, „..“, doppelte oder abschließende „/“ angeben'
  if (/[\x00-\x1f#]/.test(path)) return 'Steuerzeichen und „#“ sind im Pfad nicht erlaubt'
  if (FORBIDDEN_TARGET.test(path)) return `${path} ist ein Systemverzeichnis – z. B. /mnt/name oder /srv/name verwenden`
  if (path.length > 240) return 'Pfad zu lang'
  return undefined
}

/** Checks of the form values. */
export function checkInput(e: EntryInput): Diagnostic[] {
  const d: Diagnostic[] = []
  const err = (message: string) => d.push({ severity: 'error', message })
  if (!e.spec.trim() || /[\x00-\x1f]/.test(e.spec) || !SPEC_RE.test(e.spec)) err('Quelle: UUID=…, LABEL=…, PARTUUID=… oder /dev/… angeben')
  const t = targetProblem(e.file)
  if (t) err(t)
  if (!FSTYPE_RE.test(e.vfstype)) err('Dateisystem: z. B. ext4, xfs, btrfs')
  for (const o of e.options) {
    if (!OPTION_RE.test(o)) err(`Option „${o}“ enthält unerlaubte Zeichen`)
    else if (!knownOption(o, e.vfstype)) d.push({ severity: 'warning', message: `Option „${o}“ kennt Quadeck für ${e.vfstype} nicht – der Probemount zeigt, ob der Treiber sie annimmt` })
  }
  const names = e.options.map(optionName)
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup) err(`Option „${dup}“ steht doppelt`)
  if (names.includes('ro') && names.includes('rw')) err('ro und rw zugleich')
  if (names.includes('noauto') && names.includes('x-systemd.automount')) d.push({ severity: 'warning', message: 'noauto mit Automount: eingehängt wird nur beim Zugriff' })
  if (!Number.isInteger(e.freq) || e.freq < 0 || e.freq > 1) err('Feld 5 (dump) ist 0 oder 1')
  if (!Number.isInteger(e.passno) || e.passno < 0 || e.passno > 2) err('Feld 6 (Prüfreihenfolge) ist 0, 1 oder 2')
  if (e.passno === 1 && e.file !== '/') d.push({ severity: 'warning', message: 'Prüfreihenfolge 1 ist für / gedacht – Datenplatten 2 oder 0' })
  if (e.passno > 0 && ['xfs', 'btrfs', 'ntfs3', 'ntfs', 'exfat', 'zfs'].includes(e.vfstype)) d.push({ severity: 'warning', message: `${e.vfstype} wird beim Start nicht mit fsck geprüft – Feld 6 auf 0 setzen` })
  for (const o of e.options) {
    const v = optionValue(o)
    const doc = optionDoc(o)
    if (doc?.value && (v === undefined || v === '')) err(`Option ${doc.name} braucht einen Wert (${doc.name}=…)`)
    if (doc?.value === 'number' && v !== undefined && !/^\d+$/.test(v)) err(`${doc.name}= erwartet eine Zahl`)
    if (doc?.value === 'seconds' && v !== undefined && !/^\d+(ms|s|min|h)?$/.test(v)) err(`${doc.name}= erwartet eine Dauer wie 10s`)
  }
  return d
}

/** Checks of the whole file (all entries). Line numbers refer to the new text. */
export function checkFile(text: string, rootSpecs: string[] = []): Diagnostic[] {
  const { entries, diagnostics } = parseFstab(text)
  const seen = new Map<string, number>()
  for (const e of entries) {
    if (e.vfstype === 'swap' || e.file === 'none') continue
    const prev = seen.get(e.file)
    if (prev) diagnostics.push({ line: e.line, severity: 'error', message: `${e.file} steht schon in Zeile ${prev} – ein Einhängepunkt darf nur einmal vorkommen` })
    else seen.set(e.file, e.line)
  }
  if (!entries.some((e) => e.file === '/') && rootSpecs.length) diagnostics.push({ severity: 'warning', message: 'Kein Eintrag für / – das ist unüblich' })
  return diagnostics
}

/** Protected lines must stay exactly as they are; no new ones may appear. */
export function protectedLinesChanged(before: string, after: string, rootSpecs: string[]): string | undefined {
  const sys = (t: string) =>
    parseFstab(t)
      .entries.filter((e) => systemReason(e, rootSpecs))
      .map((e) => e.raw.trim().split(/\s+/).join(' '))
      .sort()
  const a = sys(before)
  const b = sys(after)
  const gone = a.find((l) => !b.includes(l))
  if (gone) return `Systemeintrag würde geändert oder entfernt: ${gone}`
  const added = b.find((l) => !a.includes(l))
  if (added) return `Neuer Systemeintrag ist nicht erlaubt: ${added}`
  return undefined
}

/** Targets that are boot critical after the change but were not before (or did not exist). */
export function newlyCritical(before: string, after: string): string[] {
  const crit = (t: string) => new Set(parseFstab(t).entries.filter(isBootCritical).map((e) => `${e.file}\t${e.spec}`))
  const a = crit(before)
  return [...crit(after)].filter((k) => !a.has(k)).map((k) => k.split('\t')[0]!)
}

// ---------- form helpers ----------

/** How a new entry should name the device: UUID, then PARTUUID, then the label. */
export function specFor(d: BlockDevice, by: 'uuid' | 'label' | 'partuuid' = 'uuid'): string {
  if (by === 'label' && d.label) return `LABEL=${d.label}`
  if (by === 'partuuid' && d.partuuid) return `PARTUUID=${d.partuuid}`
  if (d.uuid) return `UUID=${d.uuid}`
  if (d.partuuid) return `PARTUUID=${d.partuuid}`
  return d.path
}

/** Does `spec` name this device? */
export function specMatches(spec: string, d: BlockDevice): boolean {
  const [k, ...rest] = spec.split('=')
  const v = rest.join('=')
  switch (k) {
    case 'UUID':
      return !!d.uuid && d.uuid.toLowerCase() === v.toLowerCase()
    case 'PARTUUID':
      return !!d.partuuid && d.partuuid.toLowerCase() === v.toLowerCase()
    case 'LABEL':
      return d.label === v
    case 'PARTLABEL':
      return d.partlabel === v
  }
  if (spec === d.path || spec === `/dev/${d.name}`) return true
  return spec === `/dev/disk/by-uuid/${d.uuid}` || spec === `/dev/disk/by-label/${d.label}` || spec === `/dev/disk/by-partuuid/${d.partuuid}`
}

export function suggestTarget(d: BlockDevice, taken: string[]): string {
  const base = (d.label || d.partlabel || d.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || d.name
  let p = `/mnt/${base}`
  for (let i = 2; taken.includes(p); i++) p = `/mnt/${base}-${i}`
  return p
}

/** Sensible options for a data disk of this file system. */
export function defaultOptions(fstype: string): string[] {
  const o = ['nofail', 'x-systemd.device-timeout=10s', 'noatime']
  if (fstype === 'btrfs') o.push('compress=zstd')
  if (FAT_LIKE.includes(fstype)) o.push('uid=1000', 'gid=1000', 'umask=022')
  return o
}

export const defaultPassno = (fstype: string) => (['ext2', 'ext3', 'ext4'].includes(fstype) ? 2 : 0)

/** Driver/helper a file system needs, for the install hint. */
export const FS_PACKAGE: Record<string, string> = { 'ntfs-3g': 'ntfs-3g', ntfs: 'ntfs-3g', exfat: 'exfatprogs', btrfs: 'btrfs-progs', xfs: 'xfsprogs', f2fs: 'f2fs-tools', cifs: 'cifs-utils', nfs: 'nfs-utils', nfs4: 'nfs-utils' }

/** systemd unit name of a mount point (`systemd-escape --path --suffix=mount`). */
export function mountUnit(path: string, suffix: 'mount' | 'automount' = 'mount'): string {
  if (path === '/') return `-.${suffix}`
  const p = path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/')
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!
    if (c === '/') out += '-'
    else if (/[A-Za-z0-9:_]/.test(c) || (c === '.' && i > 0)) out += c
    else for (const b of new TextEncoder().encode(c)) out += `\\x${b.toString(16).padStart(2, '0')}`
  }
  return `${out}.${suffix}`
}
