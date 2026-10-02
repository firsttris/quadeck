import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { useT } from '~/i18n'
import { api, ApiError } from '~/lib/api'
import { useUnlock } from './Unlock'
import { ConfirmDialog } from './Modal'
import { useToast } from './Toast'

type Action = 'start' | 'stop' | 'restart'
type Target = { kind: 'unit'; name: string } | { kind: 'container'; name: string; unit?: string }

interface Ctx {
  run: (action: Action, target: Target) => void | Promise<void>
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
  const t = useT().shell.actions
  const unlock = useUnlock()
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<{ action: Action; target: Target } | null>(null)

  const exec = useCallback(
    async (action: Action, target: Target) => {
      setBusy(target.name)
      const call = () => api<{ via: string }>(target.kind === 'unit' ? '/api/units' : '/api/containers', { body: { action, name: target.name } })
      try {
        let r
        try {
          r = await call()
        } catch (e) {
          // The unlock ran out (or the helper restarted): unlock again and retry once.
          if (!(e instanceof ApiError && e.status === 423)) throw e
          unlock.markLocked()
          if (!(await unlock.ensure())) return
          r = await call()
        }
        const what = target.kind === 'container' && target.unit ? target.unit : target.name
        say(`${what} ${t.done[action]} (${r.via === 'podman' ? `Podman-API` : `systemctl ${action}`})`)
      } catch (e) {
        say((e as Error).message, 'bad')
      } finally {
        setBusy(null)
      }
    },
    [say, unlock, t],
  )

  const run = useCallback(
    async (action: Action, target: Target) => {
      if (!(await unlock.ensure())) return
      if (action === 'start') void exec(action, target)
      else setPending({ action, target })
    },
    [exec, unlock],
  )

  const p = pending
  const via = p && (p.target.kind === 'unit' ? `systemctl ${p.action} ${p.target.name}` : p.target.unit ? `systemctl ${p.action} ${p.target.unit}` : `Podman-API: ${p.action} ${p.target.name}`)
  return (
    <ActionCtx.Provider value={{ run, busy, readonly }}>
      {children}
      <ConfirmDialog
        open={!!p}
        title={p ? t.confirmTitle(p.target.name, t.label[p.action]) : ''}
        danger={p?.action === 'stop'}
        confirm={p ? t.label[p.action] : ''}
        body={
          <p className="m-0">
            {t.runs}
            <span className="rounded bg-[#0e1319] px-1.5 py-0.5 font-mono text-[12px]">{via}</span>.{p?.action === 'stop' && t.stopHint}
          </p>
        }
        onConfirm={() => p && void exec(p.action, p.target)}
        onClose={() => setPending(null)}
      />
    </ActionCtx.Provider>
  )
}

export const useActions = () => useContext(ActionCtx)
