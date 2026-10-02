import { useEffect, useMemo, useState } from 'react'
import { metricRows } from '~/shared/metrics'
import { HISTORY_RANGES, type HistoryRange, type MetricHistory, type MetricName } from '~/shared/types'
import { useLive } from './live'

const REFRESH: Record<HistoryRange, number> = { '1h': 60_000, '6h': 120_000, '24h': 300_000, '7d': 600_000 }

/**
 * Stored history for a range plus the live samples since the last stored
 * point (for 1 h and 6 h), so the right edge moves with the gauges.
 */
export function useMetricHistory(range: HistoryRange): { series: MetricHistory; loaded: boolean; now: number } {
  const { snapshot } = useLive()
  const [server, setServer] = useState<MetricHistory>({})
  const [loaded, setLoaded] = useState(false)
  const [live, setLive] = useState<{ ts: number; metric: MetricName; value: number }[]>([])

  useEffect(() => {
    let stop = false
    const load = () =>
      fetch(`/api/metrics/history?range=${range}`)
        .then((r) => (r.ok ? r.json() : { series: {} }))
        .then((d: { series: MetricHistory }) => {
          if (stop) return
          setServer(d.series)
          setLoaded(true)
        })
        .catch(() => {})
    void load()
    const t = setInterval(load, REFRESH[range])
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [range])

  const sys = snapshot.system
  useEffect(() => {
    if (!sys) return
    setLive((l) => (l.length && l[l.length - 1]!.ts >= sys.ts ? l : [...l.filter((x) => x.ts > sys.ts - HISTORY_RANGES['1h']), ...metricRows(sys)]))
  }, [sys])

  const now = sys?.ts ?? Date.now()
  const series = useMemo(() => {
    if (range !== '1h' && range !== '6h') return server
    const out: MetricHistory = { ...server }
    const extra = new Map<MetricName, [number, number][]>()
    for (const p of live) {
      if (p.ts <= (server[p.metric]?.at(-1)?.[0] ?? 0)) continue
      let list = extra.get(p.metric)
      if (!list) extra.set(p.metric, (list = []))
      list.push([p.ts, p.value])
    }
    for (const [m, pts] of extra) out[m] = [...(server[m] ?? []), ...pts]
    return out
  }, [server, live, range])
  return { series, loaded, now }
}
