import { useState, type ReactNode } from 'react'
import { useMetricHistory } from '~/lib/history'
import { bytes, num, rate } from '~/lib/format'
import { HISTORY_RANGES, type HistoryRange, type MetricHistory, type MetricName, type Snapshot } from '~/shared/types'
import { recentlyDragged } from './EditableGrid'
import { Gauge } from './Gauge'
import { HistoryChart } from './HistoryChart'
import { Modal } from './Modal'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'

export type MetricCardId = 'cpu' | 'ram' | 'temp' | 'net' | 'gpu'

type Unit = 'pct' | 'temp' | 'rate'

interface ChartDef {
  title: string
  unit: Unit
  series: { metric: MetricName; label: string; color: string }[]
}

const ACCENT = '#7cc4b8'
const VIOLET = '#b4a0ff'
const AMBER = '#e3b341'

const FORMAT: Record<Unit, (v: number) => string> = {
  pct: (v) => `${num(v * 100, v < 0.1 ? 1 : 0)} %`,
  temp: (v) => `${num(v, 0)} °C`,
  rate: (v) => rate(v),
}
const RANGE: Record<Unit, { yMin?: number; yMax?: number }> = { pct: { yMin: 0, yMax: 1 }, temp: {}, rate: { yMin: 0 } }

const RANGE_LABEL: Record<HistoryRange, () => string> = { "1h": m.overview_metrics_ranges_1h, "6h": m.overview_metrics_ranges_6h, "24h": m.overview_metrics_ranges_24h, "7d": m.overview_metrics_ranges_7d }

function charts(id: MetricCardId, gpuClock: boolean): ChartDef[] {
  switch (id) {
    case 'cpu':
      return [{ title: m.overview_metrics_utilization(), unit: 'pct', series: [{ metric: 'cpu', label: 'CPU', color: ACCENT }] }]
    case 'ram':
      return [{ title: m.overview_metrics_used(), unit: 'pct', series: [{ metric: 'ram', label: 'RAM', color: ACCENT }] }]
    case 'temp':
      return [{ title: m.overview_metrics_temperature(), unit: 'temp', series: [{ metric: 'temp', label: 'CPU', color: AMBER }] }]
    case 'net':
      return [
        {
          title: m.overview_metrics_throughput(),
          unit: 'rate',
          series: [
            { metric: 'net_rx', label: m.overview_metrics_received(), color: ACCENT },
            { metric: 'net_tx', label: m.overview_metrics_sent(), color: VIOLET },
          ],
        },
      ]
    case 'gpu':
      return [
        { title: gpuClock ? m.overview_metrics_clockShare() : m.overview_metrics_utilization(), unit: 'pct', series: [{ metric: 'gpu_util', label: gpuClock ? m.overview_metrics_clock() : 'GPU', color: ACCENT }] },
        { title: m.overview_metrics_temperature(), unit: 'temp', series: [{ metric: 'gpu_temp', label: 'GPU', color: AMBER }] },
        { title: m.overview_metrics_vram(), unit: 'pct', series: [{ metric: 'gpu_mem', label: 'VRAM', color: VIOLET }] },
      ]
  }
}

/** Card label (CPU, RAM, CPU-Temp, Netz, GPU). */
const metricLabel = (id: MetricCardId) => pickMsg({ "services": m.overview_cards_services, "storage": m.overview_cards_storage, "timers": m.overview_cards_timers, "shares": m.overview_cards_shares, "cpu": m.overview_cards_cpu, "ram": m.overview_cards_ram, "temp": m.overview_cards_temp, "net": m.overview_cards_net, "gpu": m.overview_cards_gpu }, id)

