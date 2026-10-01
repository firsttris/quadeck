/** Live sparkline: moves left with every update, glowing end point. Values in percent. */
export function Sparkline({ values, width = 96, height = 26 }: { values: number[]; width?: number; height?: number }) {
  const v = values.length >= 2 ? values : [0, ...(values.length ? values : [0])]
  const max = Math.max(100, ...v)
  const pts = v.map((x, i) => [(i * width) / (v.length - 1), height - 2 - (Math.max(0, x) / max) * (height - 4)] as const)
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const end = pts[pts.length - 1]!
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polygon points={`0,${height} ${line} ${width},${height}`} fill="rgba(124,196,184,.12)" />
      <polyline points={line} fill="none" stroke="#7cc4b8" strokeWidth="1.6" style={{ filter: 'drop-shadow(0 0 3px rgba(124,196,184,.8))' }} />
      <circle cx={end[0]} cy={end[1]} r="2.4" fill="#a6dcd2" />
    </svg>
  )
}
