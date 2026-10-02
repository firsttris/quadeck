import { existsSync } from 'node:fs'
import type { JobSpec } from '~/shared/packages'
import type { MaintenanceBackend } from '../packages/maintenance'
import type { PodmanAdminBackend } from '../quadlets/backend'
import type { PodmanConfigName } from '~/shared/quadlets'
import type { SharesBackend } from '../shares/backend'
import type { SshBackend } from '../ssh/backend'
import type { SelfTestType, SmartBackend } from '../smart/backend'
import type { FilesBackend } from '../files/backend'
import type { SshChange } from '~/shared/ssh'
import type { ShareChange, ShareServiceAction } from '~/shared/shares'
import { HttpError } from '../auth'
import { runOk } from '../exec'
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
  ) {}

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

  private podman(path: string, init: RequestInit = {}) {
    if (!existsSync(this.podmanSocket)) throw new HttpError(503, `Podman-Socket ${this.podmanSocket} fehlt – systemctl enable --now podman.socket`)
    return fetch(`http://podman${path}`, { ...init, unix: this.podmanSocket, signal: AbortSignal.timeout(15_000) } as RequestInit)
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
    if (!res.ok && res.status !== 304) throw new Error(`Podman: ${action} fehlgeschlagen (HTTP ${res.status}) ${await res.text()}`)
  }

  // ---------- packages & images ----------

  overview() {
    return this.maint.overview()
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
  async writeQuadlet(token: string | undefined, name: string, content: string, restart: boolean) {
    this.gate.check(token)
    return this.admin.writeQuadlet(name, content, restart)
  }
  async deleteQuadlet(token: string | undefined, name: string) {
    this.gate.check(token)
    return this.admin.deleteQuadlet(name)
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
  async renamePath(token: string | undefined, path: string, newName: string) {
    this.gate.check(token)
    return this.files.renamePath(path, newName)
  }
}
