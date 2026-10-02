// SSH access on the host: keys per user, sshd settings via a drop-in,
// service, host keys, recent logins. SystemSsh runs where root is;
// FixtureSsh keeps demo data in memory.

import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { HttpError } from '../auth'
import { run } from '../exec'
import { tr } from '~/shared/i18n'
import { USER_NAME, validateSettings, type SshChange, type SshKey, type SshLogin, type SshPreview, type SshSettings, type SshState, type SshUser } from '~/shared/ssh'
import { addKey, parseAuthLog, parseAuthorizedKeys, parseEstablished, parseDropIn, parseKeyLine, parseSshdT, removeKey, renderDropIn } from './keys'

export interface SshAdmin {
  sshState(): Promise<SshState>
  previewSsh(change: SshChange): Promise<SshPreview>
}

export interface SshBackend extends SshAdmin {
  applySsh(change: SshChange): Promise<SshState>
  sshService(action: 'start' | 'restart' | 'enable'): Promise<SshState>
}

/** Parses a change from outside (web app → helper). */
export function parseSshChange(v: unknown): SshChange {
  const o = (v ?? {}) as Record<string, unknown>
  const str = (x: unknown) => (typeof x === 'string' ? x : '')
  const user = str(o.user)
  if (o.kind === 'add-key' || o.kind === 'remove-key') {
    if (!USER_NAME.test(user)) throw new HttpError(400, tr('Ungültiger Benutzer', 'Invalid user'))
    if (o.kind === 'add-key') {
      const key = str(o.key).trim()
      if (!key || key.length > 16_384 || key.includes('\n')) throw new HttpError(400, tr('Genau eine Schlüsselzeile einfügen', 'Paste exactly one key line'))
      return { kind: 'add-key', user, key }
    }
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(str(o.fingerprint))) throw new HttpError(400, tr('Ungültiger Fingerprint', 'Invalid fingerprint'))
    return { kind: 'remove-key', user, fingerprint: str(o.fingerprint), force: o.force === true }
  }
  if (o.kind === 'settings') {
    const s = (o.settings ?? {}) as Record<string, unknown>
    const settings: SshSettings = {
      passwordAuthentication: s.passwordAuthentication !== false,
      permitRootLogin: str(s.permitRootLogin) as SshSettings['permitRootLogin'],
      allowUsers: Array.isArray(s.allowUsers) ? [...new Set(s.allowUsers.map(str).filter(Boolean))] : [],
    }
    const errs = validateSettings(settings)
    if (errs.length) throw new HttpError(400, errs.join(' · '))
    return { kind: 'settings', settings, force: o.force === true }
  }
  throw new HttpError(400, tr('Unbekannte Änderung', 'Unknown change'))
}

/** Who could still log in with a key after a change (lock-out guard). */
export function keyLoginPossible(users: SshUser[], s: SshSettings): boolean {
  return users.some((u) => {
    if (s.allowUsers.length && !s.allowUsers.includes(u.name)) return false
    if (u.uid === 0 && s.permitRootLogin === 'no') return false
    return !u.problems.length && u.keys.some((k) => !k.options && k.type !== 'ssh-dss')
  })
}

