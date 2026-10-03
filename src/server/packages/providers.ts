// Package managers behind one interface. Reads run wherever Maintenance runs
// (root helper or single root process); changes are described as fixed argv
// steps that only the `quadeck job` runner executes.

import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import type { InstalledPackage, ManagerId, PackageDetail, PackageUpdate } from '~/shared/packages'
import { tr } from '~/shared/i18n'
import { run, runOk } from '../exec'
import * as p from './parse'

export interface Step {
  argv: string[]
  env?: Record<string, string>
}

export type Detail = Omit<PackageDetail, 'protected'>

export interface Provider {
  id: ManagerId
  label: string
  canRemove: boolean
  installed(): Promise<InstalledPackage[]>
  detail(name: string): Promise<Detail | null>
  /** Refreshes the metadata (without touching the installed system) and lists updates. */
  updates(): Promise<PackageUpdate[]>
  removePreview(names: string[]): Promise<{ packages: { name: string; version?: string }[]; error?: string }>
  upgradeSteps(): Step[]
  removeSteps(names: string[]): Step[]
  installSteps(names: string[]): Step[]
  /** Reason when a reboot is needed (undefined = no). */
  rebootRequired(): Promise<string | undefined>
  configFiles: RegExp
  configHint: string
  lastUpgrade(): number | undefined
}

const SLOW = { timeoutMs: 300_000 }

const tail = (file: string, bytes = 2 * 1024 * 1024) => {
  try {
    const f = readFileSync(file)
    return f.subarray(Math.max(0, f.length - bytes)).toString('utf8')
  } catch {
    return ''
  }
}

/** Kernel modules of the running kernel are gone → the kernel was updated. */
function kernelReplaced(): string | undefined {
  const r = release()
  const dirs = [`/usr/lib/modules/${r}`, `/lib/modules/${r}`]
  return existsSync('/usr/lib/modules') || existsSync('/lib/modules') ? (dirs.some(existsSync) ? undefined : tr(`Kernel aktualisiert (läuft noch ${r})`, `Kernel updated (still running ${r})`)) : undefined
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

// ---------- pacman (Arch, Manjaro, EndeavourOS) ----------

const CACHE_DIR = () => process.env.CACHE_DIRECTORY?.split(':')[0] || '/var/cache/quadeck'

export class Pacman implements Provider {
  id = 'pacman' as const
  label = 'pacman'
  canRemove = true
  configFiles = /\.(pacnew|pacsave)$/
  get configHint() {
    return tr('Mit „pacdiff“ (pacman-contrib) vergleichen und zusammenführen.', 'Compare and merge with “pacdiff” (pacman-contrib).')
  }

  private async records() {
    const [info, foreign] = await Promise.all([runOk(['pacman', '-Qi'], { timeoutMs: 60_000 }), run(['pacman', '-Qmq'])])
    const f = new Set(lines(foreign.stdout))
    return p.parsePacmanInfo(info).map((r) => p.pacmanRecordToPackage(r, f))
  }

  async installed() {
    return (await this.records()).map(({ depends: _d, requiredBy: _r, optionalFor: _o, url: _u, installedAt: _i, ...pkg }) => pkg)
  }

  async detail(name: string) {
    const r = await run(['pacman', '-Qi', '--', name])
    if (r.code !== 0) return null
    const foreign = await run(['pacman', '-Qmq', '--', name])
    const rec = p.parsePacmanInfo(r.stdout)[0]
    return rec ? p.pacmanRecordToPackage(rec, new Set(foreign.code === 0 ? [name] : [])) : null
  }

  /**
   * Like checkupdates: sync a copy of the databases (local db linked), so
   * the system never sees a partial "pacman -Sy".
   */
  async updates() {
    const dbpath = join(CACHE_DIR(), 'pacman-db')
    mkdirSync(join(dbpath, 'sync'), { recursive: true, mode: 0o755 })
    const local = join(dbpath, 'local')
    const sysLocal = '/var/lib/pacman/local'
    let linked = false
    try {
      linked = readlinkSync(local) === sysLocal
    } catch {
      // missing
    }
    if (!linked) {
      if (existsSync(local)) unlinkSync(local)
      symlinkSync(sysLocal, local)
    }
    await runOk(['pacman', '-Sy', '--dbpath', dbpath, '--logfile', '/dev/null', '--noprogressbar', '--color', 'never'], SLOW)
    const qu = await run(['pacman', '-Qu', '--dbpath', dbpath, '--color', 'never'])
    const ups = p.parsePacmanQu(qu.stdout)
    const print = await run(['pacman', '-Sup', '--dbpath', dbpath, '--print-format', '%r %n %v %s', '--color', 'never'])
    const repos = p.parsePacmanPrint(print.stdout)
    return ups.map((u) => ({ ...u, repo: repos.get(u.name)?.repo, downloadSize: repos.get(u.name)?.size }))
  }

  async removePreview(names: string[]) {
    const r = await run(['pacman', '-Rsp', '--print-format', '%n %v', '--color', 'never', '--', ...names])
    if (r.code !== 0) return { packages: [], error: (r.stderr || r.stdout).trim() }
    return { packages: p.parseNameVersion(r.stdout) }
  }

  upgradeSteps(): Step[] {
    return [{ argv: ['pacman', '-Syu', '--noconfirm', '--noprogressbar', '--color', 'never'] }]
  }

  removeSteps(names: string[]): Step[] {
    return [{ argv: ['pacman', '-Rs', '--noconfirm', '--noprogressbar', '--color', 'never', '--', ...names] }]
  }
  installSteps(names: string[]): Step[] {
    return [{ argv: ['pacman', '-S', '--needed', '--noconfirm', '--noprogressbar', '--color', 'never', '--', ...names] }]
  }

  async rebootRequired() {
    return kernelReplaced()
  }

  lastUpgrade() {
    return p.lastPacmanUpgrade(tail('/var/log/pacman.log'))
  }
}

// ---------- apt (Debian, Ubuntu, Raspberry Pi OS) ----------

const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'a', APT_LISTCHANGES_FRONTEND: 'none' }
const APT_KEEP_CONF = ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold']

