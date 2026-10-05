import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { HttpError } from '../auth'
import type { Privileged, UnitAction } from './actions'
import type { ImageUpdatesReport, InstalledPackage, JobInfo, JobSpec, JobState, PackageDetail, PackageOverview, RemovePreview, UpdatesReport } from '~/shared/packages'
import type { PodmanConfigName, PodmanSettings, QuadletFile, RemovalPlan, Revision, ValidateResult } from '~/shared/quadlets'
import type { RemoveAlso, WriteResult } from '../quadlets/backend'
import type { ShareChange, SharePreview, ShareServiceAction, SharesState } from '~/shared/shares'
import type { SshChange, SshPreview, SshState } from '~/shared/ssh'
import type { SmartReport } from '~/shared/smart'
import type { SelfTestType } from '../smart/backend'
import type { DirListing, FileRoot, TextFile } from '~/shared/files'
import type { ArchivePreview } from '~/shared/archives'
import type { CalendarPreview, TimerAction, TimerSpec, TimersState } from '~/shared/timers'
import type { UnitDetail, UnitValidateResult, UnitWriteResult } from '~/shared/unit-files'
import type { ScanResult } from '~/shared/devices'
import type { PowerSample } from '~/shared/energy'
import type { CleanupKind, CleanupResult, PodmanStorage, PruneEvery } from '~/shared/podman-storage'
import type { TerminalInfo } from '~/shared/terminal'
import type { SecretsState } from '~/shared/secrets'
import type { NetworkState } from '~/shared/network'
import type { FstabChange, FstabCheck, FstabState } from '~/shared/fstab'
import type { BootEntryChange, BootEntryFile, BootState, EntryProblem } from '~/shared/boot'
import type { UserChange, UsersState } from '~/shared/users'
import type { Hardware } from '~/shared/hardware'
import type { CaddyChange, CaddyResult, CaddyState } from '~/shared/caddy'
import type { ConfigAction, ConfigFileInfo } from '~/shared/configfiles'
import type { UnlockInfo } from './gate'
import type { ClientPlan } from '~/shared/backup-client'
import type { PowerSetting, PowerState } from '~/shared/power'
import type { DiskUser } from '../smart/power'
import type { BackupPlan, BackupSizes, BackupState, BackupSuggestion, LsEntry, TargetConfig, TargetState } from '~/shared/backup'

/** Privileged over the root helper's Unix socket. */
export class HelperClient implements Privileged {
  readonly kind = 'helper' as const

  constructor(private socket: string) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    let res: Response
    try {
      res = await fetch(`http://helper${path}`, {
        method,
        unix: this.socket,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      } as RequestInit)
    } catch (e) {
      throw new HttpError(503, msg(m.helper_error_unreachable, { socket: this.socket, message: (e as Error).message }))
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new HttpError(res.status, data.error ?? msg(m.helper_error_http, { status: res.status }))
    return data as T
  }

  info() {
    return this.call<UnlockInfo>('GET', '/info')
  }
  unlock(user: string, password: string) {
    return this.call<{ token: string; expiresAt: number }>('POST', '/unlock', { user, password })
  }
  async lock(token: string | undefined) {
    await this.call('POST', '/lock', { token })
  }
  async unlockedUntil(token: string | undefined) {
    return (await this.call<{ until: number | null }>('POST', '/unlocked', { token })).until
  }
  async check(token: string | undefined) {
    await this.call('POST', '/check', { token })
  }
  async unit(token: string | undefined, action: UnitAction, name: string) {
    await this.call('POST', '/unit', { token, action, name })
  }
  async daemonReload(token: string | undefined) {
    await this.call('POST', '/daemon-reload', { token })
  }
  async podmanGet<T>(path: string) {
    return (await this.call<{ data: T }>('POST', '/podman/get', { path }, 20_000)).data
  }
  async podmanContainer(token: string | undefined, id: string, action: UnitAction) {
    await this.call('POST', '/podman/container', { token, id, action })
  }

  overview() {
    return this.call<PackageOverview>('POST', '/pkg/overview', {})
  }
  async installed() {
    return (await this.call<{ data: InstalledPackage[] }>('POST', '/pkg/installed', {}, 120_000)).data
  }
  async detail(name: string) {
    return (await this.call<{ data: PackageDetail | null }>('POST', '/pkg/detail', { name })).data
  }
  updates(refresh: boolean) {
    return this.call<UpdatesReport>('POST', '/pkg/updates', { refresh }, 600_000)
  }
  removePreview(names: string[]) {
    return this.call<RemovePreview>('POST', '/pkg/remove-preview', { names }, 120_000)
  }
  imageUpdates(refresh: boolean) {
    return this.call<ImageUpdatesReport>('POST', '/images/updates', { refresh }, 300_000)
  }
  async jobs() {
    return (await this.call<{ data: JobInfo[] }>('POST', '/jobs/list', {})).data
  }
  async job(id: string, from: number) {
    return (await this.call<{ data: JobState | null }>('POST', '/jobs/get', { id, from })).data
  }
  startJob(token: string | undefined, spec: JobSpec) {
    return this.call<JobInfo>('POST', '/jobs/start', { token, spec }, 120_000)
  }

