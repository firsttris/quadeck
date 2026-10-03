// Accounts of the server: types, parsers for passwd/shadow/group, the checks
// for every change and the lock-out guard. Shared by the page and the helper.

import { msg } from './i18n'

export interface Account {
  name: string
  uid: number
  fullName: string
  home: string
  shell: string
  /** Supplementary groups (without the primary group). */
  groups: string[]
  /** Member of wheel/sudo (or root): may use sudo and unlock Quadeck. */
  admin: boolean
  /** Password locked or account expired: nobody gets in, not even with a key. */
  locked: boolean
  hasPassword: boolean
  /** authorized_keys entries. */
  keys: number
  /** Has a Samba password (pdbedit). */
  samba?: boolean
  lastLogin?: number
  /** Why it cannot be deleted/renamed (root). */
  protected?: string
}

export interface LoginRecord {
  user: string
  tty: string
  from?: string
  start: number
  end?: number
  /** Still logged in. */
  active: boolean
}

export interface GroupInfo {
  name: string
  gid: number
  /** What it is good for (known groups). */
  text?: string
}

export interface UsersState {
  accounts: Account[]
  /** Groups that can be assigned. */
  groups: GroupInfo[]
  shells: string[]
  /** wheel (Arch, Fedora) or sudo (Debian). */
  adminGroup: string
  sambaAvailable: boolean
  history: LoginRecord[]
}

export type UserChange =
  | { kind: 'create'; name: string; fullName: string; admin: boolean; password?: string; shell: string; groups: string[] }
  | { kind: 'update'; name: string; fullName: string; shell: string; groups: string[]; admin: boolean }
  | { kind: 'password'; name: string; password: string }
  | { kind: 'lock'; name: string }
  | { kind: 'unlock'; name: string }
  | { kind: 'samba-password'; name: string; password: string }
  | { kind: 'delete'; name: string; removeHome: boolean }

export const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/
export const MIN_PASSWORD = 8

/** Groups worth offering, with what membership gives. */
export const knownGroups = (): Record<string, string> => ({
  wheel: msg('users_group_wheel'),
  sudo: msg('users_group_wheel'),
  video: msg('users_group_video'),
  render: msg('users_group_render'),
  audio: msg('users_group_audio'),
  storage: msg('users_group_storage'),
  'systemd-journal': msg('users_group_systemdJournal'),
  docker: msg('users_group_docker'),
  libvirt: msg('users_group_libvirt'),
  kvm: msg('users_group_kvm'),
  input: msg('users_group_input'),
  lp: msg('users_group_lp'),
  uucp: msg('users_group_uucp'),
  dialout: msg('users_group_uucp'),
  plugdev: msg('users_group_plugdev'),
  users: msg('users_group_users'),
  sambashare: msg('users_group_sambashare'),
})

// ---------- parsers ----------

export interface PasswdEntry {
  name: string
  uid: number
  gid: number
  gecos: string
  home: string
  shell: string
}

export function parsePasswd(text: string): PasswdEntry[] {
  return text
    .split('\n')
    .map((l) => l.split(':'))
    .filter((f) => f.length >= 7 && f[0])
    .map((f) => ({ name: f[0]!, uid: Number(f[2]), gid: Number(f[3]), gecos: f[4]!, home: f[5]!, shell: f[6]! }))
}

/** Login accounts: root and regular users (uid 1000–59999). */
export const isHuman = (p: PasswdEntry) => p.uid === 0 || (p.uid >= 1000 && p.uid < 60000 && p.name !== 'nobody')

export function parseGroup(text: string): { name: string; gid: number; members: string[] }[] {
  return text
    .split('\n')
    .map((l) => l.split(':'))
    .filter((f) => f.length >= 4 && f[0])
    .map((f) => ({ name: f[0]!, gid: Number(f[2]), members: f[3]!.split(',').filter(Boolean) }))
}

/** shadow: password field and account expiry (days since 1970). */
export function parseShadow(text: string): Map<string, { password: string; expire?: number }> {
  const m = new Map<string, { password: string; expire?: number }>()
  for (const l of text.split('\n')) {
    const f = l.split(':')
    if (f.length < 8 || !f[0]) continue
    m.set(f[0], { password: f[1]!, expire: f[7] ? Number(f[7]) : undefined })
  }
  return m
}

export function passwordState(pw: string | undefined, expire: number | undefined, now = Date.now()): { locked: boolean; hasPassword: boolean } {
  const p = pw ?? '*'
  const hash = p.replace(/^!+/, '')
  const expired = expire !== undefined && !Number.isNaN(expire) && expire * 86400_000 <= now
  return { locked: p.startsWith('!') || expired, hasPassword: /^\$/.test(hash) || /^[A-Za-z0-9./]{13}$/.test(hash) }
}