export class Apt implements Provider {
  id = 'apt' as const
  label = 'apt'
  canRemove = true
  configFiles = /\.(dpkg-dist|dpkg-new|dpkg-old|ucf-dist)$/
  get configHint() {
    return tr('Neue Paketversionen der Dateien liegen daneben; vergleichen und übernehmen (z. B. mit diff).', 'The new package versions of the files lie next to them; compare and take over (e.g. with diff).')
  }

  async installed() {
    const [list, auto, orphans, local] = await Promise.all([
      runOk(['dpkg-query', '-W', '-f=${Package}\t${Version}\t${Installed-Size}\t${db:Status-Abbrev}\t${binary:Summary}\n'], { timeoutMs: 60_000 }),
      run(['apt-mark', 'showauto']),
      run(['apt-get', '-s', '-o', 'Debug::NoLocking=1', 'autoremove']),
      run(['apt', 'list', '--installed']),
    ])
    const autoSet = new Set(lines(auto.stdout))
    const orphanSet = new Set(p.parseAptSim(orphans.stdout).remv.map((r) => r.name))
    const localSet = p.parseAptLocal(local.stdout)
    return p.parseDpkgList(list).map((pkg) => ({
      ...pkg,
      reason: auto.code !== 0 ? undefined : autoSet.has(pkg.name) ? ('dependency' as const) : ('explicit' as const),
      orphan: orphanSet.has(pkg.name),
      foreign: localSet.has(pkg.name),
    }))
  }

  async detail(name: string) {
    const r = await run(['dpkg-query', '-s', '--', name])
    if (r.code !== 0) return null
    const c = p.parseControl(r.stdout)
    const rdeps = await run(['apt-cache', 'rdepends', '--installed', '--', name])
    const auto = await run(['apt-mark', 'showauto', '--', name])
    return {
      name: c.Package ?? name,
      version: c.Version ?? '',
      description: c.Description?.split('\n')[0],
      size: c['Installed-Size'] ? Number(c['Installed-Size']) * 1024 : undefined,
      reason: auto.stdout.trim() === name ? ('dependency' as const) : ('explicit' as const),
      url: c.Homepage,
      depends: p.parseDebDepends([c['Pre-Depends'], c.Depends].filter(Boolean).join(', ')),
      requiredBy: p.parseRdepends(rdeps.stdout).filter((n) => n !== name),
    }
  }

