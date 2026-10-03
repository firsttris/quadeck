// Accounts on the host via the shadow tools (useradd, usermod, chpasswd,
// userdel) and smbpasswd. Passwords only ever go through stdin. Every change
// passes changeProblem() first, which also refuses to lock out the last
// administrator who could still unlock Quadeck.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpError } from '../auth'
import { run } from '../exec'
import { parseAuthorizedKeys } from '../ssh/keys'
import { msg } from '~/shared/i18n'
import { changeProblem, isHuman, knownGroups, parseGroup, parseLast, parsePasswd, parseShadow, passwordState, type Account, type GroupInfo, type LoginRecord, type UserChange, type UsersState } from '~/shared/users'

export interface UsersAdmin {
  usersState(): Promise<UsersState>
}

/** Writes; the caller has checked the unlock. */
export interface UsersBackend extends UsersAdmin {
  applyUser(change: UserChange): Promise<UsersState>
}

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

export function parseShells(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('/')),
    ),
  ]
}

/** The state from the account files – shared by the real machine and the demo. */
export function buildUsersState(files: { passwd: string; group: string; shadow: string; shells: string }, extra: { keys: (name: string, home: string) => number; samba?: Set<string>; history: LoginRecord[] }): UsersState {
  const groups = parseGroup(files.group)
  const shadow = parseShadow(files.shadow)
  const passwd = parsePasswd(files.passwd)
  const adminGroup = groups.some((g) => g.name === 'wheel') ? 'wheel' : 'sudo'
  const humans = passwd.filter(isHuman)
  const accounts: Account[] = humans.map((p) => {
    const sh = shadow.get(p.name)
    const st = passwordState(sh?.password, sh?.expire)
    const member = groups.filter((g) => g.members.includes(p.name) && g.gid !== p.gid).map((g) => g.name)
    const last = extra.history.filter((h) => h.user === p.name).reduce((m, h) => Math.max(m, h.start), 0)
    return {
      name: p.name,
      uid: p.uid,
      fullName: p.gecos.split(',')[0] ?? '',
      home: p.home,
      shell: p.shell,
      groups: member,
      admin: p.uid === 0 || member.includes(adminGroup),
      ...st,
      keys: extra.keys(p.name, p.home),
      samba: extra.samba ? extra.samba.has(p.name) : undefined,
      lastLogin: last || undefined,
      protected: p.uid === 0 ? msg('users_note_rootProtected') : undefined,
    }
  })
  // Personal groups (same name and gid as a user) are not offered.
  const personal = new Set(passwd.map((p) => `${p.name}:${p.gid}`))
  const used = new Set(accounts.flatMap((a) => a.groups))
  const known = knownGroups()
  const offered: GroupInfo[] = groups
    .filter((g) => !personal.has(`${g.name}:${g.gid}`) && (g.name in known || used.has(g.name) || (g.gid >= 1000 && g.gid < 60000)))
    .map((g) => ({ name: g.name, gid: g.gid, text: known[g.name] }))
    .sort((a, b) => Number(b.name === adminGroup) - Number(a.name === adminGroup) || a.name.localeCompare(b.name))
  return { accounts, groups: offered, shells: parseShells(files.shells), adminGroup, sambaAvailable: !!extra.samba, history: extra.history.slice(0, 50) }
}

/** userdel/usermod messages in plain words. */
export function shadowError(tool: string, out: string): string {
  if (/currently used by process|is currently logged in/i.test(out)) return msg('users_error_inUse')
  if (/already exists/i.test(out)) return msg('users_error_nameExists')
  return `${tool}: ${out.trim() || msg('notifications_failed')}`
}

export class SystemUsers implements UsersBackend {
  constructor(private etc = '/etc') {}

  private files() {
    return {
      passwd: read(join(this.etc, 'passwd')) ?? '',
      group: read(join(this.etc, 'group')) ?? '',
      shadow: read(join(this.etc, 'shadow')) ?? '',
      shells: read(join(this.etc, 'shells')) ?? '/bin/sh\n/bin/bash\n',
    }
  }

