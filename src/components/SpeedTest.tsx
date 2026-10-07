import { useEffect, useRef, useState } from 'react'
import { api, ApiError, csrfHeaders } from '~/lib/api'
import { localeOf } from '~/shared/i18n'
import { mbps, pingStats, type SpeedResult, type SpeedSchedule } from '~/shared/speedtest'
import { HistoryChart } from './HistoryChart'
import { useGuardedApi } from './Unlock'
import { useToast } from './Toast'
import { Link } from '@tanstack/react-router'
import { m } from '~/paraglide/messages'

const SECONDS = 6
const dateFmt = (ts: number) => new Date(ts).toLocaleString(localeOf(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const num = (v: number) => v.toLocaleString(localeOf(), { maximumFractionDigits: v < 10 ? 1 : 0 })
/** Mbit/s → MB/s (8 bits per byte). */
const mbyte = (mbit: number) => mbit / 8

type Phase = 'ping' | 'down' | 'up'
type Live = { phase: Phase; value: number; done: number; samples: number[] }

// ---------- measuring in the browser (this device ↔ server) ----------

async function run(phase: Phase, onTick: (value: number, done: number) => void, work: (signal: AbortSignal, add: (n: number) => void) => Promise<void>): Promise<number> {
  const ctrl = new AbortController()
  let bytes = 0
  const start = performance.now()
  const tick = setInterval(() => onTick(mbps(bytes, performance.now() - start), Math.min(1, (performance.now() - start) / (SECONDS * 1000))), 200)
  const stop = setTimeout(() => ctrl.abort(), SECONDS * 1000)
  const worker = async () => {
    while (!ctrl.signal.aborted && performance.now() - start < SECONDS * 1000)
      try {
        await work(ctrl.signal, (n) => (bytes += n))
      } catch (e) {
        if (!ctrl.signal.aborted) throw e
      }
  }
  try {
    await Promise.all([worker(), worker(), worker(), worker()])
  } finally {
    clearInterval(tick)
    clearTimeout(stop)
  }
  return mbps(bytes, performance.now() - start)
}

async function clientTest(report: (phase: Phase, value: number, done: number) => void) {
  const times: number[] = []
  for (let i = 0; i < 10; i++) {
    const t = performance.now()
    await fetch('/api/speedtest?ping', { cache: 'no-store' }).then((r) => r.arrayBuffer())
    times.push(performance.now() - t)
    report('ping', Math.round(times.at(-1)!), (i + 1) / 10)
  }
  const down = await run(
    'down',
    (v, d) => report('down', v, d),
    async (signal, add) => {
      const r = await fetch(`/api/speedtest?down=${100 * 1024 * 1024}`, { cache: 'no-store', signal })
      const reader = r.body!.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        add(value.length)
      }
    },
  )
  // fetch has no upload progress: requests grow while one takes less than a second.
  let size = 1024 * 1024
  const up = await run(
    'up',
    (v, d) => report('up', v, d),
    async (signal, add) => {
      const t = performance.now()
      const r = await fetch('/api/speedtest?up', { method: 'POST', body: new Uint8Array(size), headers: { 'content-type': 'application/octet-stream', ...csrfHeaders() }, signal, cache: 'no-store' })
      if (!r.ok) throw new Error(m.common_http({ status: r.status }))
      add(((await r.json()) as { bytes: number }).bytes)
      if (performance.now() - t < 1000 && size < 32 * 1024 * 1024) size *= 2
    },
  )
  return { down, up, ...pingStats(times) }
}

/** Server ↔ internet: measured on the server, progress arrives line by line. */
async function internetTest(report: (phase: Phase, value: number, done: number) => void): Promise<SpeedResult[]> {
  const r = await fetch('/api/speedtest', { method: 'POST', headers: { 'content-type': 'application/json', ...csrfHeaders() }, body: JSON.stringify({ internet: true }) })
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(r.status, d.error ?? m.common_http({ status: r.status }))
  }
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = JSON.parse(buf.slice(0, nl)) as { phase?: Phase; value?: number; done?: number; history?: SpeedResult[]; error?: string }
      buf = buf.slice(nl + 1)
      if (line.error) throw new Error(line.error)
      if (line.history) return line.history
      if (line.phase) report(line.phase, line.value ?? 0, line.done ?? 0)
    }
  }
  throw new Error(m.speed_error_aborted())
}

