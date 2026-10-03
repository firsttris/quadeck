import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { localeOf } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

export interface ChartSeries {
  label: string
  color: string
  points: [number, number][]
}

export interface ChartProps {
  series: ChartSeries[]
  /** Time window ending at `now`. */
  span: number
  now: number
  format: (v: number) => string
  /** Fixed y range (e.g. 0..1 for percent); otherwise from the data. */
  yMin?: number
  yMax?: number
  /** Take the height of the surrounding box instead of `height` (min. 16 px, otherwise hidden). */
  fill?: boolean
  height?: number
  /** Axis labels and hover tooltip (detail view). */
  detailed?: boolean
  label: string
}

/** Index of the point nearest to ts (points sorted by time). */
function nearest(points: [number, number][], ts: number) {
  let lo = 0
  let hi = points.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid]![0] < ts) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(points[lo - 1]![0] - ts) < Math.abs(points[lo]![0] - ts)) lo--
  return lo
}

/** Smooth path through the points without overshooting (monotone cubic, Fritsch–Carlson). */
export function smoothPath(pts: [number, number][]): string {
  const n = pts.length
  if (n === 0) return ''
  const f = (v: number) => v.toFixed(1)
  if (n < 3) return 'M' + pts.map(([a, b]) => `${f(a)},${f(b)}`).join('L')
  const dx: number[] = []
  const m: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1]![0] - pts[i]![0] || 1e-6)
    m.push((pts[i + 1]![1] - pts[i]![1]) / dx[i]!)
  }
  const t: number[] = [m[0]!]
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1]! * m[i]! <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / m[i - 1]! + (dx[i]! + 2 * dx[i - 1]!) / m[i]!))
  t.push(m[n - 2]!)
  let d = `M${f(pts[0]![0])},${f(pts[0]![1])}`
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!
    const [x1, y1] = pts[i + 1]!
    const h = dx[i]! / 3
    d += `C${f(x0 + h)},${f(y0 + t[i]! * h)} ${f(x1 - h)},${f(y1 - t[i + 1]! * h)} ${f(x1)},${f(y1)}`
  }
  return d
}

const DAY = 24 * 3600_000
const timeLabel = (ts: number, span: number) =>
  new Date(ts).toLocaleString(
    localeOf(),
    span > 10 * DAY ? { day: '2-digit', month: '2-digit', year: span > 200 * DAY ? '2-digit' : undefined } : span > 1.5 * DAY ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' },
  )
