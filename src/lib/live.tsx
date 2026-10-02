import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Snapshot, SystemMetrics } from '~/shared/types'

interface Live {
  snapshot: Snapshot
  connected: boolean
}

const Ctx = createContext<Live | null>(null)

/** Holds the live snapshot, fed by /api/events (SSE). Starts from the SSR snapshot. */
export function LiveProvider({ initial, children }: { initial: Snapshot; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState(initial)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let es: EventSource | undefined
    let closed = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      es = new EventSource('/api/events')
      es.addEventListener('open', () => setConnected(true))
      es.addEventListener('state', (e) => setSnapshot(JSON.parse((e as MessageEvent).data) as Snapshot))
      es.addEventListener('system', (e) => {
        const system = JSON.parse((e as MessageEvent).data) as SystemMetrics
        setSnapshot((s) => ({ ...s, system }))
      })
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
        retry = setTimeout(connect, 3000)
      })
    }
    connect()
    return () => {
      closed = true
      clearTimeout(retry)
      es?.close()
    }
  }, [])

  return <Ctx.Provider value={{ snapshot, connected }}>{children}</Ctx.Provider>
}

export function useLive(): Live {
  const v = useContext(Ctx)
  if (!v) throw new Error('useLive outside LiveProvider')
  return v
}
