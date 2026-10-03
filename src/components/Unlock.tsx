import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError } from '~/lib/api'
import { Glyph } from './Glyph'
import { Modal } from './Modal'
import { m } from '~/paraglide/messages'

type Mode = 'system' | 'quadeck' | 'none' | 'readonly'

interface UnlockState {
  mode: Mode | null
  until: number | null
  suggestedUser: string
  minutes: number
}

interface Ctx extends UnlockState {
  /** Resolves true once unlocked (asks for the password if needed). */
  ensure: () => Promise<boolean>
  lock: () => Promise<void>
  markLocked: () => void
}

const UnlockCtx = createContext<Ctx>({ mode: null, until: null, suggestedUser: 'root', minutes: 15, ensure: async () => true, lock: async () => {}, markLocked: () => {} })
export const useUnlock = () => useContext(UnlockCtx)

const isOpen = (s: UnlockState) => s.mode === 'none' || (s.until !== null && s.until > Date.now())

/**
 * Privileged actions (start/stop/restart, later updates and Quadlets) need an
 * unlock: the password of an admin account, checked by the root helper.
 */
export function UnlockProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UnlockState>({ mode: null, until: null, suggestedUser: 'root', minutes: 15 })
  const [asking, setAsking] = useState(false)
  const waiters = useRef<((ok: boolean) => void)[]>([])
  const stateRef = useRef(state)
  stateRef.current = state

  const refresh = useCallback(async () => {
    const r = await fetch('/api/unlock').catch(() => undefined)
    if (r?.ok) setState((await r.json()) as UnlockState)
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Relock in the UI when the time is up.
  useEffect(() => {
    if (!state.until || state.mode === 'none') return
    const ms = state.until - Date.now()
    if (ms <= 0 || ms > 2 ** 31) return
    const t = setTimeout(() => setState((s) => ({ ...s, until: null })), ms)
    return () => clearTimeout(t)
  }, [state.until, state.mode])

  const finish = (ok: boolean) => {
    setAsking(false)
    for (const w of waiters.current.splice(0)) w(ok)
  }

  const ensure = useCallback(() => {
    if (isOpen(stateRef.current)) return Promise.resolve(true)
    if (stateRef.current.mode === 'readonly') return Promise.resolve(false)
    setAsking(true)
    return new Promise<boolean>((resolve) => waiters.current.push(resolve))
  }, [])

  const lock = useCallback(async () => {
    await api('/api/unlock', { method: 'DELETE' }).catch(() => {})
    setState((s) => ({ ...s, until: null }))
  }, [])

  const markLocked = useCallback(() => setState((s) => ({ ...s, until: null })), [])

  return (
    <UnlockCtx.Provider value={{ ...state, ensure, lock, markLocked }}>
      {children}
      <UnlockDialog
        open={asking}
        state={state}
        onDone={(until) => {
          setState((s) => ({ ...s, until }))
          finish(true)
        }}
        onCancel={() => finish(false)}
      />
    </UnlockCtx.Provider>
  )
}

function UnlockDialog({ open, state, onDone, onCancel }: { open: boolean; state: UnlockState; onDone: (until: number) => void; onCancel: () => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setError('')
  }, [open])
  const system = state.mode === 'system'
  return (
    <Modal open={open} onClose={onCancel} title={m.shell_unlock_title()}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          setBusy(true)
          setError('')
          try {
            const r = await api<{ until: number }>('/api/unlock', { body: { user: f.get('user') ?? 'root', password: f.get('password') } })
            onDone(r.until)
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <p className="m-0 text-[13px] text-[#c9d1d9]">
          {system ? m.shell_unlock_needSystem() : m.shell_unlock_needQuadeck()} {m.shell_unlock_afterwards({ min: state.minutes })}
        </p>
        {system && (
          <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
            {m.shell_unlock_user()}
            <input name="user" required defaultValue={state.suggestedUser} autoComplete="username" className="field font-mono" />
          </label>
        )}
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {m.shell_unlock_password()}
          <input name="password" type="password" required autoFocus autoComplete="current-password" className="field" />
        </label>
        {error && (
          <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onCancel}>
            {m.common_cancel()}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {m.shell_unlock_submit()}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Sidebar chip: locked / unlocked with countdown. */
export function UnlockChip({ compact = false }: { compact?: boolean }) {
  const u = useUnlock()
  const [, tick] = useState(0)
  const open = isOpen(u)
  useEffect(() => {
    if (!open || u.mode === 'none') return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [open, u.mode])
  if (!u.mode || u.mode === 'none' || u.mode === 'readonly') return null
  if (compact) {
    // Phones: only the unlocked state is worth the room – actions ask for the unlock themselves.
    if (!open) return null
    const left = Math.max(0, Math.round((u.until! - Date.now()) / 1000))
    return (
      <button type="button" className="flex h-10 items-center gap-1 rounded-lg px-2 text-[12px] text-[#e3b341] tabular-nums hover:bg-[#161c24]" onClick={() => void u.lock()} aria-label={m.shell_unlock_relock()}>
        <Glyph name="unlock" size={17} strokeWidth={2} />
        {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
      </button>
    )
  }
  if (!open) {
    return (
      <button type="button" className="btn mx-1 justify-start" onClick={() => void u.ensure()} title={m.shell_unlock_unlockTitle()}>
        <Glyph name="lock" size={15} strokeWidth={2} />
        <span className="grow text-left">{m.shell_unlock_locked()}</span>
        <span className="text-[12px] text-accent">{m.shell_unlock_submit()}</span>
      </button>
    )
  }
  const left = Math.max(0, Math.round((u.until! - Date.now()) / 1000))
  return (
    <button type="button" className="btn mx-1 justify-start border-[rgba(210,153,34,.5)] text-[#e3b341]" onClick={() => void u.lock()} title={m.shell_unlock_relock()}>
      <Glyph name="unlock" size={15} strokeWidth={2} />
      <span className="grow text-left">
        {m.shell_unlock_unlocked()} · {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
      </span>
      <span className="text-[12px]">{m.shell_unlock_lock()}</span>
    </button>
  )
}

/**
 * API call that changes the host: unlocks first and, if the unlock ran out
 * in between (423), asks once more and retries. Resolves undefined when the
 * user cancels the unlock.
 */
export function useGuardedApi() {
  const unlock = useUnlock()
  return useCallback(
    async <T,>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T | undefined> => {
      if (!(await unlock.ensure())) return undefined
      try {
        return await api<T>(path, init)
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 423)) throw e
        unlock.markLocked()
        if (!(await unlock.ensure())) return undefined
        return await api<T>(path, init)
      }
    },
    [unlock],
  )
}
