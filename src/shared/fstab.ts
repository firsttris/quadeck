// /etc/fstab: parser, writer, option catalogue and the checks that do not need
// the host. Shared by the disks page, the web app and the root helper.

import { msg, type MsgKey } from './i18n'
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
    if (f.length < 2) return void diagnostics.push({ line, severity: 'error', message: msg('fstab_check_tooFewFields') })
    if (f.length > 6)
      return void diagnostics.push({
        line,
        severity: 'error',
        message: msg('fstab_check_tooManyFields', { count: f.length }),
      })
    const num = (v: string | undefined, name: string) => {
      if (v === undefined) return 0
      if (!/^\d+$/.test(v)) diagnostics.push({ line, severity: 'error', message: name + msg('fstab_check_notNumber', { value: v }) })
      return Number(v) || 0
    }
    entries.push({
      line,
      raw,
      spec: unescapeField(f[0]!),
      file: unescapeField(f[1]!),
      vfstype: f[2] ?? 'auto',
      options: (f[3] ?? 'defaults').split(',').filter(Boolean),
      freq: num(f[4], msg('fstab_label_dumpField')),
      passno: num(f[5], msg('fstab_label_passnoField')),
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
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n+$/, '') + '\n'
  )
}

export class FstabConflict extends Error {
  constructor() {
    super(msg('fstab_error_changedMeanwhile'))
  }
}

// ---------- what may be touched ----------

const SYSTEM_TARGETS = new Set(['/', '/boot', '/boot/efi', '/efi', '/usr', '/var', '/home', '/sysroot', '/nix', '/gnu'])
const PSEUDO_FS = new Set([
  'proc',
  'sysfs',
  'devpts',
  'tmpfs',
  'devtmpfs',
  'efivarfs',
  'securityfs',
  'cgroup',
  'cgroup2',
  'debugfs',
  'tracefs',
  'hugetlbfs',
  'mqueue',
  'bpf',
  'pstore',
  'configfs',
  'fusectl',
  'ramfs',
  'overlay',
  'squashfs',
  'iso9660',
  'udf',
])
export const NETWORK_FS = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'sshfs', 'fuse.sshfs', 'glusterfs', 'ceph', 'davfs', '9p', 'virtiofs'])

/** Directories that must never become (or be hidden under) a mount point. */
const FORBIDDEN_TARGET = /^\/(?:$|(?:boot|efi|usr|etc|proc|sys|dev|run|tmp|bin|sbin|lib|lib32|lib64|root|var|home|opt|nix|sysroot)\/?$|(?:proc|sys|dev|run|boot|efi|etc|usr|bin|sbin|lib|lib64)\/)/

