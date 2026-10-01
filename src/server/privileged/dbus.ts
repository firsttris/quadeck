import { runOk } from '../exec'
import { assertUnitName, type PrivilegedActions, type UnitAction } from './actions'

const METHOD: Record<UnitAction, string> = { start: 'StartUnit', stop: 'StopUnit', restart: 'RestartUnit' }

const manager = ['org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager']

/** PrivilegedActions over the system bus (busctl, argv only — no shell). */
export class DbusActions implements PrivilegedActions {
  async unit(action: UnitAction, name: string) {
    assertUnitName(name)
    await runOk(['busctl', 'call', ...manager, METHOD[action], 'ss', name, 'replace'], { timeoutMs: 30_000 })
  }

  async daemonReload() {
    await runOk(['busctl', 'call', ...manager, 'Reload'], { timeoutMs: 60_000 })
  }
}
