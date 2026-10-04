// All root actions go through `Privileged` with a fixed list of operations —
// never arbitrary commands. Two implementations:
//   LocalPrivileged  – Quadeck itself runs as root (single process)
//   HelperClient     – the web app runs as user "quadeck" and asks the root
//                      helper (`quadeck helper`) over a Unix socket
// Both enforce the unlock gate where the root actions actually run.

import type { CleanupKind, CleanupResult, PodmanStorage, PruneEvery } from '~/shared/podman-storage'
import type { SecretsState } from '~/shared/secrets'
import { msg } from '~/shared/i18n'
import type { JobInfo, JobSpec } from '~/shared/packages'
import type { Maintenance } from '../packages/maintenance'
import type { PodmanAdmin, RemoveAlso, WriteResult } from '../quadlets/backend'
import type { PodmanConfigName } from '~/shared/quadlets'
import type { SharesAdmin } from '../shares/backend'
import type { SshAdmin } from '../ssh/backend'
import type { SelfTestType, SmartAdmin } from '../smart/backend'
import type { FilesAdmin } from '../files/backend'
import type { TextFile } from '~/shared/files'
import type { TimersAdmin } from '../timers/backend'
import type { UnitEditorAdmin } from '../systemd/editor'
import type { NetworkAdmin } from '../network/collect'
import type { FstabAdmin } from '../fstab/backend'
import type { BootAdmin } from '../boot/backend'
import type { UsersAdmin } from '../users/backend'
import type { HardwareAdmin } from '../hardware/collect'
import type { CaddyAdmin } from '../caddy/backend'
import type { BackupAdmin } from '../backup/backend'
import type { PowerAdmin } from '../smart/power'
import type { PowerSetting, PowerState } from '~/shared/power'
import type { BackupPlan, BackupState, TargetConfig, TargetState } from '~/shared/backup'
import type { ClientPlan } from '~/shared/backup-client'
import type { CaddyChange, CaddyResult, CaddyState } from '~/shared/caddy'
import type { UserChange, UsersState } from '~/shared/users'
import type { ConfigAction, ConfigFileInfo } from '~/shared/configfiles'
import type { BootEntryChange, BootState } from '~/shared/boot'
import type { FstabChange, FstabState } from '~/shared/fstab'
import type { UnitWriteResult } from '~/shared/unit-files'
import type { TimerAction, TimerSpec, TimersState } from '~/shared/timers'
import type { SmartReport } from '~/shared/smart'
import type { SshChange, SshState } from '~/shared/ssh'
import type { ShareChange, ShareServiceAction, SharesState } from '~/shared/shares'
import type { UnlockInfo } from './gate'

export type UnitAction = 'start' | 'stop' | 'restart'
export const UNIT_ACTIONS: readonly UnitAction[] = ['start', 'stop', 'restart']

