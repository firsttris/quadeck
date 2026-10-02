// All root actions go through `Privileged` with a fixed list of operations —
// never arbitrary commands. Two implementations:
//   LocalPrivileged  – Quadeck itself runs as root (single process)
//   HelperClient     – the web app runs as user "quadeck" and asks the root
//                      helper (`quadeck helper`) over a Unix socket
// Both enforce the unlock gate where the root actions actually run.

import type { JobInfo, JobSpec } from '~/shared/packages'
import type { Maintenance } from '../packages/maintenance'
import type { PodmanAdmin, WriteResult } from '../quadlets/backend'
import type { PodmanConfigName } from '~/shared/quadlets'
import type { UnlockInfo } from './gate'

export type UnitAction = 'start' | 'stop' | 'restart'
export const UNIT_ACTIONS: readonly UnitAction[] = ['start', 'stop', 'restart']

/** Package/image reads need no unlock (they change nothing); jobs do. */
export interface Privileged extends Maintenance, PodmanAdmin {
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
  startJob(token: string | undefined, spec: JobSpec): Promise<JobInfo>
  writeQuadlet(token: string | undefined, name: string, content: string, restart: boolean): Promise<WriteResult>
  deleteQuadlet(token: string | undefined, name: string): Promise<void>
  setAutoUpdateTimer(token: string | undefined, enabled: boolean, calendar: string): Promise<void>
  setAutoUpdateDefault(token: string | undefined, enabled: boolean): Promise<void>
  writePodmanConfig(token: string | undefined, name: PodmanConfigName, content: string): Promise<void>
}

const UNIT_NAME = /^[A-Za-z0-9:_.\\@-]{1,240}\.(service|timer)$/

export function assertUnitName(name: string) {
  if (!UNIT_NAME.test(name) || name.startsWith('-')) throw new Error(`Ungültiger Unit-Name: ${name}`)
}

/** Podman API reads the helper proxies. Everything else is refused. */
const PODMAN_READS = [/^\/version$/, /^\/containers\/json\?all=true$/, /^\/v4\.0\.0\/libpod\/containers\/stats\?stream=false$/, /^\/containers\/[0-9a-f]{12,64}\/json$/]

export function assertPodmanRead(path: string) {
  if (!PODMAN_READS.some((r) => r.test(path))) throw new Error(`Podman-Pfad nicht erlaubt: ${path}`)
}

export function assertContainerId(id: string) {
  if (!/^[0-9a-f]{12,64}$/.test(id)) throw new Error('Ungültige Container-ID')
}
