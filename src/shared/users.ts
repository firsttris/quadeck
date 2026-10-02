// Accounts of the server: types, parsers for passwd/shadow/group, the checks
// for every change and the lock-out guard. Shared by the page and the helper.

import { tr } from './i18n'

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
  wheel: tr('Administrator: sudo und Quadeck entsperren', 'Administrator: sudo and unlocking Quadeck'),
  sudo: tr('Administrator: sudo und Quadeck entsperren', 'Administrator: sudo and unlocking Quadeck'),
  video: tr('Grafikkarte nutzen (Hardware-Transcoding)', 'Use the graphics card (hardware transcoding)'),
  render: tr('GPU-Rechenzugriff (Hardware-Transcoding, KI)', 'GPU compute access (hardware transcoding, AI)'),
  audio: tr('Soundkarte', 'Sound card'),
  storage: tr('Wechseldatenträger einhängen', 'Mount removable media'),
  'systemd-journal': tr('Journal aller Dienste lesen', 'Read the journal of all services'),
  docker: tr('Docker ohne sudo – faktisch root-Rechte', 'Docker without sudo – effectively root'),
  libvirt: tr('Virtuelle Maschinen verwalten', 'Manage virtual machines'),
  kvm: tr('KVM-Virtualisierung', 'KVM virtualization'),
  input: tr('Eingabegeräte', 'Input devices'),
  lp: tr('Drucker', 'Printers'),
  uucp: tr('Serielle Geräte (z. B. Zigbee-Sticks)', 'Serial devices (e.g. Zigbee sticks)'),
  dialout: tr('Serielle Geräte (z. B. Zigbee-Sticks)', 'Serial devices (e.g. Zigbee sticks)'),
  plugdev: tr('Wechselgeräte', 'Removable devices'),
  users: tr('Allgemeine Benutzergruppe', 'General users group'),
  sambashare: tr('Eigene Samba-Freigaben anlegen', 'Create own Samba shares'),
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
  if (!USER_NAME.test(name)) return tr('Name: Kleinbuchstaben, Ziffern, - und _ (beginnt mit einem Buchstaben), höchstens 32 Zeichen', 'Name: lowercase letters, digits, - and _ (starting with a letter), at most 32 characters')
  return undefined
}

export function passwordProblem(pw: string): string | undefined {
  if (pw.length < MIN_PASSWORD) return tr(`Passwort: mindestens ${MIN_PASSWORD} Zeichen`, `Password: at least ${MIN_PASSWORD} characters`)
  if (pw.length > 512 || /[\r\n\x00]/.test(pw)) return tr('Passwort enthält ungültige Zeichen', 'Password contains invalid characters')
  return undefined
}

export function fullNameProblem(n: string): string | undefined {
  if (n.length > 100 || /[:,\r\n\x00-\x1f]/.test(n)) return tr('Voller Name: ohne Doppelpunkt, Komma und Zeilenumbruch', 'Full name: no colon, comma or line break')
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
    if (acc) return tr(`${c.name} gibt es schon`, `${c.name} already exists`)
  } else if (!acc) return tr(`${c.name} gibt es nicht`, `${c.name} does not exist`)
  if (c.kind === 'create' || c.kind === 'update') {
    const f = fullNameProblem(c.fullName)
    if (f) return f
    if (!state.shells.includes(c.shell)) return tr(`Shell ${c.shell} steht nicht in /etc/shells`, `Shell ${c.shell} is not listed in /etc/shells`)
    const unknown = c.groups.find((g) => !state.groups.some((x) => x.name === g))
    if (unknown) return tr(`Gruppe ${unknown} gibt es nicht`, `Group ${unknown} does not exist`)
  }
  if ((c.kind === 'create' && c.password !== undefined) || c.kind === 'password' || c.kind === 'samba-password') {
    const p = passwordProblem(c.password!)
    if (p) return p
  }
  if (acc?.protected && (c.kind === 'delete' || (c.kind === 'update' && !c.admin && acc.uid === 0))) return acc.protected
  if (c.kind === 'samba-password') return undefined
  const before = adminsWithPassword(state.accounts)
  const after = adminsWithPassword(afterChange(state.accounts, c))
  if (before.length && !after.length) return tr(
      'Danach könnte sich niemand mehr als Administrator anmelden – Quadeck ließe sich nicht mehr entsperren und sudo ginge nicht mehr. Zuerst einem anderen Administrator ein Passwort geben.',
      'Afterwards nobody could log in as administrator anymore – Quadeck could not be unlocked and sudo would no longer work. Give another administrator a password first.',
    )
  return undefined
}

/** One sentence on what the change does, for the confirmation. */
export function describeChange(c: UserChange, adminGroup: string): string {
  switch (c.kind) {
    case 'create':
      return tr(
        `Legt ${c.name} mit Home-Verzeichnis /home/${c.name} an${c.admin ? `, als Administrator (Gruppe ${adminGroup})` : ''}${c.password ? ', mit Passwort' : ', ohne Passwort – Anmeldung nur mit SSH-Schlüssel'}.`,
        `Creates ${c.name} with home directory /home/${c.name}${c.admin ? `, as administrator (group ${adminGroup})` : ''}${c.password ? ', with password' : ', without password – login only with an SSH key'}.`,
      )
    case 'update':
      return tr(
        `Speichert Namen, Shell und Gruppen von ${c.name}${c.admin ? ` (Administrator über ${adminGroup})` : ''}. Neue Gruppen gelten ab der nächsten Anmeldung.`,
        `Saves name, shell and groups of ${c.name}${c.admin ? ` (administrator via ${adminGroup})` : ''}. New groups apply from the next login.`,
      )
    case 'password':
      return tr(`Setzt ein neues Passwort für ${c.name}. Laufende Sitzungen bleiben angemeldet.`, `Sets a new password for ${c.name}. Running sessions stay logged in.`)
    case 'lock':
      return tr(
        `Sperrt ${c.name}: keine Anmeldung mehr, auch nicht mit SSH-Schlüssel. Laufende Sitzungen und Dienste des Kontos laufen weiter.`,
        `Locks ${c.name}: no more logins, not even with an SSH key. Running sessions and services of the account keep running.`,
      )
    case 'unlock':
      return tr(`Entsperrt ${c.name}.`, `Unlocks ${c.name}.`)
    case 'samba-password':
      return tr(`Setzt das Samba-Passwort von ${c.name} (für Freigaben im Netzwerk, getrennt vom Login-Passwort).`, `Sets the Samba password of ${c.name} (for network shares, separate from the login password).`)
    case 'delete':
      return tr(
        `Löscht ${c.name}${c.removeHome ? ' samt Home-Verzeichnis und Mail-Spool – die Dateien sind danach weg' : '; das Home-Verzeichnis bleibt erhalten'}.`,
        `Deletes ${c.name}${c.removeHome ? ' along with the home directory and mail spool – the files will be gone' : '; the home directory is kept'}.`,
      )
  }
}
