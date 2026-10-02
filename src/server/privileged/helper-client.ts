import { HttpError } from '../auth'
import type { Privileged, UnitAction } from './actions'
import type { ImageUpdatesReport, InstalledPackage, JobInfo, JobSpec, JobState, PackageDetail, PackageOverview, RemovePreview, UpdatesReport } from '~/shared/packages'
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
}