  async quadlets() {
    return (await this.call<{ data: QuadletFile[] }>('POST', '/quadlets/list', {})).data
  }
  async readQuadlet(name: string) {
    return (await this.call<{ data: string }>('POST', '/quadlets/read', { name })).data
  }
  validateQuadlet(name: string, content: string) {
    return this.call<ValidateResult>('POST', '/quadlets/validate', { name, content })
  }
  async quadletHistory(name: string) {
    return (await this.call<{ data: Revision[] }>('POST', '/quadlets/history', { name })).data
  }
  async quadletRevision(name: string, id: string) {
    return (await this.call<{ data: string }>('POST', '/quadlets/revision', { name, id })).data
  }
  podmanSettings() {
    return this.call<PodmanSettings>('POST', '/podman/settings', {})
  }
  writeQuadlet(token: string | undefined, name: string, content: string, restart: boolean, expected?: string) {
    return this.call<WriteResult>('POST', '/quadlets/write', { token, name, content, restart, expected }, 180_000)
  }
  removalPlan(name: string) {
    return this.call<RemovalPlan>('POST', '/quadlets/plan', { name })
  }
  deleteQuadlet(token: string | undefined, name: string, also: RemoveAlso = {}) {
    return this.call<{ warnings: string[] }>('POST', '/quadlets/delete', { token, name, image: also.image === true, volumes: also.volumes === true }, 300_000)
  }
  async setAutoUpdateTimer(token: string | undefined, enabled: boolean, calendar: string) {
    await this.call('POST', '/podman/timer', { token, enabled, calendar })
  }
  async setAutoUpdateDefault(token: string | undefined, enabled: boolean) {
    await this.call('POST', '/podman/autoupdate-default', { token, enabled })
  }
  async writePodmanConfig(token: string | undefined, name: PodmanConfigName, content: string) {
    await this.call('POST', '/podman/config', { token, name, content })
  }

  sharesState() {
    return this.call<SharesState>('POST', '/shares/state', {})
  }
  previewShare(change: ShareChange) {
    return this.call<SharePreview>('POST', '/shares/preview', { change }, 60_000)
  }
  applyShare(token: string | undefined, change: ShareChange) {
    return this.call<SharesState>('POST', '/shares/apply', { token, change }, 120_000)
  }
  shareService(token: string | undefined, kind: 'smb' | 'nfs', action: ShareServiceAction) {
    return this.call<SharesState>('POST', '/shares/service', { token, kind, action }, 120_000)
  }

  sshState() {
    return this.call<SshState>('POST', '/ssh/state', {})
  }
  previewSsh(change: SshChange) {
    return this.call<SshPreview>('POST', '/ssh/preview', { change })
  }
  applySsh(token: string | undefined, change: SshChange) {
    return this.call<SshState>('POST', '/ssh/apply', { token, change }, 60_000)
  }
  sshService(token: string | undefined, action: 'start' | 'restart' | 'enable') {
    return this.call<SshState>('POST', '/ssh/service', { token, action }, 60_000)
  }

  smartReport(refresh: boolean) {
    return this.call<SmartReport>('POST', '/smart/report', { refresh }, 300_000)
  }
  smartSelfTest(token: string | undefined, disk: string, type: SelfTestType) {
    return this.call<SmartReport>('POST', '/smart/selftest', { token, disk, type }, 300_000)
  }

  async fileRoots() {
    return (await this.call<{ data: FileRoot[] }>('POST', '/files/roots', {})).data
  }
  listDir(path: string) {
    return this.call<DirListing>('POST', '/files/list', { path }, 60_000)
  }
  async makeDir(token: string | undefined, path: string) {
    await this.call('POST', '/files/mkdir', { token, path })
  }
  async renamePath(token: string | undefined, path: string, newName: string) {
    await this.call('POST', '/files/rename', { token, path, newName })
  }
  readTextFile(token: string | undefined, path: string) {
    return this.call<TextFile>('POST', '/files/read', { token, path }, 60_000)
  }
  archivePreview(token: string | undefined, archive: string, toDir: string) {
    return this.call<ArchivePreview>('POST', '/files/archive', { token, archive, toDir }, 120_000)
  }
  archiveTools() {
    return this.call<{ zip: boolean }>('GET', '/files/archive-tools')
  }
  fileResponse(token: string | undefined, path: string, opts: { range?: string | null; download?: boolean }) {
    return this.stream('/files/raw', { token, path, range: opts.range ?? undefined, download: opts.download === true })
  }