/** Why an entry is read-only, or undefined when Quadeck may change it. `rootSpecs` are the sources of `/`. */
export function systemReason(e: Pick<FstabEntry, 'spec' | 'file' | 'vfstype'>, rootSpecs: string[] = []): string | undefined {
  if (e.vfstype === 'swap' || e.file === 'none' || e.file === 'swap') return msg('fstab_label_swap')
  if (SYSTEM_TARGETS.has(e.file)) return msg('fstab_label_systemPartition')
  if (PSEUDO_FS.has(e.vfstype)) return msg('fstab_label_systemFs')
  if (e.file !== '/' && rootSpecs.includes(e.spec)) return msg('fstab_label_systemSubvolume')
  if (/^\/(boot|efi|usr|var|etc)\//.test(e.file)) return msg('fstab_label_systemDir')
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

/** The text follows the viewer's language: it is read when needed, not when the module loads. */
const doc = (d: Omit<OptionDoc, 'text'>, key: MsgKey): OptionDoc => ({
  ...d,
  get text() {
    return msg(key)
  },
})

export const OPTION_DOCS: OptionDoc[] = [
  doc({ name: 'defaults' }, 'fstab_option_defaults'),
  doc({ name: 'nofail' }, 'fstab_option_nofail'),
  doc({ name: 'x-systemd.device-timeout', value: 'seconds' }, 'fstab_option_xsystemddevicetimeout'),
  doc({ name: 'noauto' }, 'fstab_option_noauto'),
  doc({ name: 'x-systemd.automount' }, 'fstab_option_xsystemdautomount'),
  doc({ name: 'x-systemd.idle-timeout', value: 'seconds' }, 'fstab_option_xsystemdidletimeout'),
  doc({ name: 'x-systemd.mount-timeout', value: 'seconds' }, 'fstab_option_xsystemdmounttimeout'),
  doc({ name: 'x-systemd.requires', value: 'text' }, 'fstab_option_xsystemdrequires'),
  doc({ name: 'x-systemd.after', value: 'text' }, 'fstab_option_xsystemdafter'),
  doc({ name: 'x-systemd.before', value: 'text' }, 'fstab_option_xsystemdbefore'),
  doc({ name: 'x-systemd.makefs' }, 'fstab_option_xsystemdmakefs'),
  doc({ name: 'x-mount.mkdir' }, 'fstab_option_xmountmkdir'),
  doc({ name: 'x-gvfs-show' }, 'fstab_option_xgvfsshow'),
  doc({ name: '_netdev' }, 'fstab_option_netdev'),
  doc({ name: 'noatime' }, 'fstab_option_noatime'),
  doc({ name: 'relatime' }, 'fstab_option_relatime'),
  doc({ name: 'nodiratime' }, 'fstab_option_nodiratime'),
  doc({ name: 'lazytime' }, 'fstab_option_lazytime'),
  doc({ name: 'ro' }, 'fstab_option_ro'),
  doc({ name: 'rw' }, 'fstab_option_rw'),
  doc({ name: 'auto' }, 'fstab_option_auto'),
  doc({ name: 'user' }, 'fstab_option_user'),
  doc({ name: 'users' }, 'fstab_option_users'),
  doc({ name: 'nouser' }, 'fstab_option_nouser'),
  doc({ name: 'owner' }, 'fstab_option_owner'),
  doc({ name: 'group' }, 'fstab_option_group'),
  doc({ name: 'exec' }, 'fstab_option_exec'),
  doc({ name: 'noexec' }, 'fstab_option_noexec'),
  doc({ name: 'suid' }, 'fstab_option_suid'),
  doc({ name: 'nosuid' }, 'fstab_option_nosuid'),
  doc({ name: 'dev' }, 'fstab_option_dev'),
  doc({ name: 'nodev' }, 'fstab_option_nodev'),
  doc({ name: 'sync' }, 'fstab_option_sync'),
  doc({ name: 'async' }, 'fstab_option_async'),
  doc({ name: 'discard' }, 'fstab_option_discard'),
  doc({ name: 'comment', value: 'text' }, 'fstab_option_comment'),
  doc({ name: 'errors', value: 'text', fs: ['ext2', 'ext3', 'ext4', 'vfat'] }, 'fstab_option_errors'),
  doc({ name: 'commit', value: 'number', fs: ['ext3', 'ext4', 'btrfs'] }, 'fstab_option_commit'),
  doc({ name: 'data', value: 'text', fs: ['ext3', 'ext4'] }, 'fstab_option_data'),
  doc({ name: 'barrier', value: 'number', fs: ['ext4'] }, 'fstab_option_barrier'),
  doc({ name: 'nobarrier', fs: ['ext4'] }, 'fstab_option_nobarrier'),
  doc({ name: 'user_xattr', fs: ['ext4'] }, 'fstab_option_userxattr'),
  doc({ name: 'acl', fs: ['ext4'] }, 'fstab_option_acl'),
  doc({ name: 'inode64', fs: ['xfs'] }, 'fstab_option_inode64'),
  doc({ name: 'logbufs', value: 'number', fs: ['xfs'] }, 'fstab_option_logbufs'),
  doc({ name: 'allocsize', value: 'text', fs: ['xfs'] }, 'fstab_option_allocsize'),
  doc({ name: 'largeio', fs: ['xfs'] }, 'fstab_option_largeio'),
  doc({ name: 'usrquota', fs: ['xfs', 'ext4'] }, 'fstab_option_usrquota'),
  doc({ name: 'grpquota', fs: ['xfs', 'ext4'] }, 'fstab_option_grpquota'),
  doc({ name: 'subvol', value: 'text', fs: ['btrfs'] }, 'fstab_option_subvol'),
  doc({ name: 'subvolid', value: 'number', fs: ['btrfs'] }, 'fstab_option_subvolid'),
  doc({ name: 'compress', value: 'text', fs: ['btrfs'] }, 'fstab_option_compress'),
  doc({ name: 'compress-force', value: 'text', fs: ['btrfs'] }, 'fstab_option_compressforce'),
  doc({ name: 'space_cache', value: 'text', fs: ['btrfs'] }, 'fstab_option_spacecache'),
  doc({ name: 'autodefrag', fs: ['btrfs'] }, 'fstab_option_autodefrag'),
  doc({ name: 'ssd', fs: ['btrfs'] }, 'fstab_option_ssd'),
  doc({ name: 'nossd', fs: ['btrfs'] }, 'fstab_option_nossd'),
  doc({ name: 'degraded', fs: ['btrfs'] }, 'fstab_option_degraded'),
  doc({ name: 'uid', value: 'number', fs: FAT_LIKE }, 'fstab_option_uid'),
  doc({ name: 'gid', value: 'number', fs: FAT_LIKE }, 'fstab_option_gid'),
  doc({ name: 'umask', value: 'text', fs: FAT_LIKE }, 'fstab_option_umask'),
  doc({ name: 'fmask', value: 'text', fs: FAT_LIKE }, 'fstab_option_fmask'),
  doc({ name: 'dmask', value: 'text', fs: FAT_LIKE }, 'fstab_option_dmask'),
  doc({ name: 'iocharset', value: 'text', fs: ['vfat', 'exfat', 'ntfs3', 'ntfs', 'ntfs-3g', 'cifs'] }, 'fstab_option_iocharset'),
  doc({ name: 'utf8', fs: ['vfat'] }, 'fstab_option_utf8'),
  doc({ name: 'shortname', value: 'text', fs: ['vfat'] }, 'fstab_option_shortname'),
  doc({ name: 'flush', fs: ['vfat', 'exfat'] }, 'fstab_option_flush'),
  doc({ name: 'windows_names', fs: ['ntfs3', 'ntfs', 'ntfs-3g'] }, 'fstab_option_windowsnames'),
  doc({ name: 'prealloc', fs: ['ntfs3'] }, 'fstab_option_prealloc'),
  doc({ name: 'force', fs: ['ntfs3'] }, 'fstab_option_force'),
  doc({ name: 'permissions', fs: ['ntfs', 'ntfs-3g'] }, 'fstab_option_permissions'),
  doc({ name: 'big_writes', fs: ['ntfs', 'ntfs-3g'] }, 'fstab_option_bigwrites'),
  doc({ name: 'nfsvers', value: 'text', fs: ['nfs', 'nfs4'] }, 'fstab_option_nfsvers'),
  doc({ name: 'vers', value: 'text', fs: ['nfs', 'nfs4', 'cifs'] }, 'fstab_option_vers'),
  doc({ name: 'credentials', value: 'text', fs: ['cifs', 'smb3'] }, 'fstab_option_credentials'),
  doc({ name: 'soft', fs: ['nfs', 'nfs4'] }, 'fstab_option_soft'),
  doc({ name: 'hard', fs: ['nfs', 'nfs4'] }, 'fstab_option_hard'),
]

const DOC = new Map(OPTION_DOCS.map((d) => [d.name, d]))

export const optionName = (o: string) => o.split('=')[0]!
export const optionValue = (o: string) => (o.includes('=') ? o.slice(o.indexOf('=') + 1) : undefined)

export function optionDoc(o: string): OptionDoc | undefined {
  const n = optionName(o)
  return DOC.get(n) ?? (n.startsWith('x-systemd.') || n.startsWith('x-') ? doc({ name: n }, 'fstab_option_x') : undefined)
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
  if (!path.startsWith('/')) return msg('fstab_check_mountPointNotAbsolute')
  if (/\/\.\.?(\/|$)/.test(path) || /\/\//.test(path) || (path.length > 1 && path.endsWith('/'))) return msg('fstab_check_pathNotNormalized')
  if (/[\x00-\x1f#]/.test(path)) return msg('fstab_check_pathInvalidChars')
  if (FORBIDDEN_TARGET.test(path)) return msg('fstab_check_systemDir', { path })
  if (path.length > 240) return msg('files_check_pathTooLong')
  return undefined
}

/** Checks of the form values. */
export function checkInput(e: EntryInput): Diagnostic[] {
  const d: Diagnostic[] = []
  const err = (message: string) => d.push({ severity: 'error', message })
  if (!e.spec.trim() || /[\x00-\x1f]/.test(e.spec) || !SPEC_RE.test(e.spec)) err(msg('fstab_check_sourceInvalid'))
  const t = targetProblem(e.file)
  if (t) err(t)
  if (!FSTYPE_RE.test(e.vfstype)) err(msg('fstab_check_fsTypeInvalid'))
  for (const o of e.options) {
    if (!OPTION_RE.test(o)) err(msg('fstab_check_optionInvalidChars', { option: o }))
    else if (!knownOption(o, e.vfstype))
      d.push({
        severity: 'warning',
        message: msg('fstab_check_optionUnknown', { option: o, vfstype: e.vfstype }),
      })
  }
  const names = e.options.map(optionName)
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup) err(msg('fstab_check_optionDuplicate', { option: dup }))
  if (names.includes('ro') && names.includes('rw')) err(msg('fstab_check_roAndRw'))
  if (names.includes('noauto') && names.includes('x-systemd.automount')) d.push({ severity: 'warning', message: msg('fstab_check_noautoAutomount') })
  if (!Number.isInteger(e.freq) || e.freq < 0 || e.freq > 1) err(msg('fstab_check_dumpRange'))
  if (!Number.isInteger(e.passno) || e.passno < 0 || e.passno > 2) err(msg('fstab_check_passnoRange'))
  if (e.passno === 1 && e.file !== '/') d.push({ severity: 'warning', message: msg('fstab_check_passnoOneNotRoot') })
  if (e.passno > 0 && ['xfs', 'btrfs', 'ntfs3', 'ntfs', 'exfat', 'zfs'].includes(e.vfstype)) d.push({ severity: 'warning', message: msg('fstab_check_passnoNoFsck', { vfstype: e.vfstype }) })
  for (const o of e.options) {
    const v = optionValue(o)
    const doc = optionDoc(o)
    if (doc?.value && (v === undefined || v === '')) err(msg('fstab_check_optionNeedsValue', { option: doc.name }))
    if (doc?.value === 'number' && v !== undefined && !/^\d+$/.test(v)) err(msg('fstab_check_optionNumber', { option: doc.name }))
    if (doc?.value === 'seconds' && v !== undefined && !/^\d+(ms|s|min|h)?$/.test(v)) err(msg('fstab_check_optionDuration', { option: doc.name }))
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
    if (prev) diagnostics.push({ line: e.line, severity: 'error', message: msg('fstab_check_mountPointDuplicate', { file: e.file, line: prev }) })
    else seen.set(e.file, e.line)
  }
  if (!entries.some((e) => e.file === '/') && rootSpecs.length) diagnostics.push({ severity: 'warning', message: msg('fstab_check_noRootEntry') })
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
  if (gone) return msg('fstab_check_systemEntryChanged', { entries: gone })
  const added = b.find((l) => !a.includes(l))
  if (added) return msg('fstab_check_systemEntryAdded', { entries: added })
  return undefined
}

/** Targets that are boot critical after the change but were not before (or did not exist). */
export function newlyCritical(before: string, after: string): string[] {
  const crit = (t: string) =>
    new Set(
      parseFstab(t)
        .entries.filter(isBootCritical)
        .map((e) => `${e.file}\t${e.spec}`),
    )
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
  const base =
    (d.label || d.partlabel || d.name)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || d.name
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
