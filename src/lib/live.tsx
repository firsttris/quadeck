import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { applyStats, type LiveStats } from '~/shared/live-stats'
import type { Snapshot, SystemMetrics } from '~/shared/types'

/** The snapshot without the system metrics, which change every 2 s. */
export type LiveState = Omit<Snapshot, 'system'>

interface Live {
  snapshot: Snapshot
  connected: boolean
}

// Two contexts: most of the app needs units, containers, disks … (new about every 5 s or less),
// only the overview's gauges and charts need the system metrics. Components that read the state
// alone no longer re-render on every 2 s tick.
const StateCtx = createContext<{ snapshot: LiveState; connected: boolean } | null>(null)
const SystemCtx = createContext<Snapshot['system']>(null)

const RETRY_MIN_MS = 3_000
const RETRY_MAX_MS = 30_000

/** Holds the live snapshot, fed by /api/events (SSE). Starts from the SSR snapshot. */
export function LiveProvider({ initial, children }: { initial: Snapshot; children: ReactNode }) {
  const [state, setState] = useState<LiveState>(initial)
  const [system, setSystem] = useState(initial.system)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let es: EventSource | undefined
    let closed = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let delay = RETRY_MIN_MS
    const connect = () => {
      es = new EventSource('/api/events')
      es.addEventListener('open', () => {
        setConnected(true)
        delay = RETRY_MIN_MS
      })
      es.addEventListener('state', (e) => {
        const { system: s, ...rest } = JSON.parse((e as MessageEvent).data) as Snapshot
        setState(rest)
        if (s) setSystem(s)
      })
      es.addEventListener('stats', (e) => {
        const stats = JSON.parse((e as MessageEvent).data) as LiveStats
        setState((s) => applyStats(s, stats))
      })
      es.addEventListener('system', (e) => setSystem(JSON.parse((e as MessageEvent).data) as SystemMetrics))
      es.addEventListener('error', async () => {
        setConnected(false)
        es?.close()
        if (closed) return
        // Session expired? Then go to the login page instead of retrying forever.
        const r = await fetch('/api/events', { method: 'HEAD' }).catch(() => undefined)
        if (r?.status === 401) {
          window.location.href = '/login'
          return
        }
        // While the server restarts, many tabs must not hit it every 3 s: back off up to 30 s.
        retry = setTimeout(connect, delay * (0.8 + Math.random() * 0.4))
        delay = Math.min(RETRY_MAX_MS, delay * 2)
      })
    }
    connect()
    return () => {
      closed = true
      clearTimeout(retry)
      es?.close()
    }
  }, [])

  const stateValue = useMemo(() => ({ snapshot: state, connected }), [state, connected])
  return (
    <StateCtx.Provider value={stateValue}>
      <SystemCtx.Provider value={system}>{children}</SystemCtx.Provider>
    </StateCtx.Provider>
  )
}

/** Units, containers, disks … without the 2 s system metrics: no re-render on every system tick. */
export function useLiveState(): { snapshot: LiveState; connected: boolean } {
  const v = useContext(StateCtx)
  if (!v) throw new Error('useLiveState outside LiveProvider')
  return v
}

/** The whole snapshot including the system metrics (re-renders every 2 s). */
export function useLive(): Live {
  const { snapshot, connected } = useLiveState()
  const system = useContext(SystemCtx)
  return useMemo(() => ({ snapshot: { ...snapshot, system }, connected }), [snapshot, system, connected])
}
