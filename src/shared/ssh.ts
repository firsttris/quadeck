// SSH access: types shared by the page, the web app and the root helper.

import { tr } from './i18n'

export interface SshKey {
  type: string
  bits?: number
  /** SHA256:… like ssh-keygen -l */
  fingerprint: string
  comment: string
  /** Line has options in front (from=, command= …) – shown, not editable here. */
  options?: string
  weak?: string
  lastUsed?: number
}

export interface SshUser {
  name: string
  uid: number
  home: string
  keys: SshKey[]
  /** Wrong owner/permissions on ~/.ssh or authorized_keys – sshd ignores the keys then. */
  problems: string[]
}

export type RootLogin = 'yes' | 'prohibit-password' | 'no'

export interface SshSettings {
  passwordAuthentication: boolean
  permitRootLogin: RootLogin
  /** Empty = every user may log in. */
  allowUsers: string[]
}

export interface SshLogin {
  ts: number
  user: string
  from: string
  /** Client port – with `from` it identifies the connection. */
  port?: number
  method: string
  fingerprint?: string
  /** The connection is still open right now. */
  active?: boolean
}

export interface SshState {
  installed: boolean
  services: { unit: string; active: boolean; enabled: boolean }[]
  ports: number[]
  hostKeys: { type: string; bits?: number; fingerprint: string }[]
  /** What sshd actually uses (sshd -T). */
  effective: SshSettings & { pubkeyAuthentication: boolean }
  /** Quadeck's drop-in (null = none written yet). */
  managed: SshSettings | null
  dropIn: string
  /** sshd_config includes sshd_config.d/*.conf – required for the drop-in. */
  dropInActive: boolean
  users: SshUser[]
  logins: SshLogin[]
  failed: { from: string; count: number; last: number }[]
  hostname: string
  error?: string
}

export type SshChange =
  | { kind: 'add-key'; user: string; key: string }
  | { kind: 'remove-key'; user: string; fingerprint: string; force?: boolean }
  | { kind: 'settings'; settings: SshSettings; force?: boolean }

export interface SshPreview {
  file: string
  before: string
  after: string
  warnings: string[]
  /** Would lock people out – needs force. */
  blocked?: string
}

/** Key types sshd accepts for logins (DSA is gone in current OpenSSH). */
export const KEY_TYPES = ['ssh-ed25519', 'sk-ssh-ed25519@openssh.com', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ecdsa-sha2-nistp256@openssh.com', 'ssh-rsa'] as const

export const USER_NAME = /^[a-z_][a-z0-9_.-]{0,31}$/

export function validateSettings(s: SshSettings): string[] {
  const e: string[] = []
  if (!['yes', 'prohibit-password', 'no'].includes(s.permitRootLogin)) e.push(tr('PermitRootLogin: yes, prohibit-password oder no', 'PermitRootLogin: yes, prohibit-password or no'))
  if (s.allowUsers.length > 50 || s.allowUsers.some((u) => !USER_NAME.test(u))) e.push(tr('Erlaubte Benutzer: Namen durch Leerzeichen getrennt', 'Allowed users: names separated by spaces'))
  return e
}
