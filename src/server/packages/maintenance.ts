// Package and image maintenance as seen by the web app. SystemMaintenance
// runs where root is (the helper or a single root process);
// FixtureMaintenance serves demo data for development and E2E tests.

import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import {
  PROTECTED_PACKAGES,
  type ImageUpdatesReport,
  type InstalledPackage,
  type JobInfo,
  type JobSpec,
  type JobState,
  type PackageDetail,
  type PackageOverview,
  type PackageUpdate,
  type RemovePreview,
  type UpdatesReport,
} from '~/shared/packages'
import { HttpError } from '../auth'
import { aurInfo, aurUpdates } from './aur'
import { imageUpdates } from './images'
import { defaultLauncher, JobManager, type JobSink, type Launcher } from './jobs'
import { detectProvider, type Provider } from './providers'

export interface Maintenance {
  overview(): Promise<PackageOverview>
  installed(): Promise<InstalledPackage[]>
  detail(name: string): Promise<PackageDetail | null>
  updates(refresh: boolean): Promise<UpdatesReport>
  removePreview(names: string[]): Promise<RemovePreview>
  imageUpdates(refresh: boolean): Promise<ImageUpdatesReport>
  jobs(): Promise<JobInfo[]>
  job(id: string, from: number): Promise<JobState | null>
}

/** Maintenance plus starting jobs (the caller has checked the unlock). */
export interface MaintenanceBackend extends Maintenance {
  startJob(spec: JobSpec): Promise<JobInfo>
}

const MIN_REFRESH_MS = 30_000
const UPDATES_TTL = 60 * 60_000

/** Config files the package manager left next to the live ones (.pacnew & co.). */
export function findConfigFiles(root: string, pattern: RegExp, maxDepth = 6, limit = 200): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || found.length >= limit) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.isFile() && pattern.test(e.name)) found.push(p)
    }
  }
  walk(root, 0)
  return found.sort()
}

function protectedSet(p: Provider | null) {
  return new Set(p ? PROTECTED_PACKAGES[p.id] : [])
}

function previewResult(p: Provider | null, r: { packages: { name: string; version?: string }[]; error?: string }): RemovePreview {
  const prot = protectedSet(p)
  return { ...r, blocked: r.packages.filter((x) => prot.has(x.name)).map((x) => x.name) }
}

/** One refresh at a time; concurrent callers share it. */
function single<T>(fn: () => Promise<T>) {
  let inflight: Promise<T> | undefined
  return () => (inflight ??= fn().finally(() => (inflight = undefined)))
}

export class SystemMaintenance implements MaintenanceBackend {
  private provider = detectProvider()
  private jobsMgr: JobManager
  private installedCache?: { at: number; data: InstalledPackage[] }
  private updatesCache?: UpdatesReport
  private imagesCache?: ImageUpdatesReport
  private overviewCache?: { at: number; data: PackageOverview }

  constructor(launcher: Launcher = defaultLauncher()) {
    this.jobsMgr = new JobManager(launcher)
  }

  private need() {
    if (!this.provider) throw new HttpError(501, 'Kein unterstützter Paketmanager gefunden (pacman, apt, dnf, zypper, apk, rpm-ostree)')
    return this.provider
  }

  async overview(): Promise<PackageOverview> {
    if (this.overviewCache && Date.now() - this.overviewCache.at < 30_000 && !this.jobsMgr.running()) return this.overviewCache.data
    const p = this.provider
    if (!p) return { manager: null, label: 'unbekannt', canRemove: false, rebootRequired: false, configFiles: [], protected: [] }
    const reboot = await p.rebootRequired().catch(() => undefined)
    const data: PackageOverview = {
      manager: p.id,
      label: p.label,
      canRemove: p.canRemove,
      aur: p.id === 'pacman' ? aurInfo() : undefined,
      rebootRequired: !!reboot,
      rebootReason: reboot,
      configFiles: findConfigFiles('/etc', p.configFiles),
      configHint: p.configHint,
      lastUpgrade: p.lastUpgrade(),
      protected: PROTECTED_PACKAGES[p.id],
    }
    this.overviewCache = { at: Date.now(), data }
    return data
  }