/** Warnings and the lock-out verdict for a settings change. */
export function judgeSettings(users: SshUser[], s: SshSettings): { warnings: string[]; blocked?: string } {
  const warnings: string[] = []
  const unknown = s.allowUsers.filter((u) => !users.some((x) => x.name === u))
  if (unknown.length) warnings.push(tr(`Unbekannte Benutzer in AllowUsers: ${unknown.join(', ')}`, `Unknown users in AllowUsers: ${unknown.join(', ')}`))
  if (s.permitRootLogin === 'yes') warnings.push(tr('root darf sich mit Passwort anmelden – besser „nur mit Schlüssel“ oder „nein“', 'root may log in with a password – better “key only” or “no”'))
  if (s.passwordAuthentication) warnings.push(tr('Passwort-Login ist an – Angreifer können Passwörter durchprobieren', 'Password login is on – attackers can try out passwords'))
  if (!s.passwordAuthentication && !keyLoginPossible(users, s))
    return {
      warnings,
      blocked: tr('Ohne Passwort-Login könnte sich niemand mehr anmelden: kein erlaubter Benutzer hat einen funktionierenden Schlüssel.', 'Without password login nobody could log in anymore: no allowed user has a working key.'),
    }
  if (s.allowUsers.length && !users.some((u) => s.allowUsers.includes(u.name) && !(u.uid === 0 && s.permitRootLogin === 'no')))
    return { warnings, blocked: tr('Kein erlaubter Benutzer dürfte sich anmelden.', 'No allowed user would be able to log in.') }
  warnings.push(tr('Bleib in deiner jetzigen SSH-Sitzung angemeldet und teste den Zugang in einer zweiten, bevor du sie schließt.', 'Stay logged in to your current SSH session and test access in a second one before closing it.'))
  return { warnings }
}

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

interface PasswdUser {
  name: string
  uid: number
  gid: number
  home: string
}

/** Login-capable accounts: root and regular users (uid 1000–59999) with a real shell. */
export function loginUsers(passwd: string): PasswdUser[] {
  return passwd
    .split('\n')
    .map((l) => l.split(':'))
    .filter((f) => f.length >= 7)
    .map((f) => ({ name: f[0]!, uid: Number(f[2]), gid: Number(f[3]), home: f[5]!, shell: f[6]! }))
    .filter((u) => (u.uid === 0 || (u.uid >= 1000 && u.uid < 60000)) && !/(nologin|false|sync|halt|shutdown)$/.test(u.shell) && USER_NAME.test(u.name))
    .map(({ shell: _s, ...u }) => u)
}

export class SystemSsh implements SshBackend {
  private etc: string
  private passwd: string
  private live: boolean

  /** live = false: no sshd/systemctl/journal and no chown (tests on temp directories). */
  constructor(opts: { etc?: string; passwd?: string; live?: boolean } = {}) {
    this.etc = opts.etc ?? '/etc/ssh'
    this.passwd = opts.passwd ?? '/etc/passwd'
    this.live = opts.live ?? true
  }

  get dropIn() {
    return join(this.etc, 'sshd_config.d', '01-quadeck.conf')
  }

  private sshd() {
    return Bun.which('sshd') ?? ['/usr/sbin/sshd', '/usr/bin/sshd'].find(existsSync)
  }

  private keysFile(home: string) {
    return join(home, '.ssh', 'authorized_keys')
  }

  private users(lastUsed: Map<string, number>): (SshUser & { gid: number })[] {
    return loginUsers(read(this.passwd) ?? '').map((u) => {
      const problems: string[] = []
      const file = this.keysFile(u.home)
      const text = read(file)
      if (text !== undefined) {
        // StrictModes: sshd ignores keys if these are writable by others or owned by someone else.
        for (const [p, what] of [
          [u.home, tr('Home-Verzeichnis', 'Home directory')],
          [join(u.home, '.ssh'), '~/.ssh'],
          [file, 'authorized_keys'],
        ] as const) {
          try {
            const st = statSync(p)
            if (this.live && st.uid !== u.uid && st.uid !== 0) problems.push(tr(`${what} gehört nicht ${u.name}`, `${what} is not owned by ${u.name}`))
            if (st.mode & 0o022) problems.push(tr(`${what} ist für andere beschreibbar – sshd ignoriert die Schlüssel`, `${what} is writable by others – sshd ignores the keys`))
          } catch {
            // missing
          }
        }
      }
      const keys: SshKey[] = parseAuthorizedKeys(text ?? '').map((k) => ({ ...k, lastUsed: lastUsed.get(k.fingerprint) }))
      return { name: u.name, uid: u.uid, gid: u.gid, home: u.home, keys, problems }
    })
  }

