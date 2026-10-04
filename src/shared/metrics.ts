import type { MetricName, SystemMetrics } from './types'

/** The stored metrics of one live sample (GPU: the first one). Used by the hub and for live points in charts. */
export function metricRows(s: SystemMetrics): { ts: number; metric: MetricName; value: number }[] {
  const rows: { metric: MetricName; value: number | undefined }[] = [
    { metric: 'cpu', value: s.cpu },
    { metric: 'ram', value: s.memTotal ? s.memUsed / s.memTotal : undefined },
    { metric: 'net_rx', value: s.net.rx },
    { metric: 'net_tx', value: s.net.tx },
    { metric: 'temp', value: s.temp?.celsius },
    { metric: 'power', value: s.powerW },
  ]
  const g = s.gpus?.[0]
  if (g) {
    rows.push({ metric: 'gpu_util', value: g.util })
    rows.push({ metric: 'gpu_mem', value: g.memUsed !== undefined && g.memTotal ? g.memUsed / g.memTotal : undefined })
    rows.push({ metric: 'gpu_temp', value: g.tempC })
  }
  return rows.filter((r): r is { metric: MetricName; value: number } => r.value !== undefined && Number.isFinite(r.value)).map((r) => ({ ...r, ts: s.ts }))
}