/** `last --time-format iso -w` lines. */
export function parseLast(text: string): LoginRecord[] {
  const out: LoginRecord[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+(?:(\S+)\s+)?(\d{4}-\d\d-\d\dT[\d:]+(?:[+-]\d\d:?\d\d|Z)?)\s+(?:-\s+(\d{4}-\d\d-\d\dT[\d:]+(?:[+-]\d\d:?\d\d|Z)?)|(still logged in|still running|gone - no logout|- crash|- down))/)
    if (!m || m[1] === 'reboot' || m[1] === 'wtmp' || m[1] === 'wtmpdb') continue
    const start = Date.parse(m[4]!)
    if (Number.isNaN(start)) continue
    const from = m[3] && !/^\d{4}-/.test(m[3]) && m[3] !== '0.0.0.0' ? m[3] : undefined
    out.push({ user: m[1]!, tty: m[2]!, from, start, end: m[5] ? Date.parse(m[5]) : undefined, active: m[6] === 'still logged in' })
  }
  return out
}

// ---------- checks ----------

export function nameProblem(name: string): string | undefined {
  if (!USER_NAME.test(name)) return msg('users_error_invalidName')
  return undefined
}

export function passwordProblem(pw: string): string | undefined {
  if (pw.length < MIN_PASSWORD) return msg('users_error_passwordShort', { min: MIN_PASSWORD })
  if (pw.length > 512 || /[\r\n\x00]/.test(pw)) return msg('users_error_passwordInvalid')
  return undefined
}

export function fullNameProblem(n: string): string | undefined {
  if (n.length > 100 || /[:,\r\n\x00-\x1f]/.test(n)) return msg('users_error_fullNameInvalid')
  return undefined
}

/**
 * Accounts that could still unlock Quadeck and use sudo after `next`: root or
 * an admin, not locked, with a password. None left = locked out.
 */
export function adminsWithPassword(accounts: Pick<Account, 'name' | 'uid' | 'admin' | 'locked' | 'hasPassword'>[]): string[] {
  return accounts.filter((a) => (a.uid === 0 || a.admin) && !a.locked && a.hasPassword).map((a) => a.name)
}

/** The account list as it would be after a change (for the lock-out guard). */
export function afterChange(accounts: Account[], c: UserChange): Account[] {
  switch (c.kind) {
    case 'create':
      return [...accounts, { name: c.name, uid: 60000, fullName: c.fullName, home: '', shell: c.shell, groups: c.groups, admin: c.admin, locked: false, hasPassword: !!c.password, keys: 0 }]
    case 'update':
      return accounts.map((a) => (a.name === c.name ? { ...a, admin: c.admin || a.uid === 0 } : a))
    case 'password':
      return accounts.map((a) => (a.name === c.name ? { ...a, hasPassword: true } : a))
    case 'lock':
      return accounts.map((a) => (a.name === c.name ? { ...a, locked: true } : a))
    case 'unlock':
      return accounts.map((a) => (a.name === c.name ? { ...a, locked: false } : a))
    case 'delete':
      return accounts.filter((a) => a.name !== c.name)
    case 'samba-password':
      return accounts
  }
}

/** Why a change is refused, or undefined. */
export function changeProblem(state: Pick<UsersState, 'accounts' | 'shells' | 'groups' | 'adminGroup'>, c: UserChange): string | undefined {
  const acc = state.accounts.find((a) => a.name === c.name)
  if (c.kind === 'create') {
    const n = nameProblem(c.name)
    if (n) return n
    if (acc) return msg('files_explorer_exists', { name: c.name })
  } else if (!acc) return msg('users_error_notFound', { name: c.name })
  if (c.kind === 'create' || c.kind === 'update') {
    const f = fullNameProblem(c.fullName)
    if (f) return f
    if (!state.shells.includes(c.shell)) return msg('users_error_shellNotListed', { shell: c.shell })
    const unknown = c.groups.find((g) => !state.groups.some((x) => x.name === g))
    if (unknown) return msg('users_error_groupNotFound', { group: unknown })
  }
  if ((c.kind === 'create' && c.password !== undefined) || c.kind === 'password' || c.kind === 'samba-password') {
    const p = passwordProblem(c.password!)
    if (p) return p
  }
  if (acc?.protected && (c.kind === 'delete' || (c.kind === 'update' && !c.admin && acc.uid === 0))) return acc.protected
  if (c.kind === 'samba-password') return undefined
  const before = adminsWithPassword(state.accounts)
  const after = adminsWithPassword(afterChange(state.accounts, c))
  if (before.length && !after.length) return msg('users_error_lastAdmin')
  return undefined
}

/** One sentence on what the change does, for the confirmation. */
export function describeChange(c: UserChange, adminGroup: string): string {
  switch (c.kind) {
    case 'create':
      return msg('users_describe_create', { name: c.name, admin: c.admin ? msg('users_describe_createAdmin', { group: adminGroup }) : '', password: msg(c.password ? 'users_describe_withPassword' : 'users_describe_withoutPassword') })
    case 'update':
      return msg('users_describe_update', { name: c.name, group: adminGroup, admin: String(!!c.admin) })
    case 'password':
      return msg('users_describe_setPassword', { name: c.name })
    case 'lock':
      return msg('users_describe_lock', { name: c.name })
    case 'unlock':
      return msg('users_describe_unlock', { name: c.name })
    case 'samba-password':
      return msg('users_describe_setSamba', { name: c.name })
    case 'delete':
      return msg('users_describe_delete', { name: c.name, removeHome: String(!!c.removeHome) })
  }
}