const tooltipLabel = (ts: number, span: number) =>
  new Date(ts).toLocaleString(localeOf(), span > 10 * DAY ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/**
 * Area chart over a time window. Gaps in the data (Quadeck was not running)
 * stay gaps instead of being bridged by a straight line.
 */
export function HistoryChart({ series, span, now, format, yMin, yMax, height = 44, detailed = false, label, fill = false }: ChartProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [boxH, setBoxH] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const uid = useId().replace(/:/g, '')

  useEffect(() => {
    const el = wrap.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const read = () => {
      setWidth(el.clientWidth)
      setBoxH(el.clientHeight)
    }
    const ro = new ResizeObserver(read)
    ro.observe(el)
    read()
    return () => ro.disconnect()
  }, [])

  const start = now - span
  const visible = useMemo(() => series.map((s) => ({ ...s, points: s.points.filter(([t]) => t >= start && t <= now + 5000) })), [series, start, now])
  const all = visible.flatMap((s) => s.points.map((p) => p[1]))
  const dataMin = all.length ? Math.min(...all) : 0
  const dataMax = all.length ? Math.max(...all) : 1
  const lo = yMin ?? Math.floor(dataMin - Math.max(2, (dataMax - dataMin) * 0.15))
  const hi = yMax ?? (dataMax > lo ? dataMax + (dataMax - lo) * 0.12 : lo + 1)
  const padTop = detailed ? 8 : 3
  // fill: as tall as the box it sits in (cards resized by the user).
  const h = fill && boxH > 0 ? boxH : height
  const x = (t: number) => ((t - start) / span) * width
  const y = (v: number) => padTop + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (h - padTop - 1)
  // A gap is anything longer than three of the usual steps (and at least 90 s).
  const gap = useMemo(() => {
    const steps = visible.flatMap((v) => v.points.slice(1).map((p, i) => p[0] - v.points[i]![0])).sort((a, b) => a - b)
    const median = steps.length ? steps[steps.length >> 1]! : 0
    return Math.max(90_000, (span / 300) * 3, median * 3)
  }, [visible, span])

  const paths = useMemo(
    () =>
      visible.map((s) => {
        const segs: [number, number][][] = []
        let cur: [number, number][] = []
        for (let i = 0; i < s.points.length; i++) {
          const p = s.points[i]!
          if (i > 0 && p[0] - s.points[i - 1]![0] > gap) {
            if (cur.length) segs.push(cur)
            cur = []
          }
          cur.push([x(p[0]), y(p[1])])
        }
        if (cur.length) segs.push(cur)
        const line = segs.map(smoothPath).join('')
        const area = segs.map((seg) => smoothPath(seg).replace(/^M/, `M${seg[0]![0].toFixed(1)},${h}L`) + `L${seg[seg.length - 1]![0].toFixed(1)},${h}Z`).join('')
        return { ...s, line, area, last: segs.at(-1)?.at(-1) }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, width, lo, hi, h],
  )

  const hoverTs = hover !== null ? start + (hover / width) * span : null
  const hoverRows =
    hoverTs !== null
      ? visible
          .map((s) => {
            if (!s.points.length) return null
            const p = s.points[nearest(s.points, hoverTs)]!
            return Math.abs(p[0] - hoverTs) <= gap ? { s, p } : null
          })
          .filter((r): r is NonNullable<typeof r> => !!r)
      : []

  const empty = all.length === 0
  return (
    <div className={detailed ? 'flex w-full gap-2' : 'w-full'}>
      {detailed && (
        <div className="relative w-[58px] shrink-0 font-mono text-[10px] text-subtle" style={{ height: h }} aria-hidden>
          <span className="absolute right-0" style={{ top: padTop - 6 }}>
            {format(hi)}
          </span>
          <span className="absolute right-0" style={{ top: padTop + (h - padTop - 1) / 2 - 6 }}>
            {format((hi + lo) / 2)}
          </span>
          <span className="absolute right-0 bottom-[-5px]">{format(lo)}</span>
        </div>
      )}
      <div ref={wrap} className="relative min-w-0 grow" style={{ height: fill ? '100%' : h }} role="img" aria-label={label}>
        {width > 0 && h >= 16 && (
          <svg
            width={width}
            height={h}
            className="block overflow-visible"
            onPointerMove={detailed ? (e) => setHover(e.clientX - e.currentTarget.getBoundingClientRect().left) : undefined}
            onPointerLeave={detailed ? () => setHover(null) : undefined}
          >
            {detailed && [0, 0.5, 1].map((f) => <line key={f} x1={0} x2={width} y1={padTop + f * (h - padTop - 1)} y2={padTop + f * (h - padTop - 1)} stroke="#1d242d" strokeDasharray={f === 1 ? undefined : '3 4'} />)}
            <defs>
              {paths.map((p, i) => (
                <linearGradient key={p.label} id={`${uid}-g${i}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={p.color} stopOpacity={detailed ? 0.28 : 0.22} />
                  <stop offset="100%" stopColor={p.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            {/* key: draw in again when the range changes */}
            <g key={span} className="chart-in">
              {paths.map((p, i) => (
                <g key={p.label}>
                  <path d={p.area} fill={`url(#${uid}-g${i})`} className="chart-area" />
                  <path d={p.line} fill="none" stroke={p.color} strokeWidth={detailed ? 1.8 : 1.5} strokeLinejoin="round" strokeLinecap="round" pathLength={1} className="chart-line" />
                </g>
              ))}
            </g>
            {!detailed &&
              paths.map(
                (p) =>
                  p.last &&
                  p.last[0] > width - 24 && (
                    <g key={p.label} transform={`translate(${p.last[0].toFixed(1)} ${p.last[1].toFixed(1)})`} className="chart-dot">
                      <circle r={5} fill={p.color} className="chart-pulse" />
                      <circle r={2.4} fill={p.color} />
                    </g>
                  ),
              )}
            {hoverTs !== null && hoverRows.length > 0 && (
              <g>
                <line x1={hover!} x2={hover!} y1={0} y2={h} stroke="#3a4350" />
                {hoverRows.map(({ s, p }) => (
                  <circle key={s.label} cx={x(p[0])} cy={y(p[1])} r={3.2} fill={s.color} stroke="#0b0f14" strokeWidth={1.5} />
                ))}
              </g>
            )}
          </svg>
        )}
        {detailed && width > 0 && (
          <>
            <div className="pointer-events-none absolute -bottom-5 left-0 flex w-full justify-between font-mono text-[10px] text-subtle">
              <span>{timeLabel(start, span)}</span>
              <span>{timeLabel(start + span / 2, span)}</span>
              <span>{m.overview_chart_now()}</span>
            </div>
          </>
        )}
        {detailed && hoverTs !== null && hoverRows.length > 0 && (
          <div
            className="pointer-events-none absolute top-1 z-10 rounded-lg border border-edge bg-[#141a22] px-2.5 py-1.5 text-[12px] shadow-lg"
            style={hover! > width / 2 ? { right: width - hover! + 10 } : { left: hover! + 10 }}
            role="tooltip"
          >
            <div className="font-mono text-[11px] text-muted">{tooltipLabel(hoverRows[0]!.p[0], span)}</div>
            {hoverRows.map(({ s, p }) => (
              <div key={s.label} className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.label}: <span className="font-mono">{format(p[1])}</span>
              </div>
            ))}
          </div>
        )}
        {detailed && empty && width > 0 && <div className="absolute inset-0 flex items-center justify-center text-[13px] text-muted">{m.overview_chart_empty()}</div>}
      </div>
    </div>
  )
}