  private async samba(): Promise<Set<string> | undefined> {
    if (!Bun.which('pdbedit') || !Bun.which('smbpasswd')) return undefined
    const r = await run(['pdbedit', '-L'], { timeoutMs: 10_000 })
    return new Set(
      r.stdout
        .split('\n')
        .map((l) => l.split(':')[0]!)
        .filter(Boolean),
    )
  }

  private async history(): Promise<LoginRecord[]> {
    if (!Bun.which('last')) return []
    const r = await run(['last', '--time-format', 'iso', '-w', '-n', '200'], { timeoutMs: 10_000 })
    return parseLast(r.stdout)
  }

  async usersState() {
    const [samba, history] = await Promise.all([this.samba(), this.history()])
    return buildUsersState(this.files(), { keys: (_n, home) => parseAuthorizedKeys(read(join(home, '.ssh', 'authorized_keys')) ?? '').length, samba, history })
  }

  private async tool(argv: string[], input?: string) {
    const r = await run(argv, { timeoutMs: 60_000, input })
    if (r.code !== 0) throw new HttpError(422, shadowError(argv[0]!, r.stderr || r.stdout))
  }

  async applyUser(c: UserChange) {
    const state = await this.usersState()
    const problem = changeProblem(state, c)
    if (problem) throw new HttpError(409, problem)
    const withAdmin = (groups: string[], admin: boolean) => [...new Set([...groups.filter((g) => g !== state.adminGroup), ...(admin ? [state.adminGroup] : [])])]
    switch (c.kind) {
      case 'create': {
        const groups = withAdmin(c.groups, c.admin)
        await this.tool(['useradd', '-m', '-c', c.fullName, '-s', c.shell, ...(groups.length ? ['-G', groups.join(',')] : []), '--', c.name])
        try {
          // Without a password: "*" = no password, but not locked – SSH keys keep working.
          if (c.password) await this.tool(['chpasswd'], `${c.name}:${c.password}\n`)
          else await this.tool(['usermod', '-p', '*', '--', c.name])
        } catch (e) {
          await run(['userdel', '-r', '--', c.name], { timeoutMs: 60_000 })
          throw e
        }
        break
      }
      case 'update': {
        const acc = state.accounts.find((a) => a.name === c.name)!
        const groups = acc.uid === 0 ? c.groups : withAdmin(c.groups, c.admin)
        await this.tool(['usermod', '-c', c.fullName, '-s', c.shell, '-G', groups.join(','), '--', c.name])
        break
      }
      case 'password':
        await this.tool(['chpasswd'], `${c.name}:${c.password}\n`)
        break
      case 'lock':
        await this.tool(['usermod', '-L', '-e', '1', '--', c.name])
        break
      case 'unlock': {
        const r = await run(['usermod', '-U', '-e', '', '--', c.name], { timeoutMs: 60_000 })
        // "-U" refuses when only "!" is left (no password ever set): then only lift the expiry.
        if (r.code !== 0) await this.tool(['usermod', '-e', '', '--', c.name])
        break
      }
      case 'samba-password':
        if (!Bun.which('smbpasswd')) throw new HttpError(409, msg('users_error_sambaMissing'))
        await this.tool(['smbpasswd', '-a', '-s', c.name], `${c.password}\n${c.password}\n`)
        break
      case 'delete': {
        await this.tool(['userdel', ...(c.removeHome ? ['-r'] : []), '--', c.name])
        if (Bun.which('smbpasswd')) await run(['smbpasswd', '-x', c.name], { timeoutMs: 30_000 })
        break
      }
    }
    return this.usersState()
  }
}

// ---------- demo fixtures ----------

interface UsersFixture {
  passwd: string
  group: string
  shadow: string
  shells: string
  keys: Record<string, number>
  samba: string[]
  history: { user: string; tty: string; from?: string; startMinutesAgo: number; durationMinutes?: number }[]
}

