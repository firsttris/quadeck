// authorized_keys, sshd -T, journal lines: pure functions (unit-tested).

import { createHash } from 'node:crypto'
import { KEY_TYPES, type RootLogin, type SshKey, type SshLogin, type SshSettings } from '~/shared/ssh'

/** Length-prefixed fields of an SSH wire-format blob. */
function fields(blob: Buffer): Buffer[] {
  const out: Buffer[] = []
  let o = 0
  while (o + 4 <= blob.length && out.length < 4) {
    const n = blob.readUInt32BE(o)
    if (o + 4 + n > blob.length) break
    out.push(blob.subarray(o + 4, o + 4 + n))
    o += 4 + n
  }
  return out
}

function keyBits(type: string, blob: Buffer): number | undefined {
  if (type === 'ssh-ed25519' || type.startsWith('sk-ssh-ed25519')) return 256
  const m = type.match(/nistp(\d+)/)
  if (m) return Number(m[1])
  if (type === 'ssh-rsa') {
    const n = fields(blob)[2]
    if (!n) return undefined
    let i = 0
    while (i < n.length && n[i] === 0) i++
    const first = n[i] ?? 0
    return (n.length - i - 1) * 8 + (first ? Math.floor(Math.log2(first)) + 1 : 0)
  }
  return undefined
}

export const fingerprint = (blob: Buffer) => 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')

/**
 * One authorized_keys line → key, or an error. Options before the key type
 * (from="…",no-pty …) are recognized and kept as they are.
 */
export function parseKeyLine(line: string): { key: SshKey; blob: string } | { error: string } {
  const t = line.trim()
  if (!t || t.startsWith('#')) return { error: 'leer' }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(t)) return { error: 'Steuerzeichen im Schlüssel' }
  const tokens = t.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
  const idx = tokens.findIndex((x) => (KEY_TYPES as readonly string[]).includes(x) || x === 'ssh-dss')
  if (idx < 0) return { error: 'Kein bekannter Schlüsseltyp (erwartet z. B. „ssh-ed25519 AAAA… name@gerät“)' }
  const type = tokens[idx]!
  const b64 = tokens[idx + 1] ?? ''
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { error: 'Schlüsseldaten fehlen oder sind kein Base64' }
  const blob = Buffer.from(b64, 'base64')
  const inner = fields(blob)[0]?.toString('latin1')
  if (inner !== type) return { error: `Schlüsseldaten passen nicht zum Typ ${type}` }
  const bits = keyBits(type, blob)
  let weak: string | undefined
  if (type === 'ssh-dss') weak = 'DSA wird von aktuellem OpenSSH nicht mehr akzeptiert'
  else if (type === 'ssh-rsa' && bits !== undefined && bits < 3072) weak = `RSA mit ${bits} Bit – heute zu kurz, besser ed25519`
  return {
    key: {
      type,
      bits,
      fingerprint: fingerprint(blob),
      comment: tokens.slice(idx + 2).join(' '),
      options: idx > 0 ? tokens.slice(0, idx).join(' ') : undefined,
      weak,
    },
    blob: b64,
  }
}

export function parseAuthorizedKeys(text: string): SshKey[] {
  return text
    .split('\n')
    .map(parseKeyLine)
    .filter((r): r is { key: SshKey; blob: string } => 'key' in r)
    .map((r) => r.key)
}

/** Removes every line holding the key with this fingerprint. */
export function removeKey(text: string, fp: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const r = parseKeyLine(l)
      return !('key' in r) || r.key.fingerprint !== fp
    })
    .join('\n')
}

/** Appends a key line (normalised: type, data, comment). */
export function addKey(text: string, line: string): string {
  const r = parseKeyLine(line)
  if (!('key' in r)) throw new Error(r.error)
  if (r.key.options) throw new Error('Schlüssel mit Optionen (from=, command= …) bitte von Hand eintragen')
  if (r.key.type === 'ssh-dss') throw new Error(r.key.weak!)
  if (parseAuthorizedKeys(text).some((k) => k.fingerprint === r.key.fingerprint)) throw new Error('Dieser Schlüssel ist schon eingetragen')
  const clean = [r.key.type, r.blob, r.key.comment].filter(Boolean).join(' ')
  const body = text.replace(/\s*$/, '')
  return `${body}${body ? '\n' : ''}${clean}\n`
}

