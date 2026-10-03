// Package and image maintenance as seen by the web app. SystemMaintenance
// runs where root is (the helper or a single root process);
// FixtureMaintenance serves demo data for development and E2E tests.

import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import {
  FEATURES,
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
import { localize, msg } from '~/shared/i18n'
import { HttpError } from '../auth'
import { aurInfo, aurUpdates } from './aur'
import { fileRootPaths, type FixtureFiles } from '../files/backend'
import { prepareFsJob, systemFsOps } from '../files/transfer'
import { imageUpdates } from './images'
import { defaultLauncher, JobManager, type JobSink, type Launcher } from './jobs'
import { detectProvider, type Provider } from './providers'
import { FixtureConfigFs, SystemConfigFs, applyConfigAction, configFileInfo } from './configfiles'
import type { ConfigAction, ConfigFileInfo } from '~/shared/configfiles'

export interface Maintenance {
  overview(): Promise<PackageOverview>
  installed(): Promise<InstalledPackage[]>
  detail(name: string): Promise<PackageDetail | null>
  updates(refresh: boolean): Promise<UpdatesReport>
  removePreview(names: string[]): Promise<RemovePreview>
  imageUpdates(refresh: boolean): Promise<ImageUpdatesReport>
  jobs(): Promise<JobInfo[]>
  job(id: string, from: number): Promise<JobState | null>
  /** A .pacnew/.rpmnew/… file of the current list with the live file next to it. */
  configFile(path: string): Promise<ConfigFileInfo>
}

/** Maintenance plus starting jobs (the caller has checked the unlock). */
export interface MaintenanceBackend extends Maintenance {
  startJob(spec: JobSpec): Promise<JobInfo>
  applyConfigFile(path: string, action: ConfigAction, content?: string): Promise<{ done: string; after?: ConfigFileInfo['after']; warning?: string }>
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
  /** Bumped when a job ends: a check that started before must not store its (old) result. */
  private gen = { updates: 0, images: 0 }

  private conf = new SystemConfigFs(() => (this.provider ? findConfigFiles('/etc', this.provider.configFiles) : []))

  constructor(launcher: Launcher = defaultLauncher()) {
    this.jobsMgr = new JobManager(launcher, (job) => this.jobEnded(job.spec))
  }

  configFile(path: string) {
    return configFileInfo(this.conf, path)
  }

  async applyConfigFile(path: string, action: ConfigAction, content?: string) {
    const r = await applyConfigAction(this.conf, path, action, content)
    this.overviewCache = undefined
    return r
  }

  /**
   * The lists are stale once a job ends. Dropped right away: the page reloads
   * the moment it sees the job finish, and must not get the list from before.
   */
  private jobEnded(spec: JobSpec) {
    this.installedCache = undefined
    this.overviewCache = undefined
    if (spec.kind === 'images-update' || spec.kind === 'image-update') {
      this.imagesCache = undefined
      this.gen.images++
    } else {
      this.updatesCache = undefined
      this.gen.updates++
    }
  }

  private need() {
    if (!this.provider) throw new HttpError(501, msg('packages_error_noManager'))
    return this.provider
  }

  async overview(): Promise<PackageOverview> {
    if (this.overviewCache && Date.now() - this.overviewCache.at < 30_000 && !this.jobsMgr.running()) return this.overviewCache.data
    const p = this.provider
    if (!p) return { manager: null, label: msg('podman_all_unknownVersion'), canRemove: false, rebootRequired: false, configFiles: [], protected: [] }
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
    const gen = this.gen.updates
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
    if (gen === this.gen.updates) this.updatesCache = report
    return report
  })

  async updates(refresh: boolean) {
    const c = this.updatesCache
    if (c && Date.now() - c.checkedAt < (refresh ? MIN_REFRESH_MS : UPDATES_TTL)) return c
    return this.refreshUpdates()
  }

  async removePreview(names: string[]) {
    const p = this.need()
    if (!p.canRemove) throw new HttpError(400, msg('packages_error_cannotRemove', { label: p.label }))
    return previewResult(p, await p.removePreview(names))
  }

  private refreshImages = single(async (): Promise<ImageUpdatesReport> => {
    const gen = this.gen.images
    const report: ImageUpdatesReport = { checkedAt: Date.now(), items: [] }
    try {
      report.items = await imageUpdates()
    } catch (e) {
      report.error = (e as Error).message
    }
    if (gen === this.gen.images) this.imagesCache = report
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
      if (preview.blocked.length) throw new HttpError(403, msg('packages_error_protectedAffected', { list: preview.blocked.join(', ') }))
    }
    // Copy/move/delete: refuse now (conflicts, outside the roots) instead of in a failing job.
    if (spec.kind === 'fs-copy' || spec.kind === 'fs-move' || spec.kind === 'fs-delete') prepareFsJob(spec, systemFsOps(fileRootPaths()))
    return this.jobsMgr.start(spec)
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
  /** Contents of the config files (.pacnew and live) for the demo. */
  configContents?: Record<string, string>
}

/** Demo data; jobs print a few lines and then change the data like the real thing would. */
export class FixtureMaintenance implements MaintenanceBackend {
  private data: PackageFixtures
  private jobsMgr: JobManager
  private checkedAt = Date.now()
  private conf: FixtureConfigFs

  constructor(
    dir: string,
    private files?: FixtureFiles,
  ) {
    this.data = JSON.parse(readFileSync(join(dir, 'packages.json'), 'utf8')) as PackageFixtures
    this.conf = new FixtureConfigFs(this.data.configContents ?? {}, this.data.overview)
    const self = this
    this.jobsMgr = new JobManager({
      async start(_id, spec, sink) {
        void self.simulate(spec, sink)
      },
    })
  }

  configFile(path: string) {
    return configFileInfo(this.conf, path)
  }

  applyConfigFile(path: string, action: ConfigAction, content?: string) {
    return applyConfigAction(this.conf, path, action, content)
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
      if (d.updates.repo.some((u) => u.name.startsWith('linux'))) d.overview = { ...d.overview, rebootRequired: true, rebootReason: msg('packages_reboot_kernelUpdatedExample') }
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
    } else if (spec.kind === 'fs-copy' || spec.kind === 'fs-move' || spec.kind === 'fs-delete') {
      const cmd = spec.kind === 'fs-copy' ? 'cp -a -v --reflink=auto' : spec.kind === 'fs-move' ? 'mv -v' : 'rm -r -f -v --one-file-system'
      await say(`$ ${cmd} -- ${spec.paths.join(' ')}${spec.kind === 'fs-delete' ? '' : ` ${spec.toDir}`}`)
      try {
        for (const l of this.files!.apply(spec.kind === 'fs-copy' ? 'copy' : spec.kind === 'fs-move' ? 'move' : 'delete', spec.paths, spec.kind === 'fs-delete' ? undefined : spec.toDir)) await say(l)
      } catch (e) {
        await say(msg('packages_job_error', { message: (e as Error).message }))
        return sink.exit(1)
      }
    } else if (spec.kind === 'mkinitcpio') {
      await say('$ mkinitcpio -P')
      await say("==> Building image from preset: /etc/mkinitcpio.d/linux.preset: 'default'")
      await say('==> Image generation successful')
    } else if (spec.kind === 'kernel-install') {
      await say(`$ pacman -S --needed --noconfirm --noprogressbar --color never -- ${spec.flavor}`)
      await say(`installing ${spec.flavor}...`)
      await say(`==> Building image from preset: /etc/mkinitcpio.d/${spec.flavor}.preset: 'default'`)
      await say(`==> Image generation successful`)
      d.installed = [...d.installed.filter((p) => p.name !== spec.flavor), { ...d.installed.find((p) => p.name === 'linux')!, name: spec.flavor, version: spec.flavor === 'linux-lts' ? '6.12.48-1' : '6.10.1.arch1-1', reason: 'explicit' }]
    } else if (spec.kind === 'kernel-remove') {
      await say(`$ pacman -Rns --noconfirm --noprogressbar --color never -- ${spec.flavor}`)
      await say(`removing ${spec.flavor}...`)
      d.installed = d.installed.filter((p) => p.name !== spec.flavor)
    } else if (spec.kind === 'install') {
      const pkgs = FEATURES[spec.feature].packages.pacman
      await say(`$ pacman -S --needed --noconfirm -- ${pkgs.join(' ')}`)
      for (const n of pkgs) await say(`installing ${n}...`)
    }
    sink.exit(0)
  }

  private previewNames(names: string[]) {
    // The requested packages plus their dependencies nothing else needs.
    const out = new Set(names)
    for (const n of names)
      for (const dep of this.data.installed.find((x) => x.name === n)?.depends ?? []) {
        const pkg = this.data.installed.find((x) => x.name === dep)
        if (pkg?.reason === 'dependency' && (pkg.requiredBy ?? []).every((r) => out.has(r))) out.add(dep)
      }
    return [...out]
  }

  async overview() {
    // The demo is pacman: its hint in the viewer's language instead of the German one from the fixture.
    const o = this.data.overview
    return o.configHint ? { ...o, configHint: msg('packages_configHint_pacdiff') } : o
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
      if (p.blocked.length) throw new HttpError(403, msg('packages_error_protectedAffected', { list: p.blocked.join(', ') }))
    }
    if ((spec.kind === 'fs-copy' || spec.kind === 'fs-move' || spec.kind === 'fs-delete') && this.files) prepareFsJob(spec, this.files.ops())
    return this.jobsMgr.start(spec)
  }
  async jobs() {
    return this.jobsMgr.list()
  }
  async job(id: string, from: number) {
    return this.jobsMgr.get(id, from)
  }
}