  async updates() {
    await runOk(['apt-get', 'update', '-q'], SLOW)
    const sim = await runOk(['apt-get', '-s', '-q', '-o', 'Debug::NoLocking=1', 'upgrade', '--with-new-pkgs'], SLOW)
    return p.parseAptSim(sim).inst
  }

  async removePreview(names: string[]) {
    const r = await run(['apt-get', '-s', '-o', 'Debug::NoLocking=1', 'remove', '--autoremove', '--', ...names])
    if (r.code !== 0) return { packages: [], error: (r.stderr || r.stdout).trim() }
    return { packages: p.parseAptSim(r.stdout).remv }
  }

  upgradeSteps(): Step[] {
    return [
      { argv: ['apt-get', 'update', '-q'], env: APT_ENV },
      { argv: ['apt-get', '-y', '-q', ...APT_KEEP_CONF, 'upgrade', '--with-new-pkgs'], env: APT_ENV },
    ]
  }

  removeSteps(names: string[]): Step[] {
    return [{ argv: ['apt-get', '-y', '-q', 'remove', '--autoremove', '--', ...names], env: APT_ENV }]
  }
  installSteps(names: string[]): Step[] {
    return [
      { argv: ['apt-get', 'update', '-q'], env: APT_ENV },
      { argv: ['apt-get', 'install', '-y', '-q', ...APT_KEEP_CONF, '--', ...names], env: APT_ENV },
    ]
  }

  async rebootRequired() {
    if (existsSync('/run/reboot-required')) {
      let pkgs = ''
      try {
        pkgs = lines(readFileSync('/run/reboot-required.pkgs', 'utf8')).join(', ')
      } catch {
        // optional
      }
      return pkgs ? tr(`Neustart nötig wegen ${pkgs}`, `Reboot needed because of ${pkgs}`) : tr('Neustart nötig (/run/reboot-required)', 'Reboot needed (/run/reboot-required)')
    }
    return kernelReplaced()
  }

  lastUpgrade() {
    const log = tail('/var/log/apt/history.log')
    const blocks = log.split(/\n\s*\n/).filter((b) => /^Upgrade:/m.test(b))
    const m = blocks.pop()?.match(/Start-Date: (\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/)
    const t = m ? Date.parse(`${m[1]}T${m[2]}`) : NaN
    return Number.isFinite(t) ? t : undefined
  }
}

// ---------- rpm-based (shared by dnf, zypper, rpm-ostree) ----------

async function rpmInstalled() {
  return p.parseRpmList(await runOk(['rpm', '-qa', '--qf', '%{NAME}\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\t%{SIZE}\t%{SUMMARY}\n'], { timeoutMs: 60_000 }))
}

async function rpmDetail(name: string): Promise<Detail | null> {
  const r = await run(['rpm', '-qi', '--', name])
  if (r.code !== 0) return null
  const i = p.parseRpmInfo(r.stdout)
  const [req, whatreq] = await Promise.all([run(['rpm', '-qR', '--', name]), run(['rpm', '-q', '--whatrequires', name, '--qf', '%{NAME}\n'])])
  const date = i['Install Date'] ? Date.parse(i['Install Date']) : NaN
  return {
    name: i.Name ?? name,
    version: [i.Version, i.Release].filter(Boolean).join('-'),
    description: i.Summary,
    size: i.Size ? Number(i.Size) : undefined,
    url: i.URL,
    installedAt: Number.isFinite(date) ? date : undefined,
    depends: p.parseRpmRequires(req.stdout),
    requiredBy: whatreq.code === 0 ? [...new Set(lines(whatreq.stdout))].filter((n) => n !== name && !n.startsWith('no package')) : [],
  }
}

const rpmVersions = async () => new Map((await rpmInstalled()).map((x) => [x.name, x.version]))

// ---------- dnf (Fedora, RHEL, Rocky, Alma) ----------

export class Dnf implements Provider {
  id = 'dnf' as const
  label: string
  canRemove = true
  configFiles = /\.(rpmnew|rpmsave)$/
  get configHint() {
    return tr('Neue Paketversionen liegen als .rpmnew daneben; vergleichen und übernehmen (z. B. rpmconf -a).', 'New package versions lie next to them as .rpmnew; compare and take over (e.g. rpmconf -a).')
  }
  private bin: string
  private dnf5: boolean

