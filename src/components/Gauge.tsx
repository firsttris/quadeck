const C = 2 * Math.PI * 34

/** Ring gauge with glow; turns yellow above 70 % and red above 85 %, glides to new values. */
export function Gauge({ id, label, value, sub, p, bare }: { id: string; label: string; value: string; sub: string; p: number; bare?: boolean }) {
  const clamped = Math.max(0, Math.min(1, p || 0))
  const color = clamped > 0.85 ? '#f85149' : clamped > 0.7 ? '#d29922' : '#7cc4b8'
  return (
    // Narrow cards (container query on the card): smaller ring and text, stacked when very narrow.
    <div className={`${bare ? '' : 'panel'} flex items-center gap-4 p-4 @max-[259px]:gap-3 @max-[259px]:p-3 @max-[169px]:flex-col @max-[169px]:items-start @max-[169px]:gap-2`} data-testid={`gauge-${id}`}>
      <svg viewBox="0 0 84 84" className="size-[84px] shrink-0 @max-[259px]:size-[60px] @max-[169px]:size-[52px]" role="img" aria-label={`${label} ${Math.round(clamped * 100)} %`}>
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
      <div className="flex w-full min-w-0 flex-col gap-[3px]">
        <span className="label-caps">{label}</span>
        <span className="truncate font-cond text-[22px] font-semibold tabular-nums @max-[259px]:text-[18px]">{value}</span>
        <span className="truncate font-mono text-[11px] text-muted @max-[259px]:text-[10px]">{sub}</span>
      </div>
    </div>
  )
}
