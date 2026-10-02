import { useState, type ReactNode } from 'react'
import { useMetricHistory } from '~/lib/history'
import { bytes, num, rate } from '~/lib/format'
import { HISTORY_RANGES, type HistoryRange, type MetricHistory, type MetricName, type Snapshot } from '~/shared/types'
import { recentlyDragged } from './EditableGrid'
import { Gauge } from './Gauge'
import { HistoryChart } from './HistoryChart'
import { Modal } from './Modal'

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

function charts(id: MetricCardId, gpuClock: boolean): ChartDef[] {
  switch (id) {
    case 'cpu':
      return [{ title: 'Auslastung', unit: 'pct', series: [{ metric: 'cpu', label: 'CPU', color: ACCENT }] }]
    case 'ram':
      return [{ title: 'Belegt', unit: 'pct', series: [{ metric: 'ram', label: 'RAM', color: ACCENT }] }]
    case 'temp':
      return [{ title: 'Temperatur', unit: 'temp', series: [{ metric: 'temp', label: 'CPU', color: AMBER }] }]
    case 'net':
      return [
        {
          title: 'Durchsatz',
          unit: 'rate',
          series: [
            { metric: 'net_rx', label: 'Empfangen', color: ACCENT },
            { metric: 'net_tx', label: 'Gesendet', color: VIOLET },
          ],
        },
      ]
    case 'gpu':
      return [
        { title: gpuClock ? 'Takt (Anteil am Maximum)' : 'Auslastung', unit: 'pct', series: [{ metric: 'gpu_util', label: gpuClock ? 'Takt' : 'GPU', color: ACCENT }] },
        { title: 'Temperatur', unit: 'temp', series: [{ metric: 'gpu_temp', label: 'GPU', color: AMBER }] },
        { title: 'Grafikspeicher', unit: 'pct', series: [{ metric: 'gpu_mem', label: 'VRAM', color: VIOLET }] },
      ]
  }
}

export const METRIC_LABEL: Record<MetricCardId, string> = { cpu: 'CPU', ram: 'RAM', temp: 'CPU-Temp', net: 'Netz', gpu: 'GPU' }

function gauge(id: MetricCardId, snapshot: Snapshot): ReactNode {
  const s = snapshot.system
  const h = snapshot.host
  switch (id) {
    case 'cpu':
      return <Gauge bare id="cpu" label="CPU" p={s?.cpu ?? 0} value={s ? FORMAT.pct(s.cpu) : '–'} sub={`${h.cpuCores} Kerne · Load ${s ? num(s.load[0], 2) : '–'}`} />
    case 'ram':
      return <Gauge bare id="ram" label="RAM" p={s ? s.memUsed / s.memTotal : 0} value={s ? bytes(s.memUsed) : '–'} sub={s ? `von ${bytes(s.memTotal, 0)}` : ''} />
    case 'temp': {
      const t = s?.temp
      return <Gauge bare id="temp" label="CPU-Temp" p={t ? Math.min(1, Math.max(0, (t.celsius - 30) / 60)) : 0} value={t ? `${Math.round(t.celsius)} °C` : '–'} sub={t?.sensor ?? 'kein Sensor'} />
    }
    case 'net': {
      const netMax = s?.net.speedMbps ? (s.net.speedMbps * 1e6) / 8 : 125e6
      return (
        <Gauge
          bare
          id="net"
          label="Netz"
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
          label={g?.utilKind === 'clock' ? 'GPU · Takt' : 'GPU'}
          p={g?.util ?? 0}
          value={g?.util !== undefined ? (g.utilKind === 'clock' && g.freqMhz ? `${g.freqMhz} MHz` : FORMAT.pct(g.util)) : '–'}
          sub={[g?.name ?? 'keine GPU', ...parts].filter(Boolean).join(' · ')}
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
      aria-label={`${METRIC_LABEL[id]}: Verlauf öffnen`}
      data-testid={`metric-card-${id}`}
      onClick={() => {
        if (!recentlyDragged()) onOpen(id)
      }}
    >
      {gauge(id, snapshot)}
      <div className="flex min-h-0 flex-1 px-4 pb-3 @max-[259px]:px-3">
        <HistoryChart
          fill
          label={`${METRIC_LABEL[id]}, letzte Stunde`}
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

const RANGE_LABEL: Record<HistoryRange, string> = { '1h': '1 Stunde', '6h': '6 Stunden', '24h': '24 Stunden', '7d': '7 Tage' }

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
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Zeitraum">
        {(Object.keys(RANGE_LABEL) as HistoryRange[]).map((r) => (
          <button key={r} type="button" className={`seg ${range === r ? 'on' : ''}`} aria-pressed={range === r} onClick={() => setRange(r)}>
            {RANGE_LABEL[r]}
          </button>
        ))}
        {!loaded && <span className="text-[12px] text-muted">lädt …</span>}
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
                  {st ? (
                    <span className="font-mono">
                      min {FORMAT[d.unit](st.min)} · Ø {FORMAT[d.unit](st.avg)} · max {FORMAT[d.unit](st.max)}
                    </span>
                  ) : (
                    <span>keine Daten</span>
                  )}
                </span>
              )
            })}
          </div>
          <div className="pb-5">
            <HistoryChart
              detailed
              label={`${METRIC_LABEL[id]} ${d.title}, ${RANGE_LABEL[range]}`}
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
      <p className="m-0 text-[12px] text-muted">Gespeichert wird alle 30 s, 7 Tage lang. Lücken: Quadeck lief in der Zeit nicht.</p>
    </>
  )
}

export function MetricDialog({ id, snapshot, onClose }: { id: MetricCardId | null; snapshot: Snapshot; onClose: () => void }) {
  const g = snapshot.system?.gpus?.[0]
  const title = id === 'gpu' && g ? `GPU · ${g.name}` : id === 'temp' ? `CPU-Temperatur${snapshot.system?.temp ? ` · ${snapshot.system.temp.sensor}` : ''}` : id ? `${METRIC_LABEL[id]}-Verlauf` : ''
  return (
    <Modal open={!!id} onClose={onClose} title={title} wide>
      {id && <DetailBody id={id} snapshot={snapshot} />}
      {id === 'gpu' && g?.utilKind === 'clock' && <p className="m-0 text-[12px] text-muted">Intel-iGPUs melden ohne Root-Rechte keine Auslastung – angezeigt wird der aktuelle Takt im Verhältnis zum Maximaltakt, der unter Last (z. B. Transcoding) steigt.</p>}
      <div className="flex justify-end">
        <button type="button" className="btn" onClick={onClose}>
          Schließen
        </button>
      </div>
    </Modal>
  )
}