  /** A route answering with a body that is passed on as it arrives (file contents). */
  private async stream(route: string, body: unknown) {
    let res: Response
    try {
      res = await fetch(`http://helper${route}`, {
        method: 'POST',
        unix: this.socket,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      } as RequestInit)
    } catch (e) {
      throw new HttpError(503, msg(m.helper_error_unreachable, { socket: this.socket, message: (e as Error).message }))
    }
    if (!res.ok && res.status !== 416 && (res.headers.get('content-type') ?? '').includes('application/json')) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new HttpError(res.status, data.error ?? msg(m.helper_error_http, { status: res.status }))
    }
    // Streamed through: the body is read from the helper while the browser receives it.
    return new Response(res.body, { status: res.status, headers: res.headers })
  }
  writeTextFile(token: string | undefined, path: string, content: string, expected: string) {
    return this.call<TextFile>('POST', '/files/write', { token, path, content, expected }, 60_000)
  }

  timersState() {
    return this.call<TimersState>('POST', '/timers/state', {})
  }
  previewCalendar(calendar: string) {
    return this.call<CalendarPreview>('POST', '/timers/preview', { calendar })
  }
  async timerFiles(name: string) {
    return (await this.call<{ data: string }>('POST', '/timers/files', { name })).data
  }
  saveTimer(token: string | undefined, spec: TimerSpec, previous: string | undefined, enable: boolean) {
    return this.call<TimersState>('POST', '/timers/save', { token, spec, previous, enable }, 120_000)
  }
  deleteTimer(token: string | undefined, name: string) {
    return this.call<TimersState>('POST', '/timers/delete', { token, name }, 120_000)
  }
  setTimerSchedule(token: string | undefined, name: string, calendar: string) {
    return this.call<TimersState>('POST', '/timers/schedule', { token, name, calendar }, 120_000)
  }
  timerAction(token: string | undefined, name: string, action: TimerAction) {
    return this.call<TimersState>('POST', '/timers/action', { token, name, action }, 120_000)
  }

  terminalOpen(token: string | undefined, target: { kind: 'shell' } | { kind: 'container'; name: string }, cols: number, rows: number, idleMinutes: number) {
    return this.call<TerminalInfo>('POST', '/terminal/open', { token, target, cols, rows, idleMinutes }, 30_000)
  }
  terminalStream(id: string) {
    return this.stream('/terminal/stream', { id })
  }
  async terminalInput(id: string, data: string) {
    await this.call('POST', '/terminal/input', { id, data }, 10_000)
  }
  async terminalResize(id: string, cols: number, rows: number) {
    await this.call('POST', '/terminal/resize', { id, cols, rows }, 10_000)
  }
  async terminalClose(id: string) {
    await this.call('POST', '/terminal/close', { id }, 10_000)
  }
  secretsState() {
    return this.call<SecretsState>('POST', '/secrets/state', {}, 60_000)
  }
  createSecret(token: string | undefined, name: string, value: string, replace: boolean) {
    return this.call<SecretsState>('POST', '/secrets/create', { token, name, value, replace }, 60_000)
  }
  removeSecret(token: string | undefined, name: string) {
    return this.call<SecretsState>('POST', '/secrets/remove', { token, name }, 60_000)
  }
  moveSecret(token: string | undefined, file: string, key: string, name: string, restart: boolean) {
    return this.call<{ state: SecretsState; write: WriteResult }>('POST', '/secrets/move', { token, file, key, name, restart }, 120_000)
  }
  podmanStorage() {
    return this.call<PodmanStorage>('POST', '/podman/storage', {}, 200_000)
  }
  cleanPodman(token: string | undefined, items: { kind: CleanupKind; id: string }[]) {
    return this.call<{ results: CleanupResult[]; skipped: number }>('POST', '/podman/clean', { token, items }, 600_000)
  }
  setPodmanPrune(token: string | undefined, every: PruneEvery | null) {
    return this.call<PodmanStorage>('POST', '/podman/prune', { token, every }, 200_000)
  }
  networkState() {
    return this.call<NetworkState>('POST', '/network/state', {}, 60_000)
  }
  scanDevices(active: boolean) {
    return this.call<ScanResult>('POST', '/network/devices', { active }, 120_000)
  }
  unitDetail(unit: string) {
    return this.call<UnitDetail>('POST', '/units/detail', { unit })
  }
  validateUnitFile(unit: string, path: string, content: string) {
    return this.call<UnitValidateResult>('POST', '/units/validate', { unit, path, content })
  }
  async unitFileHistory(unit: string, path: string) {
    return (await this.call<{ data: Revision[] }>('POST', '/units/history', { unit, path })).data
  }
  async unitFileRevision(unit: string, path: string, id: string) {
    return (await this.call<{ data: string }>('POST', '/units/revision', { unit, path, id })).data
  }
  writeUnitFile(token: string | undefined, unit: string, path: string, content: string, restart: boolean, expected?: string) {
    return this.call<UnitWriteResult>('POST', '/units/write', { token, unit, path, content, restart, expected }, 180_000)
  }
  async deleteUnitFile(token: string | undefined, unit: string, path: string) {
    await this.call('POST', '/units/delete', { token, unit, path }, 180_000)
  }
  createUnit(token: string | undefined, unit: string, content: string, enable: boolean) {
    return this.call<UnitWriteResult>('POST', '/units/create', { token, unit, content, enable }, 180_000)
  }
  async setUnitEnabled(token: string | undefined, unit: string, enabled: boolean) {
    await this.call('POST', '/units/enable', { token, unit, enabled }, 60_000)
  }

  fstabState() {
    return this.call<FstabState>('POST', '/fstab/state', {})
  }
  validateFstab(change: FstabChange) {
    return this.call<FstabCheck>('POST', '/fstab/validate', { change }, 60_000)
  }
  async fstabRevision(id: string) {
    return (await this.call<{ data: string }>('POST', '/fstab/revision', { id })).data
  }
  applyFstab(token: string | undefined, change: FstabChange, confirm: boolean) {
    return this.call<FstabState>('POST', '/fstab/apply', { token, change, confirm }, 300_000)
  }
  mountAction(token: string | undefined, target: string, action: 'mount' | 'unmount') {
    return this.call<FstabState>('POST', '/fstab/mount', { token, target, action }, 180_000)
  }

  bootState() {
    return this.call<BootState>('POST', '/boot/state', {})
  }
  setBootDefault(token: string | undefined, id: string) {
    return this.call<BootState>('POST', '/boot/default', { token, id }, 90_000)
  }
  setBootTimeout(token: string | undefined, value: string) {
    return this.call<BootState>('POST', '/boot/timeout', { token, value }, 90_000)
  }
  cancelOneshot(token: string | undefined) {
    return this.call<BootState>('POST', '/boot/oneshot-cancel', { token }, 90_000)
  }
  updateBootLoader(token: string | undefined) {
    return this.call<BootState>('POST', '/boot/update', { token }, 90_000)
  }
  kernelEntryPreview(pkg: string) {
    return this.call<{ path: string; content: string }>('POST', '/boot/entry-preview', { pkg })
  }
  createKernelEntry(token: string | undefined, pkg: string) {
    return this.call<BootState>('POST', '/boot/entry-create', { token, pkg }, 60_000)
  }
  removeBootEntry(token: string | undefined, id: string) {
    return this.call<BootState>('POST', '/boot/entry-remove', { token, id }, 60_000)
  }
  bootEntryFile(id: string) {
    return this.call<BootEntryFile>('POST', '/boot/entry-file', { id })
  }
  async bootEntryRevision(id: string, revision: string) {
    return (await this.call<{ data: string }>('POST', '/boot/entry-revision', { id, revision })).data
  }
  bootFiles() {
    return this.call<string[]>('POST', '/boot/files', {})
  }
  checkBootEntry(content: string) {
    return this.call<EntryProblem[]>('POST', '/boot/entry-check', { content })
  }
  writeBootEntry(token: string | undefined, change: BootEntryChange) {
    return this.call<BootState>('POST', '/boot/entry-write', { token, change }, 90_000)
  }
  reboot(token: string | undefined, opts: { entry?: string; firmware?: boolean }) {
    return this.call<{ at: number }>('POST', '/boot/reboot', { token, ...opts }, 90_000)
  }
  usersState() {
    return this.call<UsersState>('POST', '/users/state', {})
  }
  applyUser(token: string | undefined, change: UserChange) {
    return this.call<UsersState>('POST', '/users/apply', { token, change }, 120_000)
  }
  hardware() {
    return this.call<Hardware>('POST', '/hardware', {}, 60_000)
  }
  caddyState() {
    return this.call<CaddyState>('POST', '/caddy/state', {}, 30_000)
  }
  async caddyRevision(id: string) {
    return (await this.call<{ data: string }>('POST', '/caddy/revision', { id })).data
  }
  applyCaddy(token: string | undefined, change: CaddyChange, expected: string | undefined) {
    return this.call<CaddyResult>('POST', '/caddy/apply', { token, change, expected }, 180_000)
  }
  setCaddyPath(token: string | undefined, path: string | null) {
    return this.call<CaddyState>('POST', '/caddy/path', { token, path }, 30_000)
  }
  configFile(path: string) {
    return this.call<ConfigFileInfo>('POST', '/pkg/config-file', { path })
  }
  applyConfigFile(token: string | undefined, path: string, action: ConfigAction, content?: string) {
    return this.call<{ done: string; after?: ConfigFileInfo['after']; warning?: string }>('POST', '/pkg/config-apply', { token, path, action, content }, 180_000)
  }

  backupState(refresh?: boolean) {
    return this.call<BackupState>('POST', '/backup/state', { refresh: refresh === true }, 600_000)
  }
  backupSuggest() {
    return this.call<BackupSuggestion>('POST', '/backup/suggest', {})
  }
  backupSizes(paths: string[], excludes: string[]) {
    return this.call<BackupSizes>('POST', '/backup/sizes', { paths, excludes }, 600_000)
  }
  async backupLs(snapshot: string, dir: string) {
    return (await this.call<{ data: LsEntry[] }>('POST', '/backup/ls', { snapshot, dir }, 180_000)).data
  }
  saveBackupPlan(token: string | undefined, plan: BackupPlan, secrets: Record<string, string>) {
    return this.call<BackupState>('POST', '/backup/save', { token, plan, secrets }, 600_000)
  }
  disableBackup(token: string | undefined) {
    return this.call<BackupState>('POST', '/backup/disable', { token }, 120_000)
  }
  async backupPassword(token: string | undefined) {
    return (await this.call<{ data: string }>('POST', '/backup/password', { token })).data
  }
  async startBackup(token: string | undefined, kind: 'backup' | 'check') {
    await this.call('POST', '/backup/start', { token, kind })
  }
  backupDump(token: string | undefined, snapshot: string, path: string) {
    return this.stream('/backup/dump', { token, snapshot, path })
  }
  powerSample() {
    return this.call<PowerSample>('POST', '/power/sample', {}, 60_000)
  }
  diskPower() {
    return this.call<PowerState>('POST', '/power/state', {}, 120_000)
  }
  async diskUsers(name: string) {
    return (await this.call<{ data: DiskUser[] }>('POST', '/power/users', { name }, 60_000)).data
  }
  async powerHistory() {
    return (await this.call<{ data: Revision[] }>('POST', '/power/history', {})).data
  }
  setDiskPower(token: string | undefined, serial: string, setting: PowerSetting | null) {
    return this.call<PowerState>('POST', '/power/set', { token, serial, setting }, 120_000)
  }
  targetState(refresh?: boolean) {
    return this.call<TargetState>('POST', '/backup/target/state', { refresh: refresh === true }, 900_000)
  }
  setupTarget(token: string | undefined, config: TargetConfig) {
    return this.call<TargetState>('POST', '/backup/target/setup', { token, config }, 300_000)
  }
  removeTarget(token: string | undefined) {
    return this.call<TargetState>('POST', '/backup/target/remove', { token }, 120_000)
  }
  addBackupClient(token: string | undefined, name: string, warnDays: number | undefined) {
    return this.call<{ password: string }>('POST', '/backup/client/add', { token, name, warnDays })
  }
  updateBackupClient(token: string | undefined, name: string, change: { warnDays?: number | null; disabled?: boolean }) {
    return this.call<TargetState>('POST', '/backup/client/update', { token, name, change })
  }
  renewBackupClient(token: string | undefined, name: string) {
    return this.call<{ password: string }>('POST', '/backup/client/renew', { token, name })
  }
  removeBackupClient(token: string | undefined, name: string, deleteData: boolean) {
    return this.call<TargetState>('POST', '/backup/client/remove', { token, name, deleteData }, 600_000)
  }
  setBackupClientPlan(token: string | undefined, name: string, plan: ClientPlan) {
    return this.call<TargetState>('POST', '/backup/client/plan', { token, name, plan })
  }
  backupClientLink(token: string | undefined, name: string, quadeckUrl: string) {
    return this.call<{ token: string; expires: number }>('POST', '/backup/client/link', { token, name, url: quadeckUrl })
  }
  async redeemBackupClientLink(linkToken: string) {
    return (await this.call<{ script?: string }>('POST', '/backup/client/redeem', { link: linkToken })).script
  }
}
