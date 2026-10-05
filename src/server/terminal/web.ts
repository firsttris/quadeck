// The web app's side of the terminal: the opt-in settings, which login session owns which
// terminal (only its owner can read, type or close), and "home network only".

import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { DEFAULT_TERMINAL, isLocalAddress, parseTerminalSettings, type TerminalInfo, type TerminalSettings } from '~/shared/terminal'
import { HttpError, clientKey } from '../auth'
import { getSetting, setSetting } from '../settings'

const KEY = 'terminal.settings'
const owners = new Map<string, { session: string; info: TerminalInfo }>()

export function terminalSettings(): TerminalSettings {
  const v = getSetting<TerminalSettings>(KEY)
  return v ? parseTerminalSettings(v) : DEFAULT_TERMINAL
}
export function setTerminalSettings(v: unknown): TerminalSettings {
  const s = parseTerminalSettings(v)
  setSetting(KEY, s)
  return s
}

/** Switched on, and (if set) the browser is in the home network. */
export function assertTerminalAllowed(request: Request) {
  const s = terminalSettings()
  if (!s.enabled) throw new HttpError(403, msg(m.terminal_error_off))
  if (s.localOnly && !isLocalAddress(clientKey(request))) throw new HttpError(403, msg(m.terminal_error_notLocal))
}

export function remember(info: TerminalInfo, session: string) {
  owners.set(info.id, { session, info })
}

/** The terminal, if this login session opened it. */
export function owned(id: unknown, session: string): string {
  if (typeof id !== 'string' || owners.get(id)?.session !== session) throw new HttpError(404, msg(m.terminal_error_gone))
  return id
}

export const forget = (id: string) => owners.delete(id)
export const ownedBy = (session: string) => [...owners.values()].filter((o) => o.session === session).map((o) => o.info)
export const allTerminals = () => [...owners.keys()]