export class FixtureUsers implements UsersBackend {
  private f: UsersFixture

  constructor(dir: string) {
    this.f = JSON.parse(read(join(dir, 'users.json')) ?? '{}') as UsersFixture
  }

  async usersState() {
    const now = Date.now()
    const history = this.f.history.map((h) => ({
      user: h.user,
      tty: h.tty,
      from: h.from,
      start: now - h.startMinutesAgo * 60_000,
      end: h.durationMinutes ? now - (h.startMinutesAgo - h.durationMinutes) * 60_000 : undefined,
      active: !h.durationMinutes,
    }))
    return buildUsersState(this.f, { keys: (n) => this.f.keys[n] ?? 0, samba: new Set(this.f.samba), history })
  }

  private edit(file: 'passwd' | 'group' | 'shadow', fn: (fields: string[][]) => string[][]) {
    this.f[file] =
      fn(
        this.f[file]
          .trim()
          .split('\n')
          .map((l) => l.split(':')),
      )
        .map((x) => x.join(':'))
        .join('\n') + '\n'
  }

  async applyUser(c: UserChange) {
    const state = await this.usersState()
    const problem = changeProblem(state, c)
    if (problem) throw new HttpError(409, problem)
    const setGroups = (name: string, groups: string[]) =>
      this.edit('group', (rows) =>
        rows.map((g) => {
          const members = (g[3] ?? '').split(',').filter((m) => m && m !== name)
          if (groups.includes(g[0]!)) members.push(name)
          return [g[0]!, g[1]!, g[2]!, members.join(',')]
        }),
      )
    const admin = (groups: string[], on: boolean) => [...new Set([...groups.filter((g) => g !== state.adminGroup), ...(on ? [state.adminGroup] : [])])]
    switch (c.kind) {
      case 'create': {
        const uid =
          Math.max(
            999,
            ...parsePasswd(this.f.passwd)
              .filter((p) => p.uid < 60000)
              .map((p) => p.uid),
          ) + 1
        this.f.passwd += `${c.name}:x:${uid}:${uid}:${c.fullName}:/home/${c.name}:${c.shell}\n`
        this.f.group += `${c.name}:x:${uid}:\n`
        this.f.shadow += `${c.name}:${c.password ? '$6$demo$hash' : '*'}:20000:0:99999:7:::\n`
        setGroups(c.name, admin(c.groups, c.admin))
        break
      }
      case 'update':
        this.edit('passwd', (rows) => rows.map((p) => (p[0] === c.name ? [p[0]!, p[1]!, p[2]!, p[3]!, c.fullName, p[5]!, c.shell] : p)))
        setGroups(c.name, c.name === 'root' ? c.groups : admin(c.groups, c.admin))
        break
      case 'password':
        this.edit('shadow', (rows) => rows.map((s) => (s[0] === c.name ? [s[0]!, '$6$demo$new', ...s.slice(2)] : s)))
        break
      case 'lock':
        this.edit('shadow', (rows) => rows.map((s) => (s[0] === c.name ? [s[0]!, s[1]!.startsWith('!') ? s[1]! : `!${s[1]}`, ...s.slice(2, 7), '1', s[8] ?? ''] : s)))
        break
      case 'unlock':
        this.edit('shadow', (rows) => rows.map((s) => (s[0] === c.name ? [s[0]!, s[1]!.replace(/^!+/, '') || '*', ...s.slice(2, 7), '', s[8] ?? ''] : s)))
        break
      case 'samba-password':
        if (!this.f.samba.includes(c.name)) this.f.samba.push(c.name)
        break
      case 'delete':
        this.edit('passwd', (rows) => rows.filter((p) => p[0] !== c.name))
        this.edit('shadow', (rows) => rows.filter((p) => p[0] !== c.name))
        setGroups(c.name, [])
        this.f.samba = this.f.samba.filter((s) => s !== c.name)
        break
    }
    return this.usersState()
  }
}