/** `sshd -T` → the settings Quadeck shows. */
export function parseSshdT(out: string): SshSettings & { pubkeyAuthentication: boolean; ports: number[] } {
  const ports: number[] = []
  const v = new Map<string, string>()
  for (const line of out.split('\n')) {
    const [k, ...rest] = line.trim().split(/\s+/)
    if (!k) continue
    if (k === 'port') ports.push(Number(rest[0]))
    else if (!v.has(k)) v.set(k, rest.join(' '))
  }
  const root = v.get('permitrootlogin') ?? 'prohibit-password'
  return {
    passwordAuthentication: v.get('passwordauthentication') !== 'no',
    pubkeyAuthentication: v.get('pubkeyauthentication') !== 'no',
    permitRootLogin: (root === 'without-password' ? 'prohibit-password' : root === 'forced-commands-only' ? 'prohibit-password' : root) as RootLogin,
    allowUsers: (v.get('allowusers') ?? '').split(/\s+/).filter(Boolean),
    ports: ports.length ? ports : [22],
  }
}

export const DROPIN_HEADER = '# Von Quadeck verwaltet (Seite SSH). Eigene Einstellungen bitte in einer anderen Datei.\n'

export function renderDropIn(s: SshSettings): string {
  // Keyboard-interactive is the other way to type a password: off together with it.
  return `${DROPIN_HEADER}PasswordAuthentication ${s.passwordAuthentication ? 'yes' : 'no'}\n${s.passwordAuthentication ? '' : 'KbdInteractiveAuthentication no\n'}PermitRootLogin ${s.permitRootLogin}\n${s.allowUsers.length ? `AllowUsers ${s.allowUsers.join(' ')}\n` : ''}`
}

export function parseDropIn(text: string): SshSettings | null {
  if (!text.trim()) return null
  const get = (k: string) => text.match(new RegExp(`^\\s*${k}\\s+(.+)$`, 'mi'))?.[1]?.trim()
  return {
    passwordAuthentication: get('PasswordAuthentication') !== 'no',
    permitRootLogin: ((get('PermitRootLogin') ?? 'prohibit-password').replace('without-password', 'prohibit-password') as RootLogin),
    allowUsers: (get('AllowUsers') ?? '').split(/\s+/).filter(Boolean),
  }
}

/**
 * sshd journal lines (journalctl -o short-unix): accepted logins and
 * failed attempts.
 */
export function parseAuthLog(out: string, now = Date.now()): { logins: SshLogin[]; failed: { from: string; count: number; last: number }[] } {
  const logins: SshLogin[] = []
  const failed = new Map<string, { count: number; last: number }>()
  for (const line of out.split('\n')) {
    const ts = Number(line.split(' ')[0]) * 1000
    if (!Number.isFinite(ts)) continue
    const ok = line.match(/Accepted (\S+) for (\S+) from (\S+) port (\d+)(?: ssh2(?:: \S+ (SHA256:\S+))?)?/)
    if (ok) {
      logins.push({ ts, method: ok[1]!, user: ok[2]!, from: ok[3]!, port: Number(ok[4]), fingerprint: ok[5] })
      continue
    }
    const bad = line.match(/(?:Failed \S+ for (?:invalid user )?\S+|Invalid user \S* ?) from (\S+)/)
    if (bad && now - ts < 24 * 3600_000) {
      const f = failed.get(bad[1]!) ?? { count: 0, last: 0 }
      failed.set(bad[1]!, { count: f.count + 1, last: Math.max(f.last, ts) })
    }
  }
  return {
    logins: logins.sort((a, b) => b.ts - a.ts),
    failed: [...failed].map(([from, f]) => ({ from, ...f })).sort((a, b) => b.count - a.count).slice(0, 10),
  }
}

/** Normalises an address from ss: brackets and the IPv4-mapped prefix go. */
const peerAddr = (a: string) => a.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '')

/**
 * Open SSH connections from `ss -Htn state established`: "addr:port" of every
 * client connected to one of sshd's ports.
 */
export function parseEstablished(out: string, sshPorts: number[]): Set<string> {
  const open = new Set<string>()
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4) continue
    const [local, peer] = cols.slice(-2) as [string, string]
    const lp = Number(local.slice(local.lastIndexOf(':') + 1))
    if (!sshPorts.includes(lp)) continue
    const i = peer.lastIndexOf(':')
    open.add(`${peerAddr(peer.slice(0, i))}:${peer.slice(i + 1)}`)
  }
  return open
}
