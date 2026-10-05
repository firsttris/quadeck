// Verifies a Linux account password against /etc/shadow with the system's
// crypt(3) (libxcrypt: yescrypt, sha512, …) via bun:ffi. Only the helper
// (root) can read /etc/shadow.

import { CString, dlopen, FFIType, type Pointer } from 'bun:ffi'
import { readFileSync } from 'node:fs'

const LIBS = ['libcrypt.so.2', 'libcrypt.so.1', 'libcrypt.so', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1']
type CryptFn = (key: Buffer, setting: Buffer) => Pointer | null
let cryptFn: CryptFn | null | undefined

function loadCrypt(): CryptFn | null {
  if (cryptFn !== undefined) return cryptFn
  for (const name of LIBS) {
    try {
      const lib = dlopen(name, { crypt: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.ptr } })
      cryptFn = lib.symbols.crypt as unknown as CryptFn
      return cryptFn
    } catch {
      // try the next name
    }
  }
  cryptFn = null
  return null
}

const cstr = (s: string) => Buffer.from(s + '\0', 'utf8')

/** crypt(3) wrapper; undefined if no crypt library or the hash type is unsupported. */
export function crypt(password: string, setting: string): string | undefined {
  const fn = loadCrypt()
  if (!fn) return undefined
  const ptr = fn(cstr(password), cstr(setting))
  if (!ptr) return undefined
  const out = new CString(ptr).toString()
  return out.startsWith('*') ? undefined : out
}

export function shadowHash(shadow: string, user: string): string | undefined {
  for (const line of shadow.split('\n')) {
    const [name, hash] = line.split(':')
    if (name === user) return hash
  }
  return undefined
}

/** Members of a group from /etc/group (supplementary members only). */
export function groupMembers(groupFile: string, group: string): string[] {
  for (const line of groupFile.split('\n')) {
    const f = line.split(':')
    if (f[0] === group) return (f[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  }
  return []
}

export const ADMIN_GROUPS = ['wheel', 'sudo', 'admin']

export interface SystemAuthFiles {
  shadow: string
  group: string
  /** For the primary group of an account (an admin group can be that, too). */
  passwd?: string
}

export function readAuthFiles(): SystemAuthFiles {
  return {
    shadow: readFileSync(process.env.QUADECK_SHADOW || '/etc/shadow', 'utf8'),
    group: readFileSync(process.env.QUADECK_GROUP || '/etc/group', 'utf8'),
    passwd: readFileSync(process.env.QUADECK_PASSWD || '/etc/passwd', 'utf8'),
  }
}

/** Accounts allowed to unlock: root and members of wheel/sudo/admin. */
export function isAdmin(files: SystemAuthFiles, user: string) {
  if (user === 'root' || ADMIN_GROUPS.some((g) => groupMembers(files.group, g).includes(user))) return true
  // /etc/group lists supplementary members only; the primary group is the gid in /etc/passwd
  const gid = files.passwd?.split('\n').map((l) => l.split(':')).find((f) => f[0] === user)?.[3]
  if (gid === undefined) return false
  const adminGids = files.group
    .split('\n')
    .map((l) => l.split(':'))
    .filter((f) => ADMIN_GROUPS.includes(f[0]!))
    .map((f) => f[2])
  return adminGids.includes(gid)
}

/** First admin user that is not root (the person's own account), else root. */
export function suggestedUser(files: SystemAuthFiles): string {
  for (const g of ADMIN_GROUPS) {
    const m = groupMembers(files.group, g)
    if (m.length) return m[0]!
  }
  return 'root'
}

export type VerifyResult = 'ok' | 'wrong' | 'not-admin' | 'no-password' | 'unsupported'

/** Constant-time-ish result: always runs crypt for existing users with a hash. */
export function verifySystemPassword(files: SystemAuthFiles, user: string, password: string): VerifyResult {
  if (!/^[a-z_][a-z0-9_.-]{0,31}\$?$/i.test(user)) return 'wrong'
  if (!isAdmin(files, user)) return 'not-admin'
  const hash = shadowHash(files.shadow, user)
  if (!hash || !hash.startsWith('$')) return 'no-password' // "!", "*", "!!" = locked/no password
  const out = crypt(password, hash)
  if (out === undefined) return 'unsupported'
  if (out.length !== hash.length) return 'wrong'
  let diff = 0
  for (let i = 0; i < out.length; i++) diff |= out.charCodeAt(i) ^ hash.charCodeAt(i)
  return diff === 0 ? 'ok' : 'wrong'
}
