import { HttpError } from '../auth'
import type { Privileged, UnitAction } from './actions'
import type { ImageUpdatesReport, InstalledPackage, JobInfo, JobSpec, JobState, PackageDetail, PackageOverview, RemovePreview, UpdatesReport } from '~/shared/packages'
import type { PodmanConfigName, PodmanSettings, QuadletFile, Revision, ValidateResult } from '~/shared/quadlets'
import type { WriteResult } from '../quadlets/backend'
import type { ShareChange, SharePreview, ShareServiceAction, SharesState } from '~/shared/shares'
import type { SshChange, SshPreview, SshState } from '~/shared/ssh'
import type { SmartReport } from '~/shared/smart'
import type { SelfTestType } from '../smart/backend'
import type { DirListing, FileRoot } from '~/shared/files'
import type { CalendarPreview, TimerAction, TimerSpec, TimersState } from '~/shared/timers'
import type { UnlockInfo } from './gate'

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
      throw new HttpError(503, `Root-Helfer nicht erreichbar (${this.socket}): ${(e as Error).message}`)
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new HttpError(res.status, data.error ?? `Helfer: HTTP ${res.status}`)
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
  writeQuadlet(token: string | undefined, name: string, content: string, restart: boolean) {
    return this.call<WriteResult>('POST', '/quadlets/write', { token, name, content, restart }, 180_000)
  }
  async deleteQuadlet(token: string | undefined, name: string) {
    await this.call('POST', '/quadlets/delete', { token, name }, 120_000)
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
}