  constructor(bin: string) {
    this.bin = bin
    this.dnf5 =
      bin.endsWith('dnf5') ||
      (() => {
        try {
          return readlinkSync(bin).includes('dnf5')
        } catch {
          return false
        }
      })()
    this.label = this.dnf5 ? 'dnf5' : 'dnf'
  }

  private qf() {
    return this.dnf5 ? '%{name}\n' : '%{name}'
  }

  async installed() {
    const [pkgs, user, unneeded, extras] = await Promise.all([
      rpmInstalled(),
      run([this.bin, '-q', '-C', 'repoquery', '--userinstalled', '--qf', this.qf()], { timeoutMs: 60_000 }),
      run([this.bin, '-q', '-C', 'repoquery', '--unneeded', '--qf', this.qf()], { timeoutMs: 60_000 }),
      run([this.bin, '-q', '-C', 'list', '--extras'], { timeoutMs: 60_000 }),
    ])
    const userSet = new Set(lines(user.stdout))
    const orphanSet = new Set(lines(unneeded.stdout))
    const extraSet = new Set(lines(extras.stdout).map((l) => l.split(/\s+/)[0]!.replace(/\.[^.]+$/, '')))
    return pkgs.map((pkg) => ({
      ...pkg,
      reason: user.code !== 0 ? undefined : userSet.has(pkg.name) ? ('explicit' as const) : ('dependency' as const),
      orphan: orphanSet.has(pkg.name),
      foreign: extraSet.has(pkg.name),
    }))
  }

  detail(name: string) {
    return rpmDetail(name)
  }

  async updates() {
    const r = await run([this.bin, '-q', '--refresh', 'check-update'], SLOW)
    if (r.code !== 0 && r.code !== 100) throw new Error(`${this.label} check-update: ${(r.stderr || r.stdout).trim()}`)
    const current = await rpmVersions()
    return p.parseDnfCheckUpdate(r.stdout).map((u) => ({ name: u.name, from: current.get(u.name) ?? '', to: u.to, repo: u.repo }))
  }

  async removePreview(names: string[]) {
    const r = await run([this.bin, 'remove', '--assumeno', '--', ...names], { timeoutMs: 60_000 })
    const packages = p.parseDnfTransaction(r.stdout)
    return packages.length ? { packages } : { packages, error: (r.stderr || r.stdout).trim() }
  }

  upgradeSteps(): Step[] {
    return [{ argv: [this.bin, '-y', 'upgrade'] }]
  }

  removeSteps(names: string[]): Step[] {
    return [{ argv: [this.bin, '-y', 'remove', '--', ...names] }]
  }
  installSteps(names: string[]): Step[] {
    return [{ argv: [this.bin, '-y', 'install', '--', ...names] }]
  }

  async rebootRequired() {
    const r = this.dnf5 ? await run([this.bin, 'needs-restarting', '-r']) : Bun.which('needs-restarting') ? await run(['needs-restarting', '-r']) : undefined
    if (r?.code === 1) return tr('Neustart nötig (needs-restarting)', 'Reboot needed (needs-restarting)')
    return kernelReplaced()
  }

  lastUpgrade() {
    return undefined
  }
}

// ---------- zypper (openSUSE, SLES) ----------

export class Zypper implements Provider {
  id = 'zypper' as const
  label = 'zypper'
  canRemove = true
  configFiles = /\.(rpmnew|rpmsave)$/
  get configHint() {
    return tr('Neue Paketversionen liegen als .rpmnew daneben; vergleichen und übernehmen.', 'New package versions lie next to them as .rpmnew; compare and take over.')
  }
  private tumbleweed = (() => {
    try {
      return /tumbleweed|microos|slowroll/i.test(readFileSync('/etc/os-release', 'utf8'))
    } catch {
      return false
    }
  })()

  async installed() {
    const [pkgs, orphaned, unneeded] = await Promise.all([rpmInstalled(), run(['zypper', '-n', '-q', 'packages', '--orphaned']), run(['zypper', '-n', '-q', 'packages', '--unneeded'])])
    const name = (r: string[]) => r[2] ?? ''
    const foreign = new Set(p.parseZypperTable(orphaned.stdout).map(name))
    const orphans = new Set(p.parseZypperTable(unneeded.stdout).map(name))
    return pkgs.map((pkg) => ({ ...pkg, foreign: foreign.has(pkg.name), orphan: orphans.has(pkg.name) }))
  }

