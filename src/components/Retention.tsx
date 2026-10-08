import { useState } from 'react'
import { retentionPresetLabel, spanLabel } from '~/lib/backup-labels'
import { RETENTION_PRESETS, retentionEstimate, retentionPoints, retentionPreset, type BackupPlan, type RetentionPreset } from '~/shared/backup'
import { pickMsg } from '~/i18n'
import { m } from '~/paraglide/messages'

type Keep = BackupPlan['keep']
type Rule = 'daily' | 'weekly' | 'monthly' | 'yearly'
const ruleLabel = (r: Rule) => pickMsg({ daily: m.backup_wizard_rule_daily, weekly: m.backup_wizard_rule_weekly, monthly: m.backup_wizard_rule_monthly, yearly: m.backup_wizard_rule_yearly }, r)
const RULE_COLOR = { daily: 'var(--color-accent)', weekly: 'var(--color-accent-deep)', monthly: 'var(--color-accent-2)', yearly: 'var(--color-warn)' } as const

/**
 * How long to keep, for the server and the clients: how far back you want to go as presets
 * (or own values), with a timeline of the snapshots that stay.
 */
export function RetentionPicker({ keep, onChange }: { keep: Keep; onChange: (keep: Keep) => void }) {
  const [custom, setCustom] = useState(false)
  const preset = custom ? 'custom' : retentionPreset(keep)
  const est = retentionEstimate(keep)
  return (
    <>
      <p className="m-0 text-[12px] text-muted">{m.backup_wizard_retentionHelp()}</p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={m.backup_wizard_retention()}>
        {([...(Object.keys(RETENTION_PRESETS) as RetentionPreset[]), 'custom'] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={preset === p}
            className={`btn ${preset === p ? 'border-accent! bg-accent/14! text-accent-soft' : ''}`}
            onClick={() => {
              setCustom(p === 'custom')
              if (p !== 'custom') onChange({ ...RETENTION_PRESETS[p] })
            }}
          >
            {retentionPresetLabel(p)}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(['daily', 'weekly', 'monthly', 'yearly'] as const).map((k) => (
            <label key={k} className="flex flex-col gap-1.5 text-[13px]">
              {pickMsg({ daily: m.backup_setup_keepDaily, weekly: m.backup_setup_keepWeekly, monthly: m.backup_setup_keepMonthly, yearly: m.backup_setup_keepYearly }, k)}
              <input className="field" type="number" min={0} max={1000} value={keep[k] ?? 0} onChange={(e) => onChange({ ...keep, [k]: Math.max(0, Math.min(1000, Math.round(Number(e.target.value) || 0))) })} />
            </label>
          ))}
        </div>
      )}
      <Timeline keep={keep} days={est.days} />
      <p className="m-0 text-[12.5px]" data-testid="retention-reach">
        {m.backup_wizard_reach({ span: spanLabel(est.days), count: est.count })}
      </p>
    </>
  )
}

/** Where the kept snapshots lie between today and the oldest one (square-root scale: the recent ones apart). */
function Timeline({ keep, days }: { keep: Keep; days: number }) {
  const points = retentionPoints(keep)
  const max = Math.max(days, 7)
  const x = (d: number) => 100 - Math.sqrt(d / max) * 97 - 1.5
  const rules = (['daily', 'weekly', 'monthly', 'yearly'] as const).filter((r) => points.some((p) => p.rule === r))
  return (
    <div className="flex flex-col gap-1.5" aria-hidden="true">
      <div className="relative h-[22px]">
        <div className="absolute inset-x-0 top-[10px] h-[2px] bg-rim" />
        {points.map((p) => (
          <span key={p.daysAgo} className="absolute top-[5px] size-3 -translate-x-1/2 rounded-full" style={{ left: `${x(p.daysAgo)}%`, background: RULE_COLOR[p.rule], boxShadow: `0 0 6px ${RULE_COLOR[p.rule]}` }} />
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-faint">
        <span>{m.backup_wizard_ago({ span: spanLabel(days) })}</span>
        <span>{m.backup_wizard_today()}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
        {rules.map((r) => (
          <span key={r} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: RULE_COLOR[r] }} />
            {points.filter((p) => p.rule === r).length} {ruleLabel(r)}
          </span>
        ))}
      </div>
    </div>
  )
}