// ---------- the gauge ----------

const MAX = 10000
const TICKS = [0, 10, 50, 100, 250, 500, 1000, 2500, 10000]
/** Logarithmic: 10 Mbit/s and 10 Gbit/s both readable. */
const pos = (v: number) => Math.min(1, Math.log10(1 + Math.max(0, v)) / Math.log10(1 + MAX))
const START = 150
const SWEEP = 240
const R = 84
const point = (frac: number, r = R) => {
  const a = ((START + SWEEP * frac) * Math.PI) / 180
  return [110 + r * Math.cos(a), 110 + r * Math.sin(a)] as const
}
const ARC = (() => {
  const [x1, y1] = point(0)
  const [x2, y2] = point(1)
  return `M ${x1} ${y1} A ${R} ${R} 0 1 1 ${x2} ${y2}`
})()

const COLORS: Record<Phase, [string, string]> = { ping: ['#8b949e', '#c9d1d9'], down: ['color-mix(in srgb, var(--color-accent) 78%, black)', 'var(--color-accent)'], up: ['color-mix(in srgb, var(--color-accent-2) 78%, black)', 'var(--color-accent-2)'] }

function Gauge({ live, idle }: { live: Live | null; idle?: SpeedResult }) {
  const phase = live?.phase ?? 'down'
  const value = live ? (live.phase === 'ping' ? 0 : live.value) : (idle?.down ?? 0)
  const frac = pos(value)
  const [c1, c2] = COLORS[phase]
  const gid = `g-${phase}`
  return (
    <svg viewBox="0 0 220 200" className="w-full max-w-[340px]" role="img" aria-label={m.speed_gauge()}>
      <defs>
        <linearGradient id={gid} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor={c1} />
          <stop offset="1" stopColor={c2} />
        </linearGradient>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path d={ARC} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="14" strokeLinecap="round" />
      <path d={ARC} fill="none" stroke={`url(#${gid})`} strokeWidth="14" strokeLinecap="round" pathLength={100} strokeDasharray={`${frac * 100} 100`} filter="url(#glow)" style={{ transition: 'stroke-dasharray .35s ease-out' }} />
      {TICKS.map((t) => {
        const [x1, y1] = point(pos(t), R - 12)
        const [x2, y2] = point(pos(t), R - 18)
        const [tx, ty] = point(pos(t), R - 30)
        return (
          <g key={t}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,.25)" strokeWidth="1.5" />
            <text x={tx} y={ty + 3} textAnchor="middle" fontSize="8" fill="#8b949e" fontFamily="ui-monospace, monospace">
              {t >= 1000 ? `${t / 1000}G` : t}
            </text>
          </g>
        )
      })}
      <g style={{ transform: `rotate(${START + SWEEP * frac}deg)`, transformOrigin: '110px 110px', transition: 'transform .35s cubic-bezier(.3,1.4,.6,1)' }}>
        <line x1="110" y1="110" x2={110 + R - 24} y2="110" stroke={c2} strokeWidth="3" strokeLinecap="round" />
      </g>
      <circle cx="110" cy="110" r="6" fill="var(--color-bg)" stroke={c2} strokeWidth="2" />
      <text x="110" y="172" textAnchor="middle" fontSize="24" fontWeight="600" fill="#e6edf3" fontFamily="ui-monospace, monospace" data-testid="gauge-value">
        {live?.phase === 'ping' ? `${num(live.value)}` : num(value)}
      </text>
      <text x="110" y="187" textAnchor="middle" fontSize="9" fill="#8b949e">
        {live?.phase === 'ping' ? 'ms' : `Mbit/s · ${num(mbyte(value))} MB/s`}
      </text>
    </svg>
  )
}

