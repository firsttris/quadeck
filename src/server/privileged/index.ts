import { verifyPassword } from '../auth'
import { config } from '../config'
import type { Privileged } from './actions'
import { Gate, type UnlockMode } from './gate'
import { HelperClient } from './helper-client'
import { LocalPrivileged } from './local'
import { FixtureMaintenance, SystemMaintenance } from '../packages/maintenance'

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
  instance =
    isRoot || fixtures
      ? new LocalPrivileged(createGate(false), config().podmanSocket, fixtures ? new FixtureMaintenance(fixtures) : new SystemMaintenance())
      : new HelperClient(config().helperSocket)
  return instance
}