  detail(name: string) {
    return rpmDetail(name)
  }

  async updates() {
    await runOk(['zypper', '-n', '-q', 'refresh'], SLOW)
    const r = await runOk(['zypper', '-n', '-q', 'list-updates'], SLOW)
    // S | Repository | Name | Current Version | Available Version | Arch
    return p
      .parseZypperTable(r)
      .filter((c) => c.length >= 6)
      .map((c) => ({ name: c[2]!, from: c[3]!, to: c[4]!, repo: c[1] }))
  }

  async removePreview(names: string[]) {
    const r = await run(['zypper', '-n', 'rm', '-u', '-D', '--', ...names], { timeoutMs: 60_000 })
    const versions = await rpmVersions()
    const packages = p.parseZypperRemove(r.stdout).map((n) => ({ name: n, version: versions.get(n) }))
    return packages.length ? { packages } : { packages, error: (r.stderr || r.stdout).trim() }
  }

  upgradeSteps(): Step[] {
    return [{ argv: this.tumbleweed ? ['zypper', '-n', 'dup', '--auto-agree-with-licenses'] : ['zypper', '-n', 'up', '--auto-agree-with-licenses'] }]
  }

  removeSteps(names: string[]): Step[] {
    return [{ argv: ['zypper', '-n', 'rm', '-u', '--', ...names] }]
  }
  installSteps(names: string[]): Step[] {
    return [{ argv: ['zypper', '-n', 'install', '--', ...names] }]
  }

  async rebootRequired() {
    const r = await run(['zypper', 'needs-rebooting'])
    if (r.code === 102) return tr('Neustart nötig (zypper needs-rebooting)', 'Reboot needed (zypper needs-rebooting)')
    return kernelReplaced()
  }

  lastUpgrade() {
    return undefined
  }
}

// ---------- apk (Alpine) ----------

export class Apk implements Provider {
  id = 'apk' as const
  label = 'apk'
  canRemove = true
  configFiles = /\.apk-new$/
  get configHint() {
    return tr('Neue Versionen liegen als .apk-new daneben; vergleichen und übernehmen.', 'New versions lie next to them as .apk-new; compare and take over.')
  }

  async installed() {
    const out = await runOk(['apk', 'list', '-I'], { timeoutMs: 60_000 })
    let world = new Set<string>()
    try {
      world = new Set(lines(readFileSync('/etc/apk/world', 'utf8')).map((l) => l.split(/[<>=~]/)[0]!))
    } catch {
      // unknown
    }
    return p.parseApkList(out).map(({ name, version }) => ({ name, version, reason: world.size ? (world.has(name) ? ('explicit' as const) : ('dependency' as const)) : undefined }))
  }

  async detail(name: string) {
    const r = await run(['apk', 'info', '-d', '-w', '-s', '-R', '-r', '--', name])
    if (r.code !== 0 || !r.stdout.trim()) return null
    const i = p.parseApkInfo(r.stdout)
    const head = r.stdout.split('\n')[0]!.split(' ')[0]!
    return {
      name,
      version: p.splitApkPkg(head)?.version ?? '',
      description: i.description?.[0],
      url: i.webpage?.[0],
      size: p.parseSize(i['installed size']?.[0]),
      depends: (i['depends on'] ?? []).map((d) => d.split(/[<>=~]/)[0]!),
      requiredBy: (i['is required by'] ?? []).map((d) => p.splitApkPkg(d)?.name ?? d),
    }
  }

  async updates() {
    await runOk(['apk', 'update', '-q'], SLOW)
    const out = await runOk(['apk', 'list', '-u'])
    return p.parseApkList(out).map((u) => ({ name: u.name, from: u.from ?? '', to: u.version }))
  }

  async removePreview(names: string[]) {
    const r = await run(['apk', 'del', '-s', '--', ...names])
    if (r.code !== 0) return { packages: [], error: (r.stderr || r.stdout).trim() }
    return { packages: p.parseApkPurge(r.stdout) }
  }

  upgradeSteps(): Step[] {
    return [{ argv: ['apk', 'update'] }, { argv: ['apk', 'upgrade', '--no-progress'] }]
  }