function gauge(id: MetricCardId, snapshot: Snapshot): ReactNode {
  const s = snapshot.system
  const h = snapshot.host
  switch (id) {
    case 'cpu':
      return <Gauge bare id="cpu" label="CPU" p={s?.cpu ?? 0} value={s ? FORMAT.pct(s.cpu) : '–'} sub={m.overview_metrics_cores({ n: h.cpuCores, load: (s ? num(s.load[0], 2) : '–') })} />
    case 'ram':
      return <Gauge bare id="ram" label="RAM" p={s ? s.memUsed / s.memTotal : 0} value={s ? bytes(s.memUsed) : '–'} sub={s ? m.overview_metrics_of({ total: bytes(s.memTotal, 0) }) : ''} />
    case 'temp': {
      const tp = s?.temp
      return <Gauge bare id="temp" label={m.overview_cards_temp()} p={tp ? Math.min(1, Math.max(0, (tp.celsius - 30) / 60)) : 0} value={tp ? `${Math.round(tp.celsius)} °C` : '–'} sub={tp?.sensor ?? m.overview_metrics_noSensor()} />
    }
    case 'net': {
      const netMax = s?.net.speedMbps ? (s.net.speedMbps * 1e6) / 8 : 125e6
      return (
        <Gauge
          bare
          id="net"
          label={m.overview_cards_net()}
          p={s ? Math.max(s.net.rx, s.net.tx) / netMax : 0}
          value={s ? `↓ ${rate(s.net.rx)}` : '–'}
          sub={s ? `↑ ${rate(s.net.tx)} · ${s.net.iface}${s.net.speedMbps ? ` · ${s.net.speedMbps >= 1000 ? `${s.net.speedMbps / 1000} GbE` : `${s.net.speedMbps} Mbit`}` : ''}` : ''}
        />
      )
    }
    case 'gpu': {
      const g = s?.gpus?.[0]
      const parts = [g?.tempC !== undefined ? `${Math.round(g.tempC)} °C` : '', g?.memTotal ? `VRAM ${bytes(g.memUsed ?? 0)}/${bytes(g.memTotal, 0)}` : '', g?.powerW !== undefined ? `${num(g.powerW, 0)} W` : '']
      return (
        <Gauge
          bare
          id="gpu"
          label={g?.utilKind === 'clock' ? m.overview_metrics_gpuClock() : 'GPU'}
          p={g?.util ?? 0}
          value={g?.util !== undefined ? (g.utilKind === 'clock' && g.freqMhz ? `${g.freqMhz} MHz` : FORMAT.pct(g.util)) : '–'}
          sub={[g?.name ?? m.overview_metrics_noGpu(), ...parts].filter(Boolean).join(' · ')}
        />
      )
    }
  }
}

/**
 * Gauge with the last hour as a small chart below; a click opens the
 * detail view with longer ranges.
 */
export function MetricCard({ id, snapshot, history, now, onOpen }: { id: MetricCardId; snapshot: Snapshot; history: MetricHistory; now: number; onOpen: (id: MetricCardId) => void }) {
  const def = charts(id, snapshot.system?.gpus?.[0]?.utilKind === 'clock')[0]!
  return (
    <button
      type="button"
      className="no-drag @container flex h-full min-h-[120px] w-full cursor-pointer flex-col rounded-[inherit] text-left transition-colors duration-200 hover:bg-[rgba(255,255,255,.025)]"
      aria-label={m.overview_metrics_openHistory({ label: metricLabel(id) })}
      data-testid={`metric-card-${id}`}
      onClick={() => {
        if (!recentlyDragged()) onOpen(id)
      }}
    >
      {gauge(id, snapshot)}
      <div className="flex min-h-0 flex-1 px-4 pb-3 @max-[259px]:px-3">
        <HistoryChart
          fill
          label={m.overview_metrics_lastHour({ label: metricLabel(id) })}
          series={def.series.map((s) => ({ label: s.label, color: s.color, points: history[s.metric] ?? [] }))}
          span={HISTORY_RANGES['1h']}
          now={now}
          format={FORMAT[def.unit]}
          {...RANGE[def.unit]}
          height={40}
        />
      </div>
    </button>
  )
}