  private async effective() {
    const sshd = this.sshd()
    if (!sshd || !this.live) return { ...parseSshdT(''), ...(parseDropIn(read(this.dropIn) ?? '') ?? {}), error: sshd ? undefined : tr('sshd ist nicht installiert', 'sshd is not installed') }
    const r = await run([sshd, '-T'], { timeoutMs: 10_000 })
    return { ...parseSshdT(r.stdout), error: r.code === 0 ? undefined : `sshd -T: ${(r.stderr || r.stdout).trim().split('\n')[0]}` }
  }

  private async logins() {
    if (!this.live) return { logins: [], failed: [] }
    const args = ['journalctl', '-t', 'sshd', '-t', 'sshd-session', '--since', '-30d', '-o', 'short-unix', '--no-pager', '-n', '5000']
    let r = await run([...args, '-g', 'Accepted|Failed|Invalid user'], { timeoutMs: 15_000 })
    // journalctl without pcre2 support: filter here.
    if (r.code !== 0 && /pattern|pcre/i.test(r.stderr)) r = await run(args, { timeoutMs: 15_000 })
    return parseAuthLog(r.stdout)
  }

  /** Which of the logins are still connected (the journal alone cannot tell: disconnects get lost on restarts). */
  private async markActive(logins: SshLogin[], ports: number[]): Promise<SshLogin[]> {
    const r = await run(['ss', '-Htn', 'state', 'established'], { timeoutMs: 10_000 })
    if (r.code !== 0) return logins
    const open = parseEstablished(r.stdout, ports.length ? ports : [22])
    const seen = new Set<string>()
    return logins.map((l) => {
      const key = `${l.from}:${l.port}`
      const active = l.port !== undefined && open.has(key) && !seen.has(key)
      seen.add(key) // a reused client port belongs to the newest login only
      return { ...l, active }
    })
  }

