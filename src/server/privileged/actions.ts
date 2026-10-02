// All root actions go through this interface with a fixed list of
// operations — never arbitrary commands. The MVP implementation calls systemd
// over D-Bus directly; later a separate root helper (Unix socket, polkit/PAM)
// gets a second implementation of the same interface.

export type UnitAction = 'start' | 'stop' | 'restart'

export interface PrivilegedActions {
  unit(action: UnitAction, name: string): Promise<void>
  daemonReload(): Promise<void>
}

export const UNIT_ACTIONS: readonly UnitAction[] = ['start', 'stop', 'restart']

const UNIT_NAME = /^[A-Za-z0-9:_.\\@-]{1,240}\.(service|timer)$/

export function assertUnitName(name: string) {
  if (!UNIT_NAME.test(name) || name.startsWith('-')) throw new Error(`Ungültiger Unit-Name: ${name}`)
}
