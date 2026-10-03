import { verifyPassword } from '../auth'
import { config } from '../config'
import type { Privileged } from './actions'
import { Gate, type UnlockMode } from './gate'
import { HelperClient } from './helper-client'
import { LocalPrivileged } from './local'
import { FixtureMaintenance, SystemMaintenance } from '../packages/maintenance'
import { FixturePodmanAdmin, SystemPodmanAdmin } from '../quadlets/backend'
import { FixtureShares, SystemShares } from '../shares/backend'
import { FixtureSsh, SystemSsh } from '../ssh/backend'
import { FixtureSmart, SystemSmart } from '../smart/backend'
import { FixtureFiles, SystemFiles } from '../files/backend'
import { FixtureTimers, SystemTimers } from '../timers/backend'
import { FixtureUnitEditor, SystemUnitEditor } from '../systemd/editor'
import { FixtureNetwork, SystemNetwork } from '../network/collect'
import { FixtureFstabHost, FstabManager, SystemFstabHost } from '../fstab/backend'
import { FixtureBoot, SystemBoot } from '../boot/backend'
import { FixtureUsers, SystemUsers } from '../users/backend'
import { FixtureHardware, SystemHardware } from '../hardware/collect'
import { CaddyManager, FixtureCaddyHost, SystemCaddyHost } from '../caddy/backend'
import { FixtureBackup, SystemBackup, quadletContents } from '../backup/backend'
import { selfArgv } from '../packages/jobs'
import { bilingual } from '../lang'

export function unlockMode(helperProcess: boolean): UnlockMode {
  const m = (process.env.QUADECK_UNLOCK ?? '').trim().toLowerCase()
  if (m === 'none' || m === 'system') return m
  // The Quadeck password lives in the web app's database: only usable when
  // everything runs in one process.
  if (m === 'quadeck') return helperProcess ? 'system' : 'quadeck'
  return 'system'
}

export function createGate(helperProcess: boolean) {
  return new Gate(unlockMode(helperProcess), Number(process.env.QUADECK_UNLOCK_MINUTES ?? 15) || 15, { verifyQuadeck: (pw) => verifyPassword(pw) })
}

let instance: Privileged | undefined

/**
 * Root → do it here. Otherwise → ask the helper (QUADECK_HELPER_SOCKET,
 * default /run/quadeck/helper.sock).
 */
export function privileged(): Privileged {
  if (instance) return instance
  const isRoot = process.getuid?.() === 0
  const fixtures = config().fixturesDir
  const files = fixtures ? new FixtureFiles(fixtures) : new SystemFiles()
  const maint = fixtures ? new FixtureMaintenance(fixtures, files as FixtureFiles) : new SystemMaintenance()
  const podman = fixtures ? new FixturePodmanAdmin(fixtures) : new SystemPodmanAdmin()
  instance =
    isRoot || fixtures
      ? // In one process, privileged work runs as if it were the helper (see bilingual()).
        bilingual(
          new LocalPrivileged(
            createGate(false),
            config().podmanSocket,
            maint,
            podman,
            fixtures ? new FixtureShares(fixtures) : new SystemShares(),
            fixtures ? new FixtureSsh(fixtures) : new SystemSsh(),
            fixtures ? new FixtureSmart(fixtures) : new SystemSmart(),
            files,
            fixtures ? new FixtureTimers(fixtures) : new SystemTimers(),
            fixtures ? new FixtureUnitEditor(fixtures) : new SystemUnitEditor(),
            fixtures ? new FixtureNetwork(fixtures) : new SystemNetwork(),
            new FstabManager(fixtures ? new FixtureFstabHost(fixtures) : new SystemFstabHost()),
            fixtures ? new FixtureBoot(fixtures, async () => new Map((await maint.installed()).map((p) => [p.name, p.version]))) : new SystemBoot(),
            fixtures ? new FixtureUsers(fixtures) : new SystemUsers(),
            fixtures ? new FixtureHardware(fixtures) : new SystemHardware(),
          new CaddyManager(fixtures ? new FixtureCaddyHost(fixtures) : new SystemCaddyHost()),
            fixtures ? new FixtureBackup(quadletContents(podman)) : new SystemBackup({ self: selfArgv(), quadlets: quadletContents(podman) }),
          ),
        )
      : new HelperClient(config().helperSocket)
  return instance
}
