import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { existsSync } from 'node:fs'
import type { JobSpec } from '~/shared/packages'
import type { MaintenanceBackend } from '../packages/maintenance'
import type { PodmanAdminBackend, RemoveAlso } from '../quadlets/backend'
import type { PodmanConfigName } from '~/shared/quadlets'
import type { SharesBackend } from '../shares/backend'
import type { SshBackend } from '../ssh/backend'
import type { SelfTestType, SmartBackend } from '../smart/backend'
import type { FilesBackend } from '../files/backend'
import { fileResponse } from '../files/serve'
import type { TimersBackend } from '../timers/backend'
import type { UnitEditorBackend } from '../systemd/editor'
import type { NetworkAdmin } from '../network/collect'
import type { FstabBackend } from '../fstab/backend'
import type { BootBackend } from '../boot/backend'
import type { BootEntryChange } from '~/shared/boot'
import type { UsersBackend } from '../users/backend'
import type { HardwareAdmin } from '../hardware/collect'
import type { CaddyBackend } from '../caddy/backend'
import type { BackupBackend } from '../backup/backend'
import type { PowerBackend } from '../smart/power'
import type { PowerSetting } from '~/shared/power'
import { TARGET_QUADLET, type BackupPlan, type TargetConfig } from '~/shared/backup'
import type { ClientPlan } from '~/shared/backup-client'
import type { CaddyChange } from '~/shared/caddy'
import type { UserChange } from '~/shared/users'
import type { ConfigAction } from '~/shared/configfiles'
import type { FstabChange } from '~/shared/fstab'
import type { TimerAction, TimerSpec } from '~/shared/timers'
import type { SshChange } from '~/shared/ssh'
import type { ShareChange, ShareServiceAction } from '~/shared/shares'
import { HttpError } from '../auth'
import { runOk } from '../exec'
import { config } from '../config'
import { TerminalManager, ptySpawner } from '../terminal/sessions'
import { demoSpawner } from '../terminal/demo'
import { CONTAINER_NAME, type TerminalInfo } from '~/shared/terminal'
import { hostname, userInfo } from 'node:os'
import { cleanStorage, fixtureApi, readStorage, type PodmanApi, type QuadletRefs } from '../quadlets/storage'
import { createSecret, removeSecret, secretsState } from '../quadlets/secrets'
import { moveToSecret, plainValue, type SecretsState } from '~/shared/secrets'
import type { WriteResult } from '../quadlets/backend'
import { PRUNE_CALENDAR, PRUNE_COMMAND, PRUNE_TIMER, quadletKey, type CleanupKind, type PodmanStorage, type PruneEvery } from '~/shared/podman-storage'
import { assertContainerId, assertPodmanRead, assertUnitName, type Privileged, type UnitAction } from './actions'
import { Gate } from './gate'

const METHOD: Record<UnitAction, string> = { start: 'StartUnit', stop: 'StopUnit', restart: 'RestartUnit' }
const manager = ['org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager']

/**
 * Root actions in this process (Quadeck runs as root, or this *is* the
 * helper). systemd over D-Bus via busctl (argv only, no shell); Podman over
 * its socket.
 */
export class LocalPrivileged implements Privileged {
  readonly kind = 'local' as const

  constructor(
    readonly gate: Gate,
    private podmanSocket: string,
    private maint: MaintenanceBackend,
    private admin: PodmanAdminBackend,
    private shares: SharesBackend,
    private ssh: SshBackend,
    private smart: SmartBackend,
    private files: FilesBackend,
    private timers: TimersBackend,
    private editor: UnitEditorBackend,
    private network: NetworkAdmin,
    private fstab: FstabBackend,
    private boot: BootBackend,
    private users: UsersBackend,
    private hw: HardwareAdmin,
    private caddy: CaddyBackend,
    private backup: BackupBackend,
    private power: PowerBackend,
  ) {}