function Sparkline({ samples, phase }: { samples: number[]; phase: Phase }) {
  if (samples.length < 2) return <div className="h-[36px]" />
  const max = Math.max(...samples, 1)
  const pts = samples.map((v, i) => `${(i / (samples.length - 1)) * 300},${36 - (v / max) * 32}`).join(' ')
  return (
    <svg viewBox="0 0 300 36" className="h-[36px] w-full" preserveAspectRatio="none" aria-hidden>
      <polyline points={`0,36 ${pts} 300,36`} fill={COLORS[phase][0]} opacity=".15" />
      <polyline points={pts} fill="none" stroke={COLORS[phase][1]} strokeWidth="1.5" />
    </svg>
  )
}

// ---------- page ----------

/**
 * Speed test: this device ↔ the server (Wi-Fi/LAN to the server) and the
 * server ↔ the internet (through Cloudflare), with a live gauge, both units
 * (Mbit/s and MB/s) and a history.
 */
export function SpeedTest() {
  const [history, setHistory] = useState<SpeedResult[]>([])
  const [busy, setBusy] = useState<'client' | 'internet' | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [error, setError] = useState('')
  const mounted = useRef(true)

  const [info, setInfo] = useState<Info | null>(null)
  const load = async () => {
    try {
      const d = (await (await fetch('/api/speedtest')).json()) as Info & { history?: SpeedResult[] }
      if (!mounted.current) return
      setHistory(d.history ?? [])
      setInfo(d)
    } catch {
      // shown again on the next try
    }
  }
  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const report = (phase: Phase, value: number, done: number) => {
    if (!mounted.current) return
    setLive((l) => ({ phase, value, done, samples: l && l.phase === phase ? [...l.samples, value].slice(-60) : [value] }))
  }

  const start = async (kind: 'client' | 'internet') => {
    setBusy(kind)
    setError('')
    setLive({ phase: 'ping', value: 0, done: 0, samples: [] })
    try {
      const h = kind === 'internet' ? await internetTest(report) : (await api<{ history: SpeedResult[] }>('/api/speedtest', { body: { client: { ...(await clientTest(report)), where: browserName() } } })).history
      if (mounted.current) setHistory(h)
      void load()
    } catch (e) {
      if (mounted.current) setError((e as Error).message)
    } finally {
      if (mounted.current) {
        setBusy(null)
        setLive(null)
      }
    }
  }

  const last = (kind: 'client' | 'internet') => history.find((h) => h.kind === kind)

  const card = (kind: 'client' | 'internet', title: string, text: string) => {
    const r = last(kind)
    const running = busy === kind
    return (
      <section className="panel flex flex-col gap-3 p-[18px]" aria-label={title} data-testid={`speed-${kind}`}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="h2 grow">{title}</h2>
          <button type="button" className="btn primary" disabled={!!busy} onClick={() => void start(kind)}>
            {running ? m.speed_running() : r ? m.speed_again() : m.speed_start()}
          </button>
        </div>
        <p className="m-0 text-[13px] text-muted">{text}</p>
        <div className="flex flex-col items-center gap-1">
          <Gauge live={running ? live : null} idle={r} />
          <ol className="m-0 flex list-none gap-1.5 p-0 text-[12px]" aria-label={m.speed_phases()}>
            {(['ping', 'down', 'up'] as const).map((p) => {
              const order = ['ping', 'down', 'up'].indexOf(p)
              const at = running && live ? ['ping', 'down', 'up'].indexOf(live.phase) : -1
              const state = !running ? 'idle' : order < at ? 'done' : order === at ? 'now' : 'next'
              return (
                <li key={p} className={`relative overflow-hidden rounded-full border px-3 py-1 ${state === 'now' ? 'border-accent/60 text-fg' : state === 'done' ? 'border-line text-[#7ee2a8]' : 'border-line text-muted'}`}>
                  {state === 'now' && <span className="absolute inset-y-0 left-0 bg-accent/15" style={{ width: `${(live?.done ?? 0) * 100}%`, transition: 'width .2s linear' }} />}
                  <span className="relative">
                    {state === 'done' ? '✓ ' : ''}
                    {p === 'ping' ? m.speed_ping() : p === 'down' ? `↓ ${m.speed_down()}` : `↑ ${m.speed_up()}`}
                  </span>
                </li>
              )
            })}
          </ol>
          {running && live && live.phase !== 'ping' && <Sparkline samples={live.samples} phase={live.phase} />}
        </div>
        {!running && r && (
          <div className="grid grid-cols-2 gap-3" data-testid="speed-result">
            <Big label={`↓ ${m.speed_down()}`} mbit={r.down} color="var(--color-accent)" />
            <Big label={`↑ ${m.speed_up()}`} mbit={r.up} color="var(--color-accent-2)" />
            <Small label={m.speed_ping()} value={`${num(r.ping)} ms`} />
            <Small label={m.speed_jitter()} value={`${num(r.jitter)} ms`} />
          </div>
        )}
        {!running && r && <p className="m-0 text-[12px] text-muted">{m.speed_measuredAt({ date: dateFmt(r.at), where: r.where ?? '–' })}</p>}
        {!running && !r && <p className="m-0 text-center text-[13px] text-muted">{m.speed_none()}</p>}
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-[18px]">
      {error && (
        <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
          {error}
        </p>
      )}
      <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-2">
        {card('client', m.speed_client_title(), m.speed_client_text())}
        {card('internet', m.speed_internet_title(), m.speed_internet_text())}
      </div>
      <p className="m-0 text-[12px] text-muted">{m.speed_units()}</p>
      {info?.alert && (
        <p role="alert" className="m-0 rounded-[10px] border border-[rgba(210,153,34,.5)] bg-[rgba(210,153,34,.08)] p-3 text-[13px] text-[#e3b341]">
          {info.alert}
        </p>
      )}
      {info && <SpeedChart series={info.series} />}
      {info && <AutoPanel schedule={info.schedule} next={info.next} onSaved={() => void load()} />}
      {history.length > 0 && (
        <section className="panel flex flex-col overflow-x-auto" aria-label={m.speed_history()}>
          <h2 className="h2 px-[18px] pt-4 pb-2">{m.speed_history()}</h2>
          <table className="tbl">
            <thead>
              <tr>
                <th>{m.speed_when()}</th>
                <th>{m.speed_what()}</th>
                <th className="text-right">↓ {m.speed_down()}</th>
                <th className="text-right">↑ {m.speed_up()}</th>
                <th className="text-right">{m.speed_ping()}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={`${h.at}-${h.kind}`} data-testid="speed-row">
                  <td className="font-mono text-[12px]">{dateFmt(h.at)}</td>
                  <td className="text-[13px]">
                    {h.kind === 'internet' ? m.speed_internet_short() : m.speed_client_short()}
                    {h.where && <span className="text-muted"> · {h.where}</span>}
                    {h.auto && <span className="chip ml-1.5">{m.speed_auto_badge()}</span>}
                  </td>
                  <td className="text-right font-mono text-[12px]">
                    {num(h.down)} Mbit/s <span className="text-muted">· {num(mbyte(h.down))} MB/s</span>
                  </td>
                  <td className="text-right font-mono text-[12px]">
                    {num(h.up)} Mbit/s <span className="text-muted">· {num(mbyte(h.up))} MB/s</span>
                  </td>
                  <td className="text-right font-mono text-[12px]">{num(h.ping)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

type Info = { schedule: SpeedSchedule; next?: number; series: Record<'down' | 'up' | 'ping', [number, number][]>; alert?: string }

const RANGES = [7, 30, 90, 365]

/** Download and upload over the days, ping below; the same chart as the overview. */
function SpeedChart({ series }: { series: Info['series'] }) {
  const [days, setDays] = useState(30)
  const now = Date.now()
  const span = days * 86_400_000
  const any = series.down.some(([t]) => t >= now - span)
  return (
    <section className="panel flex flex-col gap-3 p-[18px]" aria-label={m.speed_chart_title()} data-testid="speed-chart">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="h2 grow">{m.speed_chart_title()}</h2>
        <div role="group" aria-label={m.speed_chart_range()} className="flex gap-1">
          {RANGES.map((d) => (
            <button key={d} type="button" className={`seg ${d === days ? 'on' : ''}`} aria-pressed={d === days} onClick={() => setDays(d)}>
              {m.speed_chart_days({ n: d })}
            </button>
          ))}
        </div>
      </div>
      {any ? (
        <>
          <HistoryChart
            detailed
            height={180}
            span={span}
            now={now}
            label={m.speed_chart_title()}
            yMin={0}
            format={(v) => `${num(v)} Mbit/s · ${num(mbyte(v))} MB/s`}
            series={[
              { label: `↓ ${m.speed_down()}`, color: 'var(--color-accent)', points: series.down },
              { label: `↑ ${m.speed_up()}`, color: 'var(--color-accent-2)', points: series.up },
            ]}
          />
          <HistoryChart detailed height={60} span={span} now={now} label={m.speed_ping()} yMin={0} format={(v) => `${num(v)} ms`} series={[{ label: m.speed_ping(), color: '#8b949e', points: series.ping }]} />
        </>
      ) : (
        <p className="m-0 text-[13px] text-muted">{m.speed_chart_empty()}</p>
      )}
    </section>
  )
}

/** Measure the internet connection on a schedule (off by default). */
function AutoPanel({ schedule, next, onSaved }: { schedule: SpeedSchedule; next?: number; onSaved: () => void }) {
  const guarded = useGuardedApi()
  const say = useToast()
  const [s, setS] = useState(schedule)
  useEffect(() => setS(schedule), [schedule])
  const save = async (v: SpeedSchedule) => {
    setS(v)
    try {
      if (await guarded('/api/speedtest', { body: { schedule: v } })) {
        say(m.speed_auto_saved())
        onSaved()
      } else setS(schedule)
    } catch (e) {
      say((e as Error).message, 'bad')
      setS(schedule)
    }
  }
  return (
    <section className="panel flex flex-col gap-3 p-[18px]" aria-label={m.speed_auto_title()} data-testid="speed-auto">
      <h2 className="h2">{m.speed_auto_title()}</h2>
      <p className="m-0 text-[13px] text-muted">{m.speed_auto_text()}</p>
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.enabled} onChange={(e) => void save({ ...s, enabled: e.target.checked })} />
          <span className="font-medium">{m.speed_auto_enabled()}</span>
        </label>
        <select className="field !w-auto !py-1" aria-label={m.speed_auto_every()} value={s.every} disabled={!s.enabled} onChange={(e) => void save({ ...s, every: e.target.value as SpeedSchedule['every'] })}>
          <option value="daily">{m.speed_auto_daily()}</option>
          <option value="6h">{m.speed_auto_6h()}</option>
        </select>
        <select className="field !w-auto !py-1" aria-label={m.speed_auto_hour()} value={s.hour} disabled={!s.enabled} onChange={(e) => void save({ ...s, hour: Number(e.target.value) })}>
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, '0')}:00
            </option>
          ))}
        </select>
        {s.enabled && next && <span className="text-[12px] text-muted">{m.speed_auto_next({ date: dateFmt(next) })}</span>}
      </div>
      <p className="m-0 text-[12px] text-muted">{m.speed_auto_data()}</p>
      <Link to="/notifications" className="self-start text-[13px] text-accent hover:underline">
        {m.speed_auto_notify()} →
      </Link>
    </section>
  )
}

function Big({ label, mbit, color }: { label: string; mbit: number; color: string }) {
  return (
    <div className="flex flex-col rounded-[10px] border border-line p-3">
      <span className="text-[11px] tracking-wide text-muted uppercase">{label}</span>
      <span className="font-mono text-[26px] leading-tight" style={{ color }}>
        {num(mbit)} <span className="text-[13px] text-muted">Mbit/s</span>
      </span>
      <span className="font-mono text-[13px] text-muted">= {num(mbyte(mbit))} MB/s</span>
    </div>
  )
}

function Small({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between rounded-[10px] border border-line px-3 py-2">
      <span className="text-[11px] tracking-wide text-muted uppercase">{label}</span>
      <span className="font-mono text-[15px]">{value}</span>
    </div>
  )
}

function browserName(): string {
  const ua = navigator.userAgent
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ''
  return [b, os].filter(Boolean).join(' · ')
}
