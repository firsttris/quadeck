// "Usage" on a disk card: the file systems on that disk, how full they are, and at what pace
// they fill up (30-day trend from the hourly fill level).

import { Link } from '@tanstack/react-router'
import { diskSize, pct } from '~/lib/format'
import { fullInUnit, perMonth, type FsTrend } from '~/shared/disk-usage'
import type { Disk } from '~/shared/types'
import { m } from '~/paraglide/messages'

/** Used share from which the bar turns yellow / red (the notification default is 90 %). */
const WARN = 0.85
const BAD = 0.9

function Spark({ values, bad }: { values: number[]; bad: boolean }) {
  if (values.length < 2) return null
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const points = values.map((v, i) => `${((i / (values.length - 1)) * 70).toFixed(1)},${(16 - ((v - lo) / span) * 14).toFixed(1)}`).join(' ')
  return (
    <svg width="70" height="18" viewBox="0 0 70 18" aria-hidden="true" className="flex-none">
      <polyline points={points} fill="none" stroke={bad ? '#f85149' : 'var(--color-accent)'} strokeWidth="1.5" />
    </svg>
  )
}

function fullIn(days: number) {
  const { n, unit } = fullInUnit(days)
  if (unit === 'days') return n <= 1 ? m.disks_usage_fullOneDay() : m.disks_usage_fullDays({ n })
  if (unit === 'weeks') return m.disks_usage_fullWeeks({ n })
  if (unit === 'months') return m.disks_usage_fullMonths({ n })
  return m.disks_usage_fullYears({ n })
}

export function TrendLine({ trend, bad }: { trend?: FsTrend; bad: boolean }) {
  if (!trend) return <span className="text-[12px] text-muted">{m.disks_usage_collecting()}</span>
  if (trend.steady) return <span className="text-[12px] text-muted">{m.disks_usage_steady()}</span>
  const month = perMonth(trend)
  const pace = month > 0 ? m.disks_usage_grows({ size: diskSize(month) }) : m.disks_usage_shrinks({ size: diskSize(-month) })
  return (
    <span className={`flex items-center gap-2 text-[12px] ${bad ? 'text-[#ff7b72]' : 'text-subtle'}`} data-testid="usage-trend">
      <Spark values={trend.spark} bad={bad} />
      <span>
        {pace}
        {trend.fullInDays !== undefined && (
          <>
            {' · '}
            <b>{fullIn(trend.fullInDays)}</b>
          </>
        )}
      </span>
    </span>
  )
}

export function DiskUsage({ name, filesystems }: { name: string; filesystems: Disk[] }) {
  return (
    <div className="flex flex-col gap-2.5 border-t border-line pt-3" aria-label={m.disks_usage_title()} role="group">
      <span className="label-caps">{m.disks_usage_title()}</span>
      {filesystems.length === 0 && (
        <span className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
          {m.disks_usage_none()}
          <Link to="/disks" search={{ tab: 'mounts' }} className="text-accent underline">
            {m.disks_usage_mount()}
          </Link>
        </span>
      )}
      {filesystems.map((f) => {
        const used = f.size ? f.used / f.size : 0
        const bad = used >= BAD || (f.trend?.fullInDays !== undefined && f.trend.fullInDays <= 14)
        const others = (f.disks ?? [f.dev]).filter((x) => x !== name)
        return (
          <div key={f.path} className="flex flex-col gap-1" data-testid="usage-fs">
            <div className="flex flex-wrap justify-between gap-x-3 text-[12.5px]">
              <span className="min-w-0 truncate">
                <span className="font-mono text-[12px]">{f.path.replace(/^\/dev\//, '')}</span> → <span className="font-mono text-[12px]">{f.mount}</span> <span className="text-muted">· {f.fstype}</span>
                {others.length > 0 && <span className="text-muted"> · {m.disks_usage_shared({ disks: others.join(', ') })}</span>}
              </span>
              <span className={bad ? 'text-[#ff7b72]' : undefined}>{m.disks_usage_of({ used: diskSize(f.used), size: diskSize(f.size), pct: pct(used) })}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-[5px] bg-raised" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)} aria-label={f.mount}>
              <div className={`h-full rounded-[5px] ${bad ? 'bg-[#f85149]' : used >= WARN ? 'bg-[#d29922]' : 'bg-accent'}`} style={{ width: `${Math.min(100, used * 100)}%` }} />
            </div>
            <TrendLine trend={f.trend} bad={bad} />
            {used >= WARN && f.mount !== '/' && (
              <Link to="/files" search={{ path: f.mount }} className="text-[12px] text-accent underline">
                {m.disks_usage_what()}
              </Link>
            )}
          </div>
        )
      })}
    </div>
  )
}