function stats(points: [number, number][]) {
  if (!points.length) return null
  let min = Infinity
  let max = -Infinity
  let sum = 0
  for (const [, v] of points) {
    min = Math.min(min, v)
    max = Math.max(max, v)
    sum += v
  }
  return { min, max, avg: sum / points.length }
}

function DetailBody({ id, snapshot }: { id: MetricCardId; snapshot: Snapshot }) {
  const [range, setRange] = useState<HistoryRange>('1h')
  const { series, loaded, now } = useMetricHistory(range)
  const defs = charts(id, snapshot.system?.gpus?.[0]?.utilKind === 'clock')
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={m.overview_metrics_range()}>
        {(Object.keys(RANGE_LABEL) as HistoryRange[]).map((r) => (
          <button key={r} type="button" className={`seg ${range === r ? 'on' : ''}`} aria-pressed={range === r} onClick={() => setRange(r)}>
            {RANGE_LABEL[r]()}
          </button>
        ))}
        {!loaded && <span className="text-[12px] text-muted">{m.overview_metrics_loading()}</span>}
      </div>
      {defs.map((d) => (
        <section key={d.title} className="flex flex-col gap-2" aria-label={d.title}>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h3 className="m-0 text-[13px] font-semibold">{d.title}</h3>
            {d.series.map((s) => {
              const st = stats((series[s.metric] ?? []).filter(([t]) => t >= now - HISTORY_RANGES[range]))
              return (
                <span key={s.metric} className="flex items-center gap-1.5 text-[12px] text-muted" data-testid={`stats-${s.metric}`}>
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {d.series.length > 1 && <span>{s.label}</span>}
                  {st ? <span className="font-mono">{m.overview_metrics_stats({ min: (FORMAT[d.unit](st.min)), avg: (FORMAT[d.unit](st.avg)), max: (FORMAT[d.unit](st.max)) })}</span> : <span>{m.overview_metrics_noData()}</span>}
                </span>
              )
            })}
          </div>
          <div className="pb-5">
            <HistoryChart
              detailed
              label={m.overview_metrics_chartLabel({ label: metricLabel(id), title: d.title, range: pickMsg({ "1h": m.overview_metrics_ranges_1h, "6h": m.overview_metrics_ranges_6h, "24h": m.overview_metrics_ranges_24h, "7d": m.overview_metrics_ranges_7d }, range) })}
              series={d.series.map((s) => ({ label: s.label, color: s.color, points: series[s.metric] ?? [] }))}
              span={HISTORY_RANGES[range]}
              now={now}
              format={FORMAT[d.unit]}
              {...RANGE[d.unit]}
              height={defs.length > 1 ? 120 : 200}
            />
          </div>
        </section>
      ))}
      <p className="m-0 text-[12px] text-muted">{m.overview_metrics_retention()}</p>
    </>
  )
}

export function MetricDialog({ id, snapshot, onClose }: { id: MetricCardId | null; snapshot: Snapshot; onClose: () => void }) {
  const g = snapshot.system?.gpus?.[0]
  const title = id === 'gpu' && g ? m.overview_metrics_gpuTitle({ name: g.name }) : id === 'temp' ? m.overview_metrics_cpuTempTitle({ sensor: snapshot.system?.temp?.sensor ?? "", hasSensor: String(snapshot.system?.temp?.sensor !== undefined) }) : id ? m.overview_metrics_historyTitle({ label: metricLabel(id) }) : ''
  return (
    <Modal open={!!id} onClose={onClose} title={title} wide>
      {id && <DetailBody id={id} snapshot={snapshot} />}
      {id === 'gpu' && g?.utilKind === 'clock' && <p className="m-0 text-[12px] text-muted">{m.overview_metrics_intelNote()}</p>}
      <div className="flex justify-end">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_close()}
        </button>
      </div>
    </Modal>
  )
}