  removeSteps(names: string[]): Step[] {
    return [{ argv: ['apk', 'del', '--no-progress', '--', ...names] }]
  }
  installSteps(names: string[]): Step[] {
    return [{ argv: ['apk', 'add', '--no-progress', '--', ...names] }]
  }

  async rebootRequired() {
    return kernelReplaced()
  }

  lastUpgrade() {
    return undefined
  }
}

// ---------- rpm-ostree (Fedora CoreOS, Silverblue, uCore) ----------

export class RpmOstree implements Provider {
  id = 'rpm-ostree' as const
  label = 'rpm-ostree'
  canRemove = false
  configFiles = /\.(rpmnew|rpmsave)$/
  get configHint() {
    return tr('/etc wird bei ostree beim Upgrade zusammengeführt; .rpmnew-Dateien manuell prüfen.', 'On ostree, /etc is merged during the upgrade; check .rpmnew files by hand.')
  }

  private async status() {
    const r = await run(['rpm-ostree', 'status', '--json'])
    return r.code === 0 ? (JSON.parse(r.stdout) as { deployments: { booted: boolean; staged?: boolean; 'requested-packages'?: string[] }[] }) : undefined
  }

  async installed() {
    const [pkgs, st] = await Promise.all([rpmInstalled(), this.status()])
    const layered = new Set(st?.deployments.find((d) => d.booted)?.['requested-packages'] ?? [])
    return pkgs.map((pkg) => ({ ...pkg, reason: layered.has(pkg.name) ? ('explicit' as const) : undefined, foreign: layered.has(pkg.name) }))
  }

  detail(name: string) {
    return rpmDetail(name)
  }

  async updates() {
    const r = await run(['rpm-ostree', 'upgrade', '--preview'], SLOW)
    if (r.code !== 0 && r.code !== 77) throw new Error(`rpm-ostree: ${(r.stderr || r.stdout).trim()}`)
    return p.parseOstreeDiff(r.stdout)
  }

  async removePreview() {
    return {
      packages: [],
      error: tr(
        'Auf rpm-ostree-Systemen werden Pakete nicht einzeln entfernt (rpm-ostree uninstall nur für überlagerte Pakete).',
        'On rpm-ostree systems packages are not removed one by one (rpm-ostree uninstall only for layered packages).',
      ),
    }
  }

  upgradeSteps(): Step[] {
    return [{ argv: ['rpm-ostree', 'upgrade'] }]
  }

  removeSteps(): Step[] {
    throw new Error(tr('Entfernen wird auf rpm-ostree nicht unterstützt', 'Removing is not supported on rpm-ostree'))
  }
  installSteps(names: string[]): Step[] {
    // Layered package; active after the next reboot.
    return [{ argv: ['rpm-ostree', 'install', '--idempotent', '--allow-inactive', '--', ...names] }]
  }

  async rebootRequired() {
    const st = await this.status()
    return st?.deployments.some((d) => !d.booted && d.staged) ? tr('Neues Deployment bereit – Neustart aktiviert es', 'New deployment ready – a reboot activates it') : undefined
  }

  lastUpgrade() {
    return undefined
  }
}

/** QUADECK_PACKAGE_MANAGER or auto-detected from installed tools. */
export function detectProvider(): Provider | null {
  const force = process.env.QUADECK_PACKAGE_MANAGER?.trim()
  const has = (b: string) => !!Bun.which(b)
  const pick = (id: string) => {
    if (id === 'rpm-ostree') return new RpmOstree()
    if (id === 'pacman') return new Pacman()
    if (id === 'apt') return new Apt()
    if (id === 'dnf') return new Dnf(Bun.which('dnf5') ?? Bun.which('dnf') ?? 'dnf')
    if (id === 'zypper') return new Zypper()
    if (id === 'apk') return new Apk()
    return null
  }
  if (force) return pick(force)
  if (existsSync('/run/ostree-booted') && has('rpm-ostree')) return new RpmOstree()
  if (has('pacman')) return new Pacman()
  if (has('apt-get') && has('dpkg-query')) return new Apt()
  if (has('dnf5') || has('dnf')) return pick('dnf')
  if (has('zypper')) return new Zypper()
  if (has('apk')) return new Apk()
  return null
}
