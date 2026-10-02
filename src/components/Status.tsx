import type { Health, Unit } from '~/shared/types'

export type Tone = 'ok' | 'warn' | 'bad' | 'idle'

export function Dot({ tone, label }: { tone: Tone; label?: string }) {
  return <span className={`dot ${tone === 'idle' ? '' : tone}`} role={label ? 'img' : undefined} aria-label={label} />
}

export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={`pill ${tone}`}>
      <Dot tone={tone} />
      {children}
    </span>
  )
}

export function healthTone(h: Health): Tone {
  return h === 'unknown' ? 'idle' : h
}

export function unitTone(u: Pick<Unit, 'active' | 'sub'>): Tone {
  if (u.active === 'failed') return 'bad'
  if (u.active === 'activating' || u.active === 'deactivating' || u.active === 'reloading') return 'warn'
  if (u.active === 'active') return 'ok'
  return 'idle'
}

export function unitState(u: Pick<Unit, 'active' | 'sub'>): string {
  if (u.active === 'active') return u.sub === 'running' || u.sub === 'waiting' || u.sub === 'exited' || u.sub === 'listening' ? u.sub : 'active'
  return u.active
}

/** Status pill for a container: health from the Podman healthcheck beats "running". */
export function containerState(c: { state: string; status: string; health?: 'healthy' | 'unhealthy' | 'starting' }): { tone: Tone; label: string } {
  if (c.state !== 'running') return { tone: c.state === 'exited' && /Exited \((?!0\))/.test(c.status) ? 'bad' : 'idle', label: c.state === 'exited' ? 'gestoppt' : c.state }
  if (c.health === 'unhealthy') return { tone: 'bad', label: 'unhealthy' }
  if (c.health === 'starting') return { tone: 'warn', label: 'startet' }
  return { tone: 'ok', label: c.health ?? 'running' }
}