  private async services() {
    if (!this.live) return []
    const r = await run(['systemctl', 'show', 'sshd.service', 'ssh.service', 'ssh.socket', '-p', 'Id,LoadState,ActiveState,UnitFileState'])
    return r.stdout
      .trim()
      .split(/\n\s*\n/)
      .map((b) => Object.fromEntries(b.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])))
      .filter((p) => p.Id && p.LoadState === 'loaded')
      .map((p) => ({ unit: p.Id!, active: p.ActiveState === 'active', enabled: p.UnitFileState === 'enabled' }))
  }

  async sshState(): Promise<SshState> {
    const [eff, log, services] = await Promise.all([this.effective(), this.logins(), this.services()])
    const lastUsed = new Map<string, number>()
    for (const l of log.logins) if (l.fingerprint && !lastUsed.has(l.fingerprint)) lastUsed.set(l.fingerprint, l.ts)
    let hostKeys: SshState['hostKeys'] = []
    try {
      hostKeys = readdirSync(this.etc)
        .filter((f) => /^ssh_host_.*_key\.pub$/.test(f))
        .map((f) => parseKeyLine(read(join(this.etc, f)) ?? ''))
        .filter((r) => 'key' in r)
        .map((r) => ({ type: (r as { key: SshKey }).key.type, bits: (r as { key: SshKey }).key.bits, fingerprint: (r as { key: SshKey }).key.fingerprint }))
    } catch {
      // no /etc/ssh
    }
    const { ports, pubkeyAuthentication, passwordAuthentication, permitRootLogin, allowUsers, error } = eff
    return {
      installed: !!this.sshd(),
      services,
      ports,
      hostKeys,
      effective: { passwordAuthentication, permitRootLogin, allowUsers, pubkeyAuthentication },
      managed: parseDropIn(read(this.dropIn) ?? ''),
      dropIn: this.dropIn,
      dropInActive: /^\s*Include\s+\S*sshd_config\.d\/\*\.conf/im.test(read(join(this.etc, 'sshd_config')) ?? ''),
      users: this.users(lastUsed).map(({ gid: _g, ...u }) => u),
      logins: await this.markActive(log.logins.slice(0, 25), ports),
      failed: log.failed,
      hostname: hostname(),
      error,
    }
  }

  private plan(change: SshChange, st: SshState, users: (SshUser & { gid: number })[]) {
    if (change.kind === 'settings') {
      const before = read(this.dropIn) ?? ''
      const verdict = judgeSettings(st.users, change.settings)
      return { file: this.dropIn, before, after: renderDropIn(change.settings), ...verdict }
    }
    const u = users.find((x) => x.name === change.user)
    if (!u) throw new HttpError(404, tr(`Benutzer ${change.user} kann sich nicht per SSH anmelden (kein Login-Konto)`, `User ${change.user} cannot log in via SSH (no login account)`))
    const file = this.keysFile(u.home)
    const before = read(file) ?? ''
    if (change.kind === 'add-key') {
      try {
        const after = addKey(before, change.key)
        const r = parseKeyLine(change.key) as { key: SshKey }
        return { file, before, after, warnings: r.key.weak ? [r.key.weak] : [], user: u }
      } catch (e) {
        throw new HttpError(422, (e as Error).message)
      }
    }
    if (!u.keys.some((k) => k.fingerprint === change.fingerprint)) throw new HttpError(404, tr('Schlüssel nicht gefunden', 'Key not found'))
    const after = removeKey(before, change.fingerprint)
    const remaining = st.users.map((x) => (x.name === u.name ? { ...x, keys: x.keys.filter((k) => k.fingerprint !== change.fingerprint) } : x))
    const eff = st.effective
    const blocked =
      !eff.passwordAuthentication && !keyLoginPossible(remaining, eff)
        ? tr(
            'Das ist der letzte funktionierende Schlüssel und Passwort-Login ist aus – danach käme niemand mehr per SSH auf den Server.',
            'This is the last working key and password login is off – afterwards nobody could get onto the server via SSH.',
          )
        : undefined
    return { file, before, after, warnings: [], blocked, user: u }
  }

  async previewSsh(change: SshChange): Promise<SshPreview> {
    const st = await this.sshState()
    const p = this.plan(change, st, this.users(new Map()))
    return { file: p.file, before: p.before, after: p.after, warnings: p.warnings, blocked: p.blocked }
  }

  private writeOwned(file: string, content: string, uid: number, gid: number) {
    const dir = join(file, '..')
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
    if (existsSync(file)) writeFileSync(`${file}.quadeck-bak`, readFileSync(file), { mode: 0o600 })
    const tmp = `${file}.quadeck-tmp`
    writeFileSync(tmp, content, { mode: 0o600 })
    if (this.live) {
      chownSync(dir, uid, gid)
      chownSync(tmp, uid, gid)
      if (existsSync(`${file}.quadeck-bak`)) chownSync(`${file}.quadeck-bak`, uid, gid)
    }
    renameSync(tmp, file)
  }

  private async reload() {
    if (!this.live) return
    // Debian/Ubuntu: ssh.service; Arch/Fedora: sshd.service. Socket activation reads the config per connection.
    for (const unit of ['sshd.service', 'ssh.service']) {
      const r = await run(['systemctl', 'is-active', unit])
      if (r.stdout.trim() === 'active') await run(['systemctl', 'reload', unit], { timeoutMs: 30_000 })
    }
  }

  async applySsh(change: SshChange): Promise<SshState> {
    const st = await this.sshState()
    const users = this.users(new Map())
    const p = this.plan(change, st, users)
    if (p.blocked && !(change.kind !== 'add-key' && change.force)) throw new HttpError(409, p.blocked)
    if (change.kind === 'settings') {
      if (!st.dropInActive)
        throw new HttpError(
          409,
          tr(
            `${join(this.etc, 'sshd_config')} bindet sshd_config.d/*.conf nicht ein – „Include /etc/ssh/sshd_config.d/*.conf“ oben ergänzen`,
            `${join(this.etc, 'sshd_config')} does not include sshd_config.d/*.conf – add “Include /etc/ssh/sshd_config.d/*.conf” at the top`,
          ),
        )
      mkdirSync(join(this.etc, 'sshd_config.d'), { recursive: true, mode: 0o755 })
      if (existsSync(this.dropIn)) writeFileSync(`${this.dropIn}.quadeck-bak`, p.before, { mode: 0o644 })
      writeFileSync(`${this.dropIn}.quadeck-tmp`, p.after, { mode: 0o644 })
      renameSync(`${this.dropIn}.quadeck-tmp`, this.dropIn)
      const sshd = this.sshd()
      if (this.live && sshd) {
        const t = await run([sshd, '-t'], { timeoutMs: 10_000 })
        if (t.code !== 0) {
          // Never leave a config behind that sshd refuses (it would not start again).
          if (p.before) writeFileSync(this.dropIn, p.before, { mode: 0o644 })
          else rmSync(this.dropIn, { force: true })
          throw new HttpError(422, tr(`sshd -t lehnt die Einstellung ab (zurückgesetzt): ${(t.stderr || t.stdout).trim()}`, `sshd -t rejects the setting (reverted): ${(t.stderr || t.stdout).trim()}`))
        }
      }
      await this.reload()
      const after = await this.sshState()
      const e = after.effective
      const s = change.settings
      if (this.live && (e.passwordAuthentication !== s.passwordAuthentication || e.permitRootLogin !== s.permitRootLogin))
        after.error = tr(
          `Gespeichert, aber sshd verwendet andere Werte (Passwort-Login ${e.passwordAuthentication ? 'an' : 'aus'}, root ${e.permitRootLogin}) – eine andere Datei in sshd_config.d oder sshd_config setzt sie zuerst.`,
          `Saved, but sshd uses different values (password login ${e.passwordAuthentication ? 'on' : 'off'}, root ${e.permitRootLogin}) – another file in sshd_config.d or sshd_config sets them first.`,
        )
      return after
    }
    const u = p.user!
    this.writeOwned(p.file, p.after, u.uid, u.gid)
    return this.sshState()
  }

  async sshService(action: 'start' | 'restart' | 'enable'): Promise<SshState> {
    const units = (await this.services()).filter((s) => s.unit.endsWith('.service')).map((s) => s.unit)
    if (!units.length) throw new HttpError(404, tr('Kein SSH-Dienst installiert (Paket openssh bzw. openssh-server)', 'No SSH service installed (package openssh or openssh-server)'))
    const argv = action === 'enable' ? ['systemctl', 'enable', '--now', ...units] : ['systemctl', action, ...units]
    const r = await run(argv, { timeoutMs: 60_000 })
    if (r.code !== 0) throw new HttpError(500, `${argv.join(' ')}: ${r.stderr.trim()}`)
    return this.sshState()
  }
}

