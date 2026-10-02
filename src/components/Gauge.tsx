const C = 2 * Math.PI * 34

/** Ring gauge with glow; turns yellow above 70 % and red above 85 %, glides to new values. */
export function Gauge({ id, label, value, sub, p }: { id: string; label: string; value: string; sub: string; p: number }) {
  const clamped = Math.max(0, Math.min(1, p || 0))
  const color = clamped > 0.85 ? '#f85149' : clamped > 0.7 ? '#d29922' : '#7cc4b8'
  return (
    <div className="panel flex items-center gap-4 p-4" data-testid={`gauge-${id}`}>
      <svg width="84" height="84" viewBox="0 0 84 84" className="shrink-0" role="img" aria-label={`${label} ${Math.round(clamped * 100)} %`}>
        <defs>
          <filter id={`glow-${id}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle cx="42" cy="42" r="34" fill="none" stroke="#1d242d" strokeWidth="7" />
        <circle
          className="ring"
          cx="42"
          cy="42"
          r="34"
          fill="none"
          stroke={color}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={C.toFixed(1)}
          strokeDashoffset={(C * (1 - clamped)).toFixed(1)}
          transform="rotate(-90 42 42)"
          filter={`url(#glow-${id})`}
        />
        <text x="42" y="47" textAnchor="middle" fill="#e6e8eb" fontFamily="IBM Plex Sans Condensed, sans-serif" fontSize="17" fontWeight="600">
          {Math.round(clamped * 100)}%
        </text>
      </svg>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className="label-caps">{label}</span>
        <span className="font-cond text-[22px] font-semibold tabular-nums">{value}</span>
        <span className="truncate font-mono text-[11px] text-muted">{sub}</span>
      </div>
    </div>
  )
}