  async installed() {
    if (this.installedCache && Date.now() - this.installedCache.at < 60_000 && !this.jobsMgr.running()) return this.installedCache.data
    const data = await this.need().installed()
    this.installedCache = { at: Date.now(), data }
    return data
  }

  async detail(name: string): Promise<PackageDetail | null> {
    const p = this.need()
    const d = await p.detail(name)
    return d ? { ...d, protected: protectedSet(p).has(d.name) } : null
  }

  private refreshUpdates = single(async (): Promise<UpdatesReport> => {
    const p = this.need()
    const report: UpdatesReport = { checkedAt: Date.now(), repo: [], aur: [] }
    try {
      report.repo = await p.updates()
    } catch (e) {
      report.error = (e as Error).message
    }
    if (p.id === 'pacman') {
      try {
        report.aur = await aurUpdates()
      } catch (e) {
        report.aurError = (e as Error).message
      }
    }
    this.updatesCache = report
    return report
  })

  async updates(refresh: boolean) {
    const c = this.updatesCache
    if (c && Date.now() - c.checkedAt < (refresh ? MIN_REFRESH_MS : UPDATES_TTL)) return c
    return this.refreshUpdates()
  }

  async removePreview(names: string[]) {
    const p = this.need()
    if (!p.canRemove) throw new HttpError(400, `${p.label}: Pakete können hier nicht entfernt werden`)
    return previewResult(p, await p.removePreview(names))
  }

  private refreshImages = single(async (): Promise<ImageUpdatesReport> => {
    const report: ImageUpdatesReport = { checkedAt: Date.now(), items: [] }
    try {
      report.items = await imageUpdates()
    } catch (e) {
      report.error = (e as Error).message
    }
    this.imagesCache = report
    return report
  })

  async imageUpdates(refresh: boolean) {
    const c = this.imagesCache
    if (c && Date.now() - c.checkedAt < (refresh ? MIN_REFRESH_MS : UPDATES_TTL)) return c
    return this.refreshImages()
  }

  async startJob(spec: JobSpec) {
    if (spec.kind === 'upgrade' || spec.kind === 'remove' || spec.kind === 'aur-upgrade') this.need()
    if (spec.kind === 'remove') {
      const preview = await this.removePreview(spec.names)
      if (preview.error) throw new HttpError(409, preview.error)
      if (preview.blocked.length) throw new HttpError(403, `Geschützte Pakete wären betroffen: ${preview.blocked.join(', ')}`)
    }
    const info = await this.jobsMgr.start(spec)
    // Results are stale once the job ends (checked lazily on the next read).
    this.watchEnd(info.id, spec)
    return info
  }

  private watchEnd(id: string, spec: JobSpec) {
    const t = setInterval(() => {
      const j = this.jobsMgr.get(id, Number.MAX_SAFE_INTEGER)
      if (j && j.status === 'running') return
      clearInterval(t)
      this.installedCache = undefined
      this.overviewCache = undefined
      if (spec.kind === 'images-update' || spec.kind === 'image-update') this.imagesCache = undefined
      else this.updatesCache = undefined
    }, 1000)
  }

  async jobs() {
    return this.jobsMgr.list()
  }

  async job(id: string, from: number) {
    return this.jobsMgr.get(id, from)
  }
}

// ---------- fixtures ----------

interface PackageFixtures {
  overview: PackageOverview
  installed: (InstalledPackage & { depends?: string[]; requiredBy?: string[] })[]
  updates: { repo: PackageUpdate[]; aur: PackageUpdate[] }
  images: ImageUpdatesReport['items']
}

/** Demo data; jobs print a few lines and then change the data like the real thing would. */
export class FixtureMaintenance implements MaintenanceBackend {
  private data: PackageFixtures
  private jobsMgr: JobManager
  private checkedAt = Date.now()

  constructor(dir: string) {
    this.data = JSON.parse(readFileSync(join(dir, 'packages.json'), 'utf8')) as PackageFixtures
    const self = this
    this.jobsMgr = new JobManager({
      async start(_id, spec, sink) {
        void self.simulate(spec, sink)
      },
    })
  }

