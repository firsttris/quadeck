// SMB shares and NFS exports: types and validation shared by the form, the
// web app and the root helper.

import { msg } from './i18n'
import { m } from '~/paraglide/messages'

export interface SmbShareSpec {
  name: string
  path: string
  comment: string
  readOnly: boolean
  guestOk: boolean
  /** "alice @family" – empty = everyone who can log in. */
  validUsers: string
  browseable: boolean
}

export interface SmbShareInfo extends SmbShareSpec {
  /** Other keys in the section (create mask, vfs objects …) – kept as they are. */
  extraKeys: string[]
  connections: number
}

/** All flag options of exports(5), so exports written by hand stay editable. */
export const NFS_OPTIONS = [
  'rw',
  'ro',
  'sync',
  'async',
  'no_subtree_check',
  'subtree_check',
  'root_squash',
  'no_root_squash',
  'all_squash',
  'no_all_squash',
  'insecure',
  'secure',
  'crossmnt',
  'nohide',
  'hide',
  'no_wdelay',
  'wdelay',
  'insecure_locks',
  'no_auth_nlm',
  'secure_locks',
  'auth_nlm',
  'mountpoint',
  'mp',
  'nordirplus',
  'pnfs',
  'no_pnfs',
  'security_label',
  'acl',
  'no_acl',
] as const

export interface NfsClient {
  host: string
  options: string[]
}

export interface NfsExportSpec {
  path: string
  clients: NfsClient[]
}

export interface NfsExportInfo extends NfsExportSpec {
  file: string
  line: number
  /** Written by Quadeck (/etc/exports.d/quadeck.exports) or by hand elsewhere. */
  managed: boolean
}

export interface ShareService {
  unit: string
  exists: boolean
  active: boolean
  enabled: boolean
}

export interface ShareConnection {
  share: string
  client: string
  since?: number
}

export interface SharesState {
  smb: { file: string; exists: boolean; installed: boolean; shares: SmbShareInfo[]; services: ShareService[]; connections: ShareConnection[]; error?: string }
  nfs: { files: string[]; managedFile: string; installed: boolean; exports: NfsExportInfo[]; services: ShareService[]; clients: string[]; error?: string }
}

export type ShareChange = { kind: 'smb'; original?: string; spec: SmbShareSpec | null } | { kind: 'nfs'; original?: { file: string; path: string }; spec: NfsExportSpec | null }

export interface SharePreview {
  file: string
  before: string
  after: string
  warnings: string[]
}

export type ShareServiceAction = 'start' | 'stop' | 'restart' | 'enable'

const RESERVED_SMB = new Set(['global', 'homes', 'printers', 'print$', 'ipc$'])
const SMB_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.$-]{0,79}$/
const USER_TOKEN = /^[@+&]?[A-Za-z0-9_.\\-]{1,64}$/
const NFS_HOST = /^[A-Za-z0-9.*?:/[\]@_-]{1,253}$/
const NFS_VALUE_OPTION =
  /^(fsid=(\d{1,10}|root|[0-9a-fA-F-]{32,36})|anonuid=-?\d{1,10}|anongid=-?\d{1,10}|sec=(sys|krb5|krb5i|krb5p)(:(sys|krb5|krb5i|krb5p))*|xprtsec=(none|tls|mtls)(:(none|tls|mtls))*|(mountpoint|mp)=\/[A-Za-z0-9/._+-]{0,200}|(refer|replicas)=\/[A-Za-z0-9/._+-]*@[A-Za-z0-9.:+_-]+(\+[A-Za-z0-9.:_-]+)*(:\/[A-Za-z0-9/._+-]*@[A-Za-z0-9.:+_-]+(\+[A-Za-z0-9.:_-]+)*)*)$/

/** Paths that must never be shared (or anything below them). */
const FORBIDDEN = ['/etc', '/root', '/boot', '/proc', '/sys', '/dev', '/run', '/var/lib/quadeck', '/var/lib/quadeck-helper', '/var/lib/containers']

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/

export function validateSharePath(path: string): string | undefined {
  if (!path.startsWith('/')) return msg(m.shares_check_pathNotAbsolute)
  if (CONTROL.test(path) || path.includes('"')) return msg(m.shares_check_pathInvalidChars)
  if (path.split('/').includes('..')) return msg(m.files_check_pathDotDot)
  const clean = path.replace(/\/+$/, '') || '/'
  if (clean === '/') return msg(m.shares_check_rootDir)
  const bad = FORBIDDEN.find((f) => clean === f || clean.startsWith(f + '/'))
  if (bad) return msg(m.shares_check_pathForbidden, { path: bad })
  return undefined
}

export function validateSmb(s: SmbShareSpec): string[] {
  const e: string[] = []
  if (!SMB_NAME.test(s.name)) e.push(msg(m.shares_check_nameInvalid))
  else if (RESERVED_SMB.has(s.name.toLowerCase())) e.push(msg(m.shares_check_nameReserved, { name: s.name }))
  const p = validateSharePath(s.path)
  if (p) e.push(p)
  if (CONTROL.test(s.comment) || s.comment.length > 200) e.push(msg(m.shares_check_commentInvalid))
  const users = s.validUsers.split(/[\s,]+/).filter(Boolean)
  if (CONTROL.test(s.validUsers) || users.some((u) => !USER_TOKEN.test(u))) e.push(msg(m.shares_check_usersInvalid))
  return e
}

export function validateNfs(s: NfsExportSpec): string[] {
  const e: string[] = []
  const p = validateSharePath(s.path)
  if (p) e.push(p)
  if (!s.clients.length) e.push(msg(m.shares_check_noClients))
  if (s.clients.length > 50) e.push(msg(m.shares_check_tooManyClients))
  for (const c of s.clients) {
    if (!NFS_HOST.test(c.host)) e.push(msg(m.shares_check_clientInvalid, { host: c.host }))
    for (const o of c.options) if (!(NFS_OPTIONS as readonly string[]).includes(o) && !NFS_VALUE_OPTION.test(o)) e.push(msg(m.shares_check_optionNotAllowed, { option: o }))
    if (c.options.includes('rw') && c.options.includes('ro')) e.push(msg(m.shares_check_rwAndRo, { host: c.host }))
  }
  return e
}
