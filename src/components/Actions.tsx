import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { api, ApiError } from '~/lib/api'
import { useUnlock } from './Unlock'
import { ConfirmDialog } from './Modal'
import { useToast } from './Toast'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'

type Action = 'start' | 'stop' | 'restart'
type Target = { kind: 'unit'; name: string } | { kind: 'container'; name: string; unit?: string }

interface Ctx {
  run: (action: Action, target: Target) => void | Promise<void>
  busy: string | null
  /** Which action runs on `busy` (for the spinner label on the clicked button). */
  busyAction: Action | null
  readonly: boolean
}

const ActionCtx = createContext<Ctx>({ run: () => {}, busy: null, busyAction: null, readonly: false })

/** The "…ing" label for an action (for BusyButton). */
export const actionBusyLabel = (action: Action) => pickMsg({ "start": m.common_starting, "stop": m.common_stopping, "restart": m.common_restarting }, action)

/**
 * Unit/container actions with confirmation for the dangerous ones (stop,
 * restart). Containers with a unit always go through systemd.
 */
export function ActionsProvider({ readonly, children }: { readonly: boolean; children: ReactNode }) {
  const say = useToast()
  const unlock = useUnlock()
  const [busy, setBusy] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<Action | null>(null)
  const [pending, setPending] = useState<{ action: Action; target: Target } | null>(null)

  const exec = useCallback(
    async (action: Action, target: Target) => {
      setBusy(target.name)
      setBusyAction(action)
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
        say(`${what} ${pickMsg({ "start": m.shell_actions_done_start, "stop": m.shell_actions_done_stop, "restart": m.shell_actions_done_restart }, action)} (${r.via === 'podman' ? `Podman-API` : `systemctl ${action}`})`)
      } catch (e) {
        say((e as Error).message, 'bad')
      } finally {
        setBusy(null)
        setBusyAction(null)
      }
    },
    [say, unlock],
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
    <ActionCtx.Provider value={{ run, busy, busyAction, readonly }}>
      {children}
      <ConfirmDialog
        open={!!p}
        title={p ? m.shell_actions_confirmTitle({ name: p.target.name, action: pickMsg({ "start": m.shell_actions_label_start, "stop": m.shell_actions_label_stop, "restart": m.shell_actions_label_restart }, p.action), actionLower: (pickMsg({ "start": m.shell_actions_label_start, "stop": m.shell_actions_label_stop, "restart": m.shell_actions_label_restart }, p.action)).toLowerCase() }) : ''}
        danger={p?.action === 'stop'}
        confirm={p ? pickMsg({ "start": m.shell_actions_label_start, "stop": m.shell_actions_label_stop, "restart": m.shell_actions_label_restart }, p.action) : ''}
        busyLabel={p ? actionBusyLabel(p.action) : undefined}
        body={
          <p className="m-0">
            {m.shell_actions_runs()}
            <span className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[12px]">{via}</span>.{p?.action === 'stop' && m.shell_actions_stopHint()}
          </p>
        }
        onConfirm={() => (p ? exec(p.action, p.target) : undefined)}
        onClose={() => setPending(null)}
      />
    </ActionCtx.Provider>
  )
}

export const useActions = () => useContext(ActionCtx)