  /** Shells and `podman exec` in pseudo terminals; the demo gets a pretend shell, never a real one. */
  private terminalManager?: TerminalManager
  private get terminal() {
    if (!this.terminalManager) {
      const t = new TerminalManager(undefined, config().fixturesDir ? demoSpawner : ptySpawner)
      this.gate.onLock((token) => t.closeOwner(token))
      this.terminalManager = t
    }
    return this.terminalManager
  }

  async info() {
    return this.gate.info()
  }
  async unlock(user: string, password: string) {
    return this.gate.unlock(user, password)
  }
  async lock(token: string | undefined) {
    this.gate.lock(token)
  }
  async unlockedUntil(token: string | undefined) {
    return this.gate.unlockedUntil(token)
  }
  async check(token: string | undefined) {
    this.gate.check(token)
  }

  async unit(token: string | undefined, action: UnitAction, name: string) {
    this.gate.check(token)
    try {
      assertUnitName(name)
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
    await runOk(['busctl', 'call', ...manager, METHOD[action], 'ss', name, 'replace'], { timeoutMs: 30_000 })
  }

  async daemonReload(token: string | undefined) {
    this.gate.check(token)
    await runOk(['busctl', 'call', ...manager, 'Reload'], { timeoutMs: 60_000 })
  }

  private podman(path: string, init: RequestInit = {}, timeoutMs = 15_000) {
    if (!existsSync(this.podmanSocket)) throw new HttpError(503, msg(m.helper_error_podmanSocketMissing, { socket: this.podmanSocket }))
    return fetch(`http://podman${path}`, { ...init, unix: this.podmanSocket, signal: AbortSignal.timeout(timeoutMs) } as RequestInit)
  }

  // ---------- Podman storage ----------

  /** The demo answers from fixtures; system/df walks every volume, so it gets time. */
  private storageApi(): PodmanApi {
    const dir = config().fixturesDir
    return dir ? fixtureApi(dir) : async (path, init) => this.podman(path, init, 180_000)
  }

  /** Image=, volume and network names from the Quadlet files (they own what they create). */
  private async quadletRefs(): Promise<QuadletRefs> {
    const refs: QuadletRefs = { images: [], volumes: [], networks: [] }
    const files = await this.admin.quadlets().catch(() => [])
    const read = (name: string) => this.admin.readQuadlet(name).catch(() => '')
    for (const f of files) {
      const stem = f.name.replace(/\.[a-z]+$/, '')
      if (f.type === 'container' || f.type === 'image') {
        let image = quadletKey(await read(f.name), 'Image')
        if (f.type === 'container' && image?.endsWith('.image')) image = quadletKey(await read(image), 'Image')
        if (image) refs.images.push({ file: f.name, image })
      } else if (f.type === 'volume') refs.volumes.push({ file: f.name, name: quadletKey(await read(f.name), 'VolumeName') ?? `systemd-${stem}` })
      else if (f.type === 'network') refs.networks.push({ file: f.name, name: quadletKey(await read(f.name), 'NetworkName') ?? `systemd-${stem}` })
    }
    return refs
  }

  async podmanStorage(): Promise<PodmanStorage> {
    const demo = !!config().fixturesDir
    const s = await readStorage(this.storageApi(), await this.quadletRefs(), demo ? () => ({ size: 512e9, used: 401e9 }) : undefined)
    const t = (await this.timers.timersState().catch(() => undefined))?.timers.find((x) => x.name === `${PRUNE_TIMER}.timer`)
    if (t) s.prune = { every: t.calendars.some((c) => c.includes('-01')) || t.managed?.calendar.includes('-01') ? 'monthly' : 'weekly', ...(t.last ? { last: t.last } : {}), ...(t.next ? { next: t.next } : {}) }
    return s
  }

  // ---------- terminal ----------

  /** A shell as the account that unlocked (root only via sudo), or a shell inside a running container. */
  async terminalOpen(token: string | undefined, target: { kind: 'shell' } | { kind: 'container'; name: string }, cols: number, rows: number, idleMinutes: number): Promise<TerminalInfo> {
    this.gate.check(token)
    const isRoot = process.getuid?.() === 0
    const demo = !!config().fixturesDir
    const user = demo || isRoot ? (this.gate.userOf(token) ?? 'root') : userInfo().username
    const idleMs = Math.min(240, Math.max(1, idleMinutes)) * 60_000
    const env = { PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: process.env.LANG ?? 'C.UTF-8' }
    if (target.kind === 'container') {
      if (!CONTAINER_NAME.test(target.name)) throw new HttpError(400, msg(m.terminal_error_container))
      // --detach-keys= : Ctrl-P Ctrl-Q stays with the program inside
      const argv = ['podman', 'exec', '-it', '--detach-keys=', target.name, 'sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi']
      return this.terminal.open({ argv, env, cols, rows, owner: token ?? 'none', label: target.name, kind: 'container', user: 'root', idleMs })
    }
    // runuser -l: the user's own login shell and environment, as after an SSH login
    const argv = !isRoot ? [process.env.SHELL || 'bash', '-l'] : user === 'root' ? ['su', '-l', 'root'] : ['runuser', '-l', user]
    return this.terminal.open({ argv, env: { ...env, ...(isRoot ? {} : { HOME: process.env.HOME ?? '/' }) }, cols, rows, owner: token ?? 'none', label: `${user}@${hostname()}`, kind: 'shell', user, idleMs })
  }
  terminalStream(id: string) {
    return this.terminal.stream(id)
  }
  async terminalInput(id: string, data: string) {
    this.terminal.input(id, data)
  }
  async terminalResize(id: string, cols: number, rows: number) {
    this.terminal.resize(id, cols, rows)
  }
  async terminalClose(id: string) {
    this.terminal.close(id)
  }

  // ---------- Podman secrets ----------

  private async quadletTexts() {
    const files = await this.admin.quadlets().catch(() => [])
    return Promise.all(files.map(async (f) => ({ name: f.name, content: await this.admin.readQuadlet(f.name).catch(() => '') })))
  }

  async secretsState(): Promise<SecretsState> {
    return secretsState(this.storageApi(), await this.quadletTexts())
  }

  async createSecret(token: string | undefined, name: string, value: string, replace: boolean) {
    this.gate.check(token)
    await createSecret(this.storageApi(), name, value, replace)
    return this.secretsState()
  }

  /** Only secrets no Quadlet file names: a container would not start without it. */
  async removeSecret(token: string | undefined, name: string) {
    this.gate.check(token)
    const used = (await this.secretsState()).secrets.find((s) => s.name === name)?.usedBy ?? []
    if (used.length) throw new HttpError(409, msg(m.secrets_error_inUse, { files: used.join(', ') }))
    await removeSecret(this.storageApi(), name)
    return this.secretsState()
  }

  /** KEY=value from a .container file into a new secret, the line rewritten to Secret=…; undone if the file cannot be saved. */
  async moveSecret(token: string | undefined, file: string, key: string, name: string, restart: boolean): Promise<{ state: SecretsState; write: WriteResult }> {
    this.gate.check(token)
    if (!file.endsWith('.container')) throw new HttpError(400, msg(m.secrets_error_notContainer))
    const content = await this.admin.readQuadlet(file)
    const value = plainValue(content, key)
    if (value === undefined) throw new HttpError(404, msg(m.secrets_error_noKey, { key, file }))
    const api = this.storageApi()
    await createSecret(api, name, value)
    let write: WriteResult
    try {
      write = await this.admin.writeQuadlet(file, moveToSecret(content, key, name), restart)
    } catch (e) {
      await removeSecret(api, name).catch(() => {})
      throw e
    }
    return { state: await this.secretsState(), write }
  }

  async cleanPodman(token: string | undefined, items: { kind: CleanupKind; id: string }[]) {
    this.gate.check(token)
    return cleanStorage(this.storageApi(), await this.quadletRefs(), items)
  }

  /** The weekly/monthly cleanup timer (safe part only), or none. */
  async setPodmanPrune(token: string | undefined, every: PruneEvery | null) {
    this.gate.check(token)
    const exists = (await this.timers.timersState()).timers.some((x) => x.name === `${PRUNE_TIMER}.timer`)
    if (!every) {
      if (exists) await this.timers.deleteTimer(`${PRUNE_TIMER}.timer`)
    } else
      await this.timers.saveTimer(
        { name: PRUNE_TIMER, description: 'Quadeck: remove stopped containers and old image versions', command: PRUNE_COMMAND, user: '', workingDirectory: '', calendar: PRUNE_CALENDAR[every], persistent: true, randomDelay: 30, lowPriority: true, network: false },
        exists ? PRUNE_TIMER : undefined,
        true,
      )
    return this.podmanStorage()
  }

  async podmanGet<T>(path: string): Promise<T> {
    try {
      assertPodmanRead(path)
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
    const res = await this.podman(path)
    if (!res.ok) throw new Error(`Podman-API ${path}: HTTP ${res.status}`)
    return (await res.json()) as T
  }

  async podmanContainer(token: string | undefined, id: string, action: UnitAction) {
    this.gate.check(token)
    try {
      assertContainerId(id)
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
    const res = await this.podman(`/containers/${id}/${action}`, { method: 'POST' })
    if (!res.ok && res.status !== 304) throw new Error(msg(m.helper_error_podmanFailed, { action, status: res.status, body: await res.text() }))
  }

  // ---------- packages & images ----------

  overview() {
    return this.maint.overview()
  }
  packageCache(refresh: boolean) {
    return this.maint.packageCache(refresh)
  }
  installed() {
    return this.maint.installed()
  }
  detail(name: string) {
    return this.maint.detail(name)
  }
  updates(refresh: boolean) {
    return this.maint.updates(refresh)
  }
  removePreview(names: string[]) {
    return this.maint.removePreview(names)
  }
  imageUpdates(refresh: boolean) {
    return this.maint.imageUpdates(refresh)
  }
  jobs() {
    return this.maint.jobs()
  }
  job(id: string, from: number) {
    return this.maint.job(id, from)
  }
  configFile(path: string) {
    return this.maint.configFile(path)
  }
  async applyConfigFile(token: string | undefined, path: string, action: ConfigAction, content?: string) {
    this.gate.check(token)
    return this.maint.applyConfigFile(path, action, content)
  }
  async startJob(token: string | undefined, spec: JobSpec) {
    this.gate.check(token)
    return this.maint.startJob(spec)
  }

  // ---------- Quadlets & Podman settings ----------

  quadlets() {
    return this.admin.quadlets()
  }
  readQuadlet(name: string) {
    return this.admin.readQuadlet(name)
  }
  removalPlan(name: string) {
    return this.admin.removalPlan(name)
  }
  validateQuadlet(name: string, content: string) {
    return this.admin.validateQuadlet(name, content)
  }
  quadletHistory(name: string) {
    return this.admin.quadletHistory(name)
  }
  quadletRevision(name: string, id: string) {
    return this.admin.quadletRevision(name, id)
  }
  podmanSettings() {
    return this.admin.podmanSettings()
  }
  async writeQuadlet(token: string | undefined, name: string, content: string, restart: boolean, expected?: string) {
    this.gate.check(token)
    return this.admin.writeQuadlet(name, content, restart, expected)
  }
  async deleteQuadlet(token: string | undefined, name: string, also?: RemoveAlso) {
    this.gate.check(token)
    return this.admin.deleteQuadlet(name, also)
  }
  async setAutoUpdateTimer(token: string | undefined, enabled: boolean, calendar: string) {
    this.gate.check(token)
    return this.admin.setAutoUpdateTimer(enabled, calendar)
  }
  async setAutoUpdateDefault(token: string | undefined, enabled: boolean) {
    this.gate.check(token)
    return this.admin.setAutoUpdateDefault(enabled)
  }
  async writePodmanConfig(token: string | undefined, name: PodmanConfigName, content: string) {
    this.gate.check(token)
    return this.admin.writePodmanConfig(name, content)
  }

  // ---------- shares ----------

  sharesState() {
    return this.shares.sharesState()
  }
  previewShare(change: ShareChange) {
    return this.shares.previewShare(change)
  }
  async applyShare(token: string | undefined, change: ShareChange) {
    this.gate.check(token)
    return this.shares.applyShare(change)
  }
  async shareService(token: string | undefined, kind: 'smb' | 'nfs', action: ShareServiceAction) {
    this.gate.check(token)
    return this.shares.shareService(kind, action)
  }

  // ---------- SSH ----------

  sshState() {
    return this.ssh.sshState()
  }
  previewSsh(change: SshChange) {
    return this.ssh.previewSsh(change)
  }
  async applySsh(token: string | undefined, change: SshChange) {
    this.gate.check(token)
    return this.ssh.applySsh(change)
  }
  async sshService(token: string | undefined, action: 'start' | 'restart' | 'enable') {
    this.gate.check(token)
    return this.ssh.sshService(action)
  }

  // ---------- SMART ----------

  smartReport(refresh: boolean) {
    return this.smart.smartReport(refresh)
  }
  async smartSelfTest(token: string | undefined, disk: string, type: SelfTestType) {
    this.gate.check(token)
    return this.smart.smartSelfTest(disk, type)
  }

  // ---------- files ----------

  fileRoots() {
    return this.files.fileRoots()
  }
  listDir(path: string) {
    return this.files.listDir(path)
  }
  async makeDir(token: string | undefined, path: string) {
    this.gate.check(token)
    return this.files.makeDir(path)
  }
  archivePreview(token: string | undefined, archive: string, toDir: string) {
    return this.files.archivePreview(archive, toDir, this.gate.unlockedUntil(token) !== null)
  }
  archiveTools() {
    return this.files.archiveTools()
  }
  readTextFile(token: string | undefined, path: string) {
    return this.files.readTextFile(path, this.gate.unlockedUntil(token) !== null)
  }
  async fileResponse(token: string | undefined, path: string, opts: { range?: string | null; download?: boolean }) {
    return fileResponse(await this.files.openFile(path, this.gate.unlockedUntil(token) !== null), opts)
  }
  async writeTextFile(token: string | undefined, path: string, content: string, expected: string) {
    this.gate.check(token)
    return this.files.writeTextFile(path, content, expected)
  }
  async renamePath(token: string | undefined, path: string, newName: string) {
    this.gate.check(token)
    return this.files.renamePath(path, newName)
  }

  // ---------- timers ----------

  timersState() {
    return this.timers.timersState()
  }
  previewCalendar(expr: string) {
    return this.timers.previewCalendar(expr)
  }
  timerFiles(name: string) {
    return this.timers.timerFiles(name)
  }
  async saveTimer(token: string | undefined, spec: TimerSpec, previous: string | undefined, enable: boolean) {
    this.gate.check(token)
    return this.timers.saveTimer(spec, previous, enable)
  }
  async deleteTimer(token: string | undefined, name: string) {
    this.gate.check(token)
    return this.timers.deleteTimer(name)
  }
  async setTimerSchedule(token: string | undefined, name: string, calendar: string) {
    this.gate.check(token)
    return this.timers.setTimerSchedule(name, calendar)
  }
  async timerAction(token: string | undefined, name: string, action: TimerAction) {
    this.gate.check(token)
    return this.timers.timerAction(name, action)
  }

  // ---------- unit editor ----------

  networkState() {
    return this.network.networkState()
  }
  scanDevices(active: boolean) {
    return this.network.scanDevices(active)
  }

  unitDetail(unit: string) {
    return this.editor.unitDetail(unit)
  }
  validateUnitFile(unit: string, path: string, content: string) {
    return this.editor.validateUnitFile(unit, path, content)
  }
  unitFileHistory(unit: string, path: string) {
    return this.editor.unitFileHistory(unit, path)
  }
  unitFileRevision(unit: string, path: string, id: string) {
    return this.editor.unitFileRevision(unit, path, id)
  }
  async writeUnitFile(token: string | undefined, unit: string, path: string, content: string, restart: boolean, expected?: string) {
    this.gate.check(token)
    return this.editor.writeUnitFile(unit, path, content, restart, expected)
  }
  async deleteUnitFile(token: string | undefined, unit: string, path: string) {
    this.gate.check(token)
    return this.editor.deleteUnitFile(unit, path)
  }
  async createUnit(token: string | undefined, unit: string, content: string, enable: boolean) {
    this.gate.check(token)
    return this.editor.createUnit(unit, content, enable)
  }
  async setUnitEnabled(token: string | undefined, unit: string, enabled: boolean) {
    this.gate.check(token)
    return this.editor.setUnitEnabled(unit, enabled)
  }

  // ---------- fstab ----------

  fstabState() {
    return this.fstab.fstabState()
  }
  validateFstab(change: FstabChange) {
    return this.fstab.validateFstab(change)
  }
  fstabRevision(id: string) {
    return this.fstab.fstabRevision(id)
  }
  async applyFstab(token: string | undefined, change: FstabChange, confirmCritical: boolean) {
    this.gate.check(token)
    return this.fstab.applyFstab(change, confirmCritical)
  }
  async mountAction(token: string | undefined, target: string, action: 'mount' | 'unmount') {
    this.gate.check(token)
    return this.fstab.mountAction(target, action)
  }

  // ---------- boot ----------

  bootState() {
    return this.boot.bootState()
  }
  async setBootDefault(token: string | undefined, id: string) {
    this.gate.check(token)
    return this.boot.setBootDefault(id)
  }
  async setBootTimeout(token: string | undefined, value: string) {
    this.gate.check(token)
    return this.boot.setBootTimeout(value)
  }
  async cancelOneshot(token: string | undefined) {
    this.gate.check(token)
    return this.boot.cancelOneshot()
  }
  async updateBootLoader(token: string | undefined) {
    this.gate.check(token)
    return this.boot.updateBootLoader()
  }
  kernelEntryPreview(pkg: string) {
    return this.boot.kernelEntryPreview(pkg)
  }
  async createKernelEntry(token: string | undefined, pkg: string) {
    this.gate.check(token)
    return this.boot.createKernelEntry(pkg)
  }
  async removeBootEntry(token: string | undefined, id: string) {
    this.gate.check(token)
    return this.boot.removeBootEntry(id)
  }
  bootEntryFile(id: string) {
    return this.boot.bootEntryFile(id)
  }
  bootEntryRevision(id: string, revision: string) {
    return this.boot.bootEntryRevision(id, revision)
  }
  checkBootEntry(content: string) {
    return this.boot.checkBootEntry(content)
  }
  bootFiles() {
    return this.boot.bootFiles()
  }
  async writeBootEntry(token: string | undefined, change: BootEntryChange) {
    this.gate.check(token)
    return this.boot.writeBootEntry(change)
  }
  async reboot(token: string | undefined, opts: { entry?: string; firmware?: boolean }) {
    this.gate.check(token)
    return this.boot.reboot(opts)
  }

  // ---------- users ----------

  usersState() {
    return this.users.usersState()
  }
  async applyUser(token: string | undefined, change: UserChange) {
    this.gate.check(token)
    return this.users.applyUser(change)
  }

  hardware() {
    return this.hw.hardware()
  }

  // ---------- reverse proxy (Caddy) ----------

  caddyState() {
    return this.caddy.caddyState()
  }
  caddyRevision(id: string) {
    return this.caddy.caddyRevision(id)
  }
  async applyCaddy(token: string | undefined, change: CaddyChange, expected: string | undefined) {
    this.gate.check(token)
    return this.caddy.applyCaddy(change, expected)
  }
  async setCaddyPath(token: string | undefined, path: string | null) {
    this.gate.check(token)
    return this.caddy.setCaddyPath(path)
  }

  // ---------- disk energy saving ----------

  powerSample() {
    return this.power.powerSample()
  }
  diskPower() {
    return this.power.diskPower()
  }
  diskUsers(name: string) {
    return this.power.diskUsers(name)
  }
  powerHistory() {
    return this.power.powerHistory()
  }
  async setDiskPower(token: string | undefined, serial: string, setting: PowerSetting | null) {
    this.gate.check(token)
    return this.power.setDiskPower(serial, setting)
  }

  // ---------- backups (restic) ----------

  backupState(refresh?: boolean) {
    return this.backup.backupState(refresh)
  }
  backupSuggest() {
    return this.backup.backupSuggest()
  }
  backupSizes(paths: string[], excludes: string[]) {
    return this.backup.backupSizes(paths, excludes)
  }
  backupLs(snapshot: string, dir: string) {
    return this.backup.backupLs(snapshot, dir)
  }
  async saveBackupPlan(token: string | undefined, plan: BackupPlan, secrets: Record<string, string>) {
    this.gate.check(token)
    return this.backup.saveBackupPlan(plan, secrets)
  }
  async disableBackup(token: string | undefined) {
    this.gate.check(token)
    return this.backup.disableBackup()
  }
  async backupPassword(token: string | undefined) {
    this.gate.check(token)
    return this.backup.backupPassword()
  }
  async startBackup(token: string | undefined, kind: 'backup' | 'check') {
    this.gate.check(token)
    return this.backup.startBackup(kind)
  }
  async backupDump(token: string | undefined, snapshot: string, path: string) {
    this.gate.check(token)
    return this.backup.backupDump(snapshot, path)
  }
  targetState(refresh?: boolean) {
    return this.backup.targetState(refresh)
  }
  async setupTarget(token: string | undefined, config: TargetConfig) {
    this.gate.check(token)
    // The Quadlet goes through the Quadlet backend: generator check, history, (re)start.
    const r = await this.admin.writeQuadlet(TARGET_QUADLET, await this.backup.saveTarget(config), true)
    if (r.warning) throw new HttpError(500, r.warning)
    return this.backup.targetState()
  }
  async removeTarget(token: string | undefined) {
    this.gate.check(token)
    await this.admin.deleteQuadlet(TARGET_QUADLET).catch((e: unknown) => {
      if (!(e instanceof HttpError && e.status === 404)) throw e
    })
    await this.backup.clearTarget()
    return this.backup.targetState()
  }
  async addBackupClient(token: string | undefined, name: string, warnDays: number | undefined) {
    this.gate.check(token)
    return this.backup.addClient(name, warnDays)
  }
  async updateBackupClient(token: string | undefined, name: string, change: { warnDays?: number | null; disabled?: boolean }) {
    this.gate.check(token)
    return this.backup.updateClient(name, change)
  }
  async renewBackupClient(token: string | undefined, name: string) {
    this.gate.check(token)
    return this.backup.renewClient(name)
  }
  async removeBackupClient(token: string | undefined, name: string, deleteData: boolean) {
    this.gate.check(token)
    return this.backup.removeClient(name, deleteData)
  }
  async setBackupClientPlan(token: string | undefined, name: string, plan: ClientPlan) {
    this.gate.check(token)
    return this.backup.setClientPlan(name, plan)
  }
  async backupClientLink(token: string | undefined, name: string, quadeckUrl: string) {
    this.gate.check(token)
    return this.backup.clientLink(name, quadeckUrl)
  }
  redeemBackupClientLink(linkToken: string) {
    return this.backup.redeemClientLink(linkToken)
  }
}
