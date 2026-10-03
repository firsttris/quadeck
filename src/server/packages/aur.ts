// AUR on Arch: updates are checked against the AUR RPC (no helper needed);
// upgrades run yay/paru as a normal user, because makepkg refuses root.
// For the duration of the job that user may run pacman via sudo without a
// password (temporary drop-in in /etc/sudoers.d), so the helper does not
// stop at a password prompt.

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AurInfo, PackageUpdate } from '~/shared/packages'
import { msg } from '~/shared/i18n'
import { run } from '../exec'
import { readAuthFiles, suggestedUser } from '../privileged/crypt'
import { parseNameVersion } from './parse'

export const SUDOERS_DROPIN = '/etc/sudoers.d/zz-quadeck-aur'
const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/

export function aurHelper(): AurInfo['helper'] {
  if (Bun.which('yay')) return 'yay'
  if (Bun.which('paru')) return 'paru'
  return undefined
}

/** QUADECK_AUR_USER, else the first member of wheel/sudo/admin. */
export function aurUser(): string | undefined {
  const forced = process.env.QUADECK_AUR_USER?.trim()
  if (forced) return USER_NAME.test(forced) ? forced : undefined
  try {
    const u = suggestedUser(readAuthFiles())
    return u !== 'root' ? u : undefined
  } catch {
    return undefined
  }
}

export function aurInfo(): AurInfo {
  return { helper: aurHelper(), user: aurUser() }
}

/** Compares with vercmp (pacman's own version ordering). */
async function newer(a: string, b: string) {
  const r = await run(['vercmp', a, b])
  return Number(r.stdout.trim()) < 0
}

/** Foreign packages whose AUR version is newer than the installed one. */
export async function aurUpdates(fetcher: typeof fetch = fetch): Promise<PackageUpdate[]> {
  const foreign = parseNameVersion((await run(['pacman', '-Qm'])).stdout).filter((p) => p.version)
  if (!foreign.length) return []
  const remote = new Map<string, string>()
  for (let i = 0; i < foreign.length; i += 150) {
    const chunk = foreign.slice(i, i + 150)
    const qs = chunk.map((p) => `arg[]=${encodeURIComponent(p.name)}`).join('&')
    const res = await fetcher(`https://aur.archlinux.org/rpc/v5/info?${qs}`, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`AUR: HTTP ${res.status}`)
    const data = (await res.json()) as { results?: { Name: string; Version: string }[] }
    for (const r of data.results ?? []) remote.set(r.Name, r.Version)
  }
  const out: PackageUpdate[] = []
  for (const p of foreign) {
    const v = remote.get(p.name)
    if (v && v !== p.version && (await newer(p.version!, v))) out.push({ name: p.name, from: p.version!, to: v, repo: 'aur' })
  }
  return out
}

function passwdEntry(user: string) {
  const line = readFileSync('/etc/passwd', 'utf8')
    .split('\n')
    .find((l) => l.startsWith(user + ':'))
  if (!line) throw new Error(msg('packages_error_userMissing', { user }))
  const f = line.split(':')
  return { uid: Number(f[2]), home: f[5] || `/home/${user}` }
}

/**
 * Runs the AUR upgrade as `user`. Only the `quadeck job` process (root)
 * calls this; the sudoers drop-in is removed again in any case.
 */
export async function runAurUpgrade(helper: 'yay' | 'paru', user: string, exec: (argv: string[], env: Record<string, string>) => Promise<number>, log: (s: string) => void): Promise<number> {
  if (!USER_NAME.test(user)) throw new Error(msg('packages_error_invalidUser', { user }))
  const { uid, home } = passwdEntry(user)
  if (uid === 0) throw new Error(msg('packages_error_aurAsRoot'))
  const pacman = Bun.which('pacman') ?? '/usr/bin/pacman'
  if (!Bun.which('sudo')) throw new Error(msg('packages_error_sudoMissing', { helper }))
  writeFileSync(SUDOERS_DROPIN, `# Quadeck: only present during an AUR update\n${user} ALL=(root) NOPASSWD: ${pacman}\n`, { mode: 0o440 })
  chmodSync(SUDOERS_DROPIN, 0o440)
  try {
    if (Bun.which('visudo')) {
      const check = await run(['visudo', '-cqf', SUDOERS_DROPIN])
      if (check.code !== 0) throw new Error(msg('packages_error_sudoersCheck', { reason: check.stderr.trim() }))
    }
    log(msg('packages_note_aurUpdateAs', { helper, user }))
    const flags = helper === 'yay' ? ['--answerdiff', 'None', '--answerclean', 'None', '--answeredit', 'None', '--answerupgrade', 'None', '--removemake', '--cleanafter'] : ['--skipreview', '--removemake', '--cleanafter']
    return await exec(['runuser', '-u', user, '--', helper, '-Sua', '--noconfirm', ...flags], {
      HOME: home,
      USER: user,
      LOGNAME: user,
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin',
      LANG: 'C.UTF-8',
    })
  } finally {
    rmSync(SUDOERS_DROPIN, { force: true })
  }
}

/** A drop-in left behind by a crashed job is removed when the helper starts. */
export function cleanupSudoers() {
  if (existsSync(SUDOERS_DROPIN)) rmSync(SUDOERS_DROPIN, { force: true })
}
