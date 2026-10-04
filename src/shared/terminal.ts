// Terminal in the browser: shared types, settings and the "home network" check.

export interface TerminalInfo {
  id: string
  kind: 'shell' | 'container'
  /** user@host or the container name. */
  label: string
  /** Who the shell runs as. */
  user: string
  startedAt: number
}

export const IDLE_MINUTES = [15, 60, 240] as const
export type IdleMinutes = (typeof IDLE_MINUTES)[number]

export interface TerminalSettings {
  enabled: boolean
  localOnly: boolean
  idleMinutes: IdleMinutes
}
export const DEFAULT_TERMINAL: TerminalSettings = { enabled: false, localOnly: true, idleMinutes: 15 }

export function parseTerminalSettings(v: unknown): TerminalSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const idle = Number(o.idleMinutes)
  return { enabled: o.enabled === true, localOnly: o.localOnly !== false, idleMinutes: (IDLE_MINUTES as readonly number[]).includes(idle) ? (idle as IdleMinutes) : 15 }
}

/** Container names Podman allows. */
export const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

/**
 * Addresses that count as "home network": loopback, private IPv4, CGNAT/Tailscale (100.64/10),
 * link-local, IPv6 ULA (fc00::/7, also WireGuard setups) and link-local. Everything else is public.
 */
export function isLocalAddress(ip: string): boolean {
  let a = ip.trim().toLowerCase()
  if (a.startsWith('[')) a = a.slice(1, a.indexOf(']'))
  a = a.replace(/%.*$/, '')
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?$/.exec(a)
  if (v4) {
    const [p, q] = [Number(v4[1]), Number(v4[2])]
    return p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254)
  }
  if (a === '::1') return true
  return /^f[cd][0-9a-f]{0,2}:/.test(a) || /^fe[89ab][0-9a-f]?:/.test(a)
}

/** Control codes for the extra keys on a phone. */
export const KEYS: Record<string, string> = { Esc: '\x1b', Tab: '\t', Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D' }

/** Ctrl + a letter → the control character (Ctrl+C → \x03). */
export function ctrlKey(ch: string): string | undefined {
  const c = ch.toLowerCase()
  if (c.length !== 1) return undefined
  if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96)
  return { '[': '\x1b', '\\': '\x1c', ']': '\x1d', ' ': '\x00' }[c]
}
