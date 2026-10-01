import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { api } from '~/lib/api'
import { ConfirmDialog } from './Modal'
import { useToast } from './Toast'

type Action = 'start' | 'stop' | 'restart'
type Target = { kind: 'unit'; name: string } | { kind: 'container'; name: string; unit?: string }

const LABEL: Record<Action, string> = { start: 'Starten', stop: 'Stoppen', restart: 'Neu starten' }
const DONE: Record<Action, string> = { start: 'gestartet', stop: 'gestoppt', restart: 'neu gestartet' }

interface Ctx {
  run: (action: Action, target: Target) => void
  busy: string | null
  readonly: boolean
}

const ActionCtx = createContext<Ctx>({ run: () => {}, busy: null, readonly: false })

/**
 * Unit/container actions with confirmation for the dangerous ones (stop,
 * restart). Containers with a unit always go through systemd.
 */
export function ActionsProvider({ readonly, children }: { readonly: boolean; children: ReactNode }) {
  const say = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<{ action: Action; target: Target } | null>(null)

  const exec = useCallback(
    async (action: Action, target: Target) => {
      setBusy(target.name)
      try {
        const r = await api<{ via: string }>(target.kind === 'unit' ? '/api/units' : '/api/containers', { body: { action, name: target.name } })
        const what = target.kind === 'container' && target.unit ? target.unit : target.name
        say(`${what} ${DONE[action]} (${r.via === 'podman' ? `Podman-API` : `systemctl ${action}`})`)
      } catch (e) {
        say((e as Error).message, 'bad')
      } finally {
        setBusy(null)
      }
    },
    [say],
  )

  const run = useCallback(
    (action: Action, target: Target) => {
      if (action === 'start') void exec(action, target)
      else setPending({ action, target })
    },
    [exec],
  )

  const p = pending
  const via = p && (p.target.kind === 'unit' ? `systemctl ${p.action} ${p.target.name}` : p.target.unit ? `systemctl ${p.action} ${p.target.unit}` : `Podman-API: ${p.action} ${p.target.name}`)
  return (
    <ActionCtx.Provider value={{ run, busy, readonly }}>
      {children}
      <ConfirmDialog
        open={!!p}
        title={p ? `${p.target.name} ${LABEL[p.action].toLowerCase()}?` : ''}
        danger={p?.action === 'stop'}
        confirm={p ? LABEL[p.action] : ''}
        body={
          <p className="m-0">
            Ausgeführt wird <span className="rounded bg-[#0e1319] px-1.5 py-0.5 font-mono text-[12px]">{via}</span>.
            {p?.action === 'stop' && ' Der Dienst ist danach nicht mehr erreichbar.'}
          </p>
        }
        onConfirm={() => p && void exec(p.action, p.target)}
        onClose={() => setPending(null)}
      />
    </ActionCtx.Provider>
  )
}

export const useActions = () => useContext(ActionCtx)