// ---------- fixtures ----------

interface SshFixture {
  users: { name: string; uid: number; home: string; keys: string[] }[]
  hostKeys: string[]
  settings: SshSettings
  logins: { minutesAgo: number; user: string; from: string; method: string; key?: number; active?: boolean }[]
  failed: { from: string; count: number; minutesAgo: number }[]
}

export class FixtureSsh implements SshBackend {
  private data: SshFixture
  private managed: SshSettings | null = null
  private active = true

  constructor(dir: string) {
    this.data = JSON.parse(readFileSync(join(dir, 'ssh.json'), 'utf8')) as SshFixture
  }

  private usersNow(): SshUser[] {
    const fps = this.data.users.flatMap((u) => u.keys.map((k) => (parseKeyLine(k) as { key: SshKey }).key.fingerprint))
    const last = new Map<string, number>()
    for (const l of this.data.logins) if (l.key !== undefined && fps[l.key]) last.set(fps[l.key]!, Math.max(last.get(fps[l.key]!) ?? 0, Date.now() - l.minutesAgo * 60_000))
    return this.data.users.map((u) => ({ name: u.name, uid: u.uid, home: u.home, problems: [], keys: parseAuthorizedKeys(u.keys.join('\n')).map((k) => ({ ...k, lastUsed: last.get(k.fingerprint) })) }))
  }