  private async simulate(spec: JobSpec, sink: JobSink) {
    const d = this.data
    const say = async (l: string) => {
      sink.line(l)
      await Bun.sleep(60)
    }
    if (spec.kind === 'upgrade') {
      await say('$ pacman -Syu --noconfirm --noprogressbar --color never')
      await say(':: Synchronizing package databases...')
      await say(':: Starting full system upgrade...')
      for (const u of d.updates.repo) await say(`upgrading ${u.name}...`)
      for (const u of d.updates.repo) {
        const pkg = d.installed.find((x) => x.name === u.name)
        if (pkg) pkg.version = u.to
      }
      if (d.updates.repo.some((u) => u.name.startsWith('linux'))) d.overview = { ...d.overview, rebootRequired: true, rebootReason: 'Kernel aktualisiert (läuft noch 6.10.1-arch1-1)' }
      d.updates.repo = []
    } else if (spec.kind === 'aur-upgrade') {
      await say(`$ runuser -u ${d.overview.aur?.user} -- ${d.overview.aur?.helper} -Sua --noconfirm`)
      for (const u of d.updates.aur) await say(`==> Making package: ${u.name} ${u.to}`)
      d.updates.aur = []
    } else if (spec.kind === 'remove') {
      await say(`$ pacman -Rs --noconfirm -- ${spec.names.join(' ')}`)
      const gone = new Set(this.previewNames(spec.names))
      for (const n of gone) await say(`removing ${n}...`)
      d.installed = d.installed.filter((x) => !gone.has(x.name))
    } else if (spec.kind === 'images-update' || spec.kind === 'image-update') {
      const targets = d.images.filter((i) => i.updated === 'pending' && (spec.kind === 'images-update' || i.unit === spec.unit))
      for (const i of targets) {
        await say(`$ podman pull ${i.image}`)
        await say(`$ systemctl restart ${i.unit}`)
        i.updated = 'false'
      }
    }
    sink.exit(0)
  }

  private previewNames(names: string[]) {
    // The requested packages plus their dependencies nothing else needs.
    const out = new Set(names)
    for (const n of names) for (const dep of this.data.installed.find((x) => x.name === n)?.depends ?? []) {
      const pkg = this.data.installed.find((x) => x.name === dep)
      if (pkg?.reason === 'dependency' && (pkg.requiredBy ?? []).every((r) => out.has(r))) out.add(dep)
    }
    return [...out]
  }

  async overview() {
    return this.data.overview
  }
  async installed() {
    return this.data.installed.map(({ depends: _d, requiredBy: _r, ...p }) => p)
  }
  async detail(name: string) {
    const p = this.data.installed.find((x) => x.name === name)
    return p ? { ...p, depends: p.depends ?? [], requiredBy: p.requiredBy ?? [], protected: this.data.overview.protected.includes(name) } : null
  }
  async updates(refresh: boolean) {
    if (refresh) this.checkedAt = Date.now()
    return { checkedAt: this.checkedAt, ...structuredClone(this.data.updates) }
  }
  async removePreview(names: string[]) {
    const missing = names.filter((n) => !this.data.installed.some((x) => x.name === n))
    if (missing.length) return { packages: [], blocked: [], error: `error: target not found: ${missing[0]}` }
    const pkgs = this.previewNames(names).map((n) => ({ name: n, version: this.data.installed.find((x) => x.name === n)?.version }))
    return { packages: pkgs, blocked: pkgs.filter((x) => this.data.overview.protected.includes(x.name)).map((x) => x.name) }
  }
  async imageUpdates() {
    return { checkedAt: this.checkedAt, items: structuredClone(this.data.images) }
  }
  async startJob(spec: JobSpec) {
    if (spec.kind === 'remove') {
      const p = await this.removePreview(spec.names)
      if (p.error) throw new HttpError(409, p.error)
      if (p.blocked.length) throw new HttpError(403, `Geschützte Pakete wären betroffen: ${p.blocked.join(', ')}`)
    }
    return this.jobsMgr.start(spec)
  }
  async jobs() {
    return this.jobsMgr.list()
  }
  async job(id: string, from: number) {
    return this.jobsMgr.get(id, from)
  }
}
