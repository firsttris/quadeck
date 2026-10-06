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
  type CacheEntry,
  type PackageCacheReport,
  type PackageDetail,
  type PackageOverview,
  type PackageUpdate,
  type RemovePreview,
  type UpdatesReport,
} from '~/shared/packages'
import { localize, msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { HttpError } from '../auth'
import { aurInfo, aurUpdates } from './aur'
import { fileRootPaths, type FixtureFiles } from '../files/backend'
import { prepareFsJob, systemFsOps } from '../files/transfer'
import { assertExtractable, preparePack, systemArchiveHost } from '../files/archives'
import { imageUpdates } from './images'
import { defaultLauncher, JobManager, type JobSink, type Launcher } from './jobs'
import { detectProvider, type Provider } from './providers'
import { dirUsage, systemCachePlans } from './cache'
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
  /** Package cache and AUR build cache with their size. */
  packageCache(refresh: boolean): Promise<PackageCacheReport>
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
  private cacheReport?: PackageCacheReport
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
    this.cacheReport = undefined
    if (spec.kind === 'images-update' || spec.kind === 'image-update') {
      this.imagesCache = undefined
      this.gen.images++
    } else {
      this.updatesCache = undefined
      this.gen.updates++
    }
  }

  private need() {
    if (!this.provider) throw new HttpError(501, msg(m.packages_error_noManager))
    return this.provider
  }

  async overview(): Promise<PackageOverview> {
    if (this.overviewCache && Date.now() - this.overviewCache.at < 30_000 && !this.jobsMgr.running()) return this.overviewCache.data
    const p = this.provider
    if (!p) return { manager: null, label: msg(m.podman_all_unknownVersion), canRemove: false, rebootRequired: false, configFiles: [], protected: [] }
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
    if (!p.canRemove) throw new HttpError(400, msg(m.packages_error_cannotRemove, { label: p.label }))
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

  async packageCache(refresh: boolean) {
    const c = this.cacheReport
    if (c && !this.jobsMgr.running() && Date.now() - c.checkedAt < (refresh ? 5_000 : 10 * 60_000)) return c
    const report: PackageCacheReport = { checkedAt: Date.now(), entries: systemCachePlans(this.provider?.id ?? null).map(({ steps: _s, ...e }) => ({ ...e, ...dirUsage(e.path) })) }
    this.cacheReport = report
    return report
  }

  async startJob(spec: JobSpec) {
    if (spec.kind === 'cache-clean') {
      this.need()
      const ids = new Set(systemCachePlans(this.provider?.id ?? null).map((p) => p.id))
      if (!spec.targets.every((t) => ids.has(t))) throw new HttpError(409, msg(m.packages_cache_nothing))
    }
    if (spec.kind === 'upgrade' || spec.kind === 'remove' || spec.kind === 'aur-upgrade' || spec.kind === 'pacman-unlock' || spec.kind === 'keyring-upgrade') this.need()
    if (spec.kind === 'remove') {
      const preview = await this.removePreview(spec.names)
      if (preview.error) throw new HttpError(409, preview.error)
      if (preview.blocked.length) throw new HttpError(403, msg(m.packages_error_protectedAffected, { list: preview.blocked.join(', ') }))
    }
    // Copy/move/delete: refuse now (conflicts, outside the roots) instead of in a failing job.
    if (spec.kind === 'fs-copy' || spec.kind === 'fs-move' || spec.kind === 'fs-delete') prepareFsJob(spec, systemFsOps(fileRootPaths()))
    if (spec.kind === 'fs-extract') await assertExtractable(spec, systemArchiveHost(fileRootPaths()))
    if (spec.kind === 'fs-pack') {
      preparePack(spec, systemArchiveHost(fileRootPaths()))
      if (spec.format === 'zip' && !Bun.which('zip')) throw new HttpError(409, msg(m.files_archive_needsZip))
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
  private aurFailedOnce = false
  private checkedAt = Date.now()
  private conf: FixtureConfigFs
  /** Demo caches: 4.2 GB of packages, 2.9 GB of AUR builds. */
  private cache: CacheEntry[] = [
    { id: 'packages', path: '/var/cache/pacman/pkg', size: 4_512_000_000, files: 1873, keep: 'two' },
    { id: 'aur', path: '/home/tristan/.cache/yay', size: 3_114_000_000, files: 48_210, keep: 'files', owner: 'tristan', helper: 'yay' },
  ]

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
      if (d.updates.repo.some((u) => u.name.startsWith('linux'))) d.overview = { ...d.overview, rebootRequired: true, rebootReason: msg(m.packages_reboot_kernelUpdatedExample) }
      d.updates.repo = []
    } else if (spec.kind === 'aur-upgrade') {
      await say(`$ runuser -u ${d.overview.aur?.user} -- ${d.overview.aur?.helper} -Sua --noconfirm`)
      if (!this.aurFailedOnce && d.updates.aur.length) {
        // the first AUR update of the demo fails like a broken PKGBUILD, to show the hint
        this.aurFailedOnce = true
        const u = d.updates.aur[0]!
        await say(`==> Making package: ${u.name} ${u.to} (Mon 06 Oct 2025 07:33:12 CEST)`)
        await say('==> Retrieving sources...')
        await say(`==> Starting package()...`)
        await say(`install: cannot stat 'code.png': No such file or directory`)
        await say('==> ERROR: A failure occurred in package().')
        await say('    Aborting...')
        await say(` -> error making: ${u.name}-exit status 4`)
        await say(' -> Failed to install the following packages. Manual intervention is required:')
        await say(`${u.name} - exit status 4`)
        return sink.exit(1)
      }
      for (const u of d.updates.aur) await say(`==> Making package: ${u.name} ${u.to}`)
      d.updates.aur = []
    } else if (spec.kind === 'pacman-unlock') {
      await say('Removed the lock /var/lib/pacman/db.lck (no package manager is running)')
    } else if (spec.kind === 'keyring-upgrade') {
      await say('$ pacman -Sy --needed --noconfirm --noprogressbar --color never archlinux-keyring')
      await say('upgrading archlinux-keyring...')
      await say('$ pacman -Su --noconfirm --noprogressbar --color never')
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
        await say(msg(m.packages_job_error, { message: (e as Error).message }))
        return sink.exit(1)
      }
    } else if (spec.kind === 'fs-extract' || spec.kind === 'fs-pack') {
      await say(spec.kind === 'fs-extract' ? `$ tar -x -v -f ${spec.archive} -C ${spec.toDir} --no-same-owner --no-same-permissions` : `$ ${spec.format === 'zip' ? 'zip -r -y' : 'tar -c -v -z -f'} ${spec.name} …`)
      try {
        for (const l of spec.kind === 'fs-extract' ? await this.files!.extract(spec) : await this.files!.pack(spec)) await say(l)
      } catch (e) {
        await say(msg(m.packages_job_error, { message: (e as Error).message }))
        return sink.exit(1)
      }
    } else if (spec.kind === 'cache-clean') {
      for (const c of this.cache.filter((x) => spec.targets.includes(x.id))) {
        if (c.id === 'packages') {
          await say(`$ paccache -r -k2 -c ${c.path}`)
          await say('==> finished: 1214 packages removed (disk space saved: 2.91 GiB)')
          await say(`$ paccache -r -u -k0 -c ${c.path}`)
          await say('==> finished: 37 packages removed (disk space saved: 412.08 MiB)')
          c.size = 1_020_000_000
          c.files = 622
        } else {
          await say(`$ setpriv --reuid=1000 --regid=1000 --clear-groups -- find ${c.path} -mindepth 1 -maxdepth 1 -type d -exec rm -rf --one-file-system -- {} +`)
          c.size = 41_000
          c.files = 1
        }
        await say(`${c.path}: done`)
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
    } else if (spec.kind === 'backup-restore') {
      await say(`$ restic restore ${spec.snapshot} --target ${spec.target ?? '/'} ${spec.paths.map((p) => `--include ${p}`).join(' ')}`)
      for (const u of spec.target ? [] : spec.stop) await say(`systemctl stop ${u}`)
      await say(`restoring <Snapshot ${spec.snapshot.slice(0, 8)}> to ${spec.target ?? '/'}`)
      await say('Summary: Restored 1206 files/dirs (6.214 GiB) in 0:41')
      for (const u of spec.target ? [] : spec.stop) await say(`systemctl start ${u}`)
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

  async packageCache() {
    return { checkedAt: this.checkedAt, entries: structuredClone(this.cache) }
  }

  async overview() {
    // The demo is pacman: its hint in the viewer's language instead of the German one from the fixture.
    const o = this.data.overview
    return o.configHint ? { ...o, configHint: msg(m.packages_configHint_pacdiff) } : o
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
      if (p.blocked.length) throw new HttpError(403, msg(m.packages_error_protectedAffected, { list: p.blocked.join(', ') }))
    }
    if ((spec.kind === 'fs-copy' || spec.kind === 'fs-move' || spec.kind === 'fs-delete') && this.files) prepareFsJob(spec, this.files.ops())
    if (spec.kind === 'fs-extract' && this.files) await assertExtractable(spec, this.files.archiveHost())
    if (spec.kind === 'fs-pack' && this.files) preparePack(spec, this.files.archiveHost())
    return this.jobsMgr.start(spec)
  }
  async jobs() {
    return this.jobsMgr.list()
  }
  async job(id: string, from: number) {
    return this.jobsMgr.get(id, from)
  }
}