  async sshState(): Promise<SshState> {
    const users = this.usersNow()
    const fps = users.flatMap((u) => u.keys.map((k) => k.fingerprint))
    const eff = this.managed ?? this.data.settings
    return {
      installed: true,
      services: [{ unit: 'sshd.service', active: this.active, enabled: true }],
      ports: [22],
      hostKeys: this.data.hostKeys.map((h) => {
        const k = (parseKeyLine(h) as { key: SshKey }).key
        return { type: k.type, bits: k.bits, fingerprint: k.fingerprint }
      }),
      effective: { ...eff, pubkeyAuthentication: true },
      managed: this.managed,
      dropIn: '/etc/ssh/sshd_config.d/01-quadeck.conf',
      dropInActive: true,
      users,
      logins: this.data.logins.map((l) => ({ ts: Date.now() - l.minutesAgo * 60_000, user: l.user, from: l.from, method: l.method, fingerprint: l.key !== undefined ? fps[l.key] : undefined, active: !!l.active })),
      failed: this.data.failed.map((f) => ({ from: f.from, count: f.count, last: Date.now() - f.minutesAgo * 60_000 })),
      hostname: 'nas-01',
    }
  }

  private async plan(change: SshChange) {
    const st = await this.sshState()
    if (change.kind === 'settings') return { file: '/etc/ssh/sshd_config.d/01-quadeck.conf', before: this.managed ? renderDropIn(this.managed) : '', after: renderDropIn(change.settings), ...judgeSettings(st.users, change.settings) }
    const u = this.data.users.find((x) => x.name === change.user)
    if (!u) throw new HttpError(404, tr(`Benutzer ${change.user} kann sich nicht per SSH anmelden (kein Login-Konto)`, `User ${change.user} cannot log in via SSH (no login account)`))
    const file = `${u.home}/.ssh/authorized_keys`
    const before = u.keys.length ? u.keys.join('\n') + '\n' : ''
    if (change.kind === 'add-key') {
      try {
        const after = addKey(before, change.key)
        const r = parseKeyLine(change.key) as { key: SshKey }
        return { file, before, after, warnings: r.key.weak ? [r.key.weak] : [] }
      } catch (e) {
        throw new HttpError(422, (e as Error).message)
      }
    }
    const after = removeKey(before, change.fingerprint)
    const remaining = st.users.map((x) => (x.name === u.name ? { ...x, keys: x.keys.filter((k) => k.fingerprint !== change.fingerprint) } : x))
    const blocked =
      !st.effective.passwordAuthentication && !keyLoginPossible(remaining, st.effective)
        ? tr(
            'Das ist der letzte funktionierende Schlüssel und Passwort-Login ist aus – danach käme niemand mehr per SSH auf den Server.',
            'This is the last working key and password login is off – afterwards nobody could get onto the server via SSH.',
          )
        : undefined
    return { file, before, after, warnings: [] as string[], blocked }
  }

  async previewSsh(change: SshChange) {
    return this.plan(change)
  }

  async applySsh(change: SshChange) {
    const p = await this.plan(change)
    if (p.blocked && !(change.kind !== 'add-key' && change.force)) throw new HttpError(409, p.blocked)
    if (change.kind === 'settings') this.managed = change.settings
    else {
      const u = this.data.users.find((x) => x.name === change.user)!
      u.keys = p.after.split('\n').filter(Boolean)
    }
    return this.sshState()
  }

  async sshService() {
    this.active = true
    return this.sshState()
  }
}