/** Package/image reads need no unlock (they change nothing); jobs do. */
export interface Privileged extends Maintenance, PodmanAdmin, SharesAdmin, SshAdmin, SmartAdmin, FilesAdmin, TimersAdmin, UnitEditorAdmin, NetworkAdmin, FstabAdmin, BootAdmin, UsersAdmin, HardwareAdmin, CaddyAdmin, BackupAdmin, PowerAdmin {
  readonly kind: 'local' | 'helper'
  info(): Promise<UnlockInfo>
  unlock(user: string, password: string): Promise<{ token: string; expiresAt: number }>
  lock(token: string | undefined): Promise<void>
  unlockedUntil(token: string | undefined): Promise<number | null>
  /** Throws LockedError (423) unless the token is valid. */
  check(token: string | undefined): Promise<void>
  unit(token: string | undefined, action: UnitAction, name: string): Promise<void>
  daemonReload(token: string | undefined): Promise<void>
  /** Read-only Podman API call from a fixed allowlist (no unlock needed). */
  podmanGet<T>(path: string): Promise<T>
  podmanContainer(token: string | undefined, id: string, action: UnitAction): Promise<void>
  podmanStorage(): Promise<PodmanStorage>
  secretsState(): Promise<SecretsState>
  createSecret(token: string | undefined, name: string, value: string, replace: boolean): Promise<SecretsState>
  removeSecret(token: string | undefined, name: string): Promise<SecretsState>
  moveSecret(token: string | undefined, file: string, key: string, name: string, restart: boolean): Promise<{ state: SecretsState; write: WriteResult }>
  cleanPodman(token: string | undefined, items: { kind: CleanupKind; id: string }[]): Promise<{ results: CleanupResult[]; skipped: number }>
  setPodmanPrune(token: string | undefined, every: PruneEvery | null): Promise<PodmanStorage>
  startJob(token: string | undefined, spec: JobSpec): Promise<JobInfo>
  writeQuadlet(token: string | undefined, name: string, content: string, restart: boolean): Promise<WriteResult>
  deleteQuadlet(token: string | undefined, name: string, also?: RemoveAlso): Promise<{ warnings: string[] }>
  setAutoUpdateTimer(token: string | undefined, enabled: boolean, calendar: string): Promise<void>
  setAutoUpdateDefault(token: string | undefined, enabled: boolean): Promise<void>
  writePodmanConfig(token: string | undefined, name: PodmanConfigName, content: string): Promise<void>
  applyShare(token: string | undefined, change: ShareChange): Promise<SharesState>
  shareService(token: string | undefined, kind: 'smb' | 'nfs', action: ShareServiceAction): Promise<SharesState>
  applySsh(token: string | undefined, change: SshChange): Promise<SshState>
  sshService(token: string | undefined, action: 'start' | 'restart' | 'enable'): Promise<SshState>
  smartSelfTest(token: string | undefined, disk: string, type: SelfTestType): Promise<SmartReport>
  makeDir(token: string | undefined, path: string): Promise<void>
  renamePath(token: string | undefined, path: string, newName: string): Promise<void>
  /** Text file for the editor; keys and secrets only when unlocked (423 otherwise). */
  readTextFile(token: string | undefined, path: string): Promise<TextFile>
  writeTextFile(token: string | undefined, path: string, content: string, expected: string): Promise<TextFile>
  /** The file as an HTTP response for the browser (Range, inline or download); keys and secrets only when unlocked. */
  fileResponse(token: string | undefined, path: string, opts: { range?: string | null; download?: boolean }): Promise<Response>
  saveTimer(token: string | undefined, spec: TimerSpec, previous: string | undefined, enable: boolean): Promise<TimersState>
  deleteTimer(token: string | undefined, name: string): Promise<TimersState>
  setTimerSchedule(token: string | undefined, name: string, calendar: string): Promise<TimersState>
  timerAction(token: string | undefined, name: string, action: TimerAction): Promise<TimersState>
  writeUnitFile(token: string | undefined, unit: string, path: string, content: string, restart: boolean): Promise<UnitWriteResult>
  deleteUnitFile(token: string | undefined, unit: string, path: string): Promise<void>
  createUnit(token: string | undefined, unit: string, content: string, enable: boolean): Promise<UnitWriteResult>
  setUnitEnabled(token: string | undefined, unit: string, enabled: boolean): Promise<void>
  applyFstab(token: string | undefined, change: FstabChange, confirmCritical: boolean): Promise<FstabState>
  mountAction(token: string | undefined, target: string, action: 'mount' | 'unmount'): Promise<FstabState>
  setBootDefault(token: string | undefined, id: string): Promise<BootState>
  setBootTimeout(token: string | undefined, value: string): Promise<BootState>
  cancelOneshot(token: string | undefined): Promise<BootState>
  updateBootLoader(token: string | undefined): Promise<BootState>
  reboot(token: string | undefined, opts: { entry?: string; firmware?: boolean }): Promise<{ at: number }>
  createKernelEntry(token: string | undefined, pkg: string): Promise<BootState>
  removeBootEntry(token: string | undefined, id: string): Promise<BootState>
  writeBootEntry(token: string | undefined, change: BootEntryChange): Promise<BootState>
  applyUser(token: string | undefined, change: UserChange): Promise<UsersState>
  applyConfigFile(token: string | undefined, path: string, action: ConfigAction, content?: string): Promise<{ done: string; after?: ConfigFileInfo['after']; warning?: string }>
  applyCaddy(token: string | undefined, change: CaddyChange, expected: string | undefined): Promise<CaddyResult>
  setCaddyPath(token: string | undefined, path: string | null): Promise<CaddyState>
  saveBackupPlan(token: string | undefined, plan: BackupPlan, secrets: Record<string, string>): Promise<BackupState>
  disableBackup(token: string | undefined): Promise<BackupState>
  backupPassword(token: string | undefined): Promise<string>
  startBackup(token: string | undefined, kind: 'backup' | 'check'): Promise<void>
  /** A file (or a folder as zip) from a snapshot, streamed. */
  backupDump(token: string | undefined, snapshot: string, path: string): Promise<Response>
  /** Backup target for clients: the rest-server Quadlet plus its data folder. */
  setupTarget(token: string | undefined, config: TargetConfig): Promise<TargetState>
  /** Standby time and APM of a disk (by serial); null removes Quadeck's rule. */
  setDiskPower(token: string | undefined, serial: string, setting: PowerSetting | null): Promise<PowerState>
  removeTarget(token: string | undefined): Promise<TargetState>
  addBackupClient(token: string | undefined, name: string, warnDays: number | undefined): Promise<{ password: string }>
  updateBackupClient(token: string | undefined, name: string, change: { warnDays?: number | null; disabled?: boolean }): Promise<TargetState>
  renewBackupClient(token: string | undefined, name: string): Promise<{ password: string }>
  removeBackupClient(token: string | undefined, name: string, deleteData: boolean): Promise<TargetState>
  setBackupClientPlan(token: string | undefined, name: string, plan: ClientPlan): Promise<TargetState>
  backupClientLink(token: string | undefined, name: string, quadeckUrl: string): Promise<{ token: string; expires: number }>
  /** No unlock: the one-time link is the authorisation (it is used up here). */
  redeemBackupClientLink(linkToken: string): Promise<string | undefined>
}

const UNIT_NAME = /^[A-Za-z0-9:_.\\@-]{1,240}\.(service|timer|socket)$/

export function assertUnitName(name: string) {
  if (!UNIT_NAME.test(name) || name.startsWith('-')) throw new Error(msg('helper_error_invalidUnitName', { unit: name }))
}

/** Podman API reads the helper proxies. Everything else is refused. */
const PODMAN_READS = [/^\/version$/, /^\/containers\/json\?all=true$/, /^\/v4\.0\.0\/libpod\/containers\/stats\?stream=false$/, /^\/containers\/[0-9a-f]{12,64}\/json$/]

export function assertPodmanRead(path: string) {
  if (!PODMAN_READS.some((r) => r.test(path))) throw new Error(msg('helper_error_podmanPathDenied', { path }))
}

export function assertContainerId(id: string) {
  if (!/^[0-9a-f]{12,64}$/.test(id)) throw new Error(msg('helper_error_invalidContainerId'))
}
