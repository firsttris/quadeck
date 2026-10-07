// Words for the backup plan and its runs, in the viewer's language.

import { pickMsg } from '~/i18n'
import { m } from '~/paraglide/messages'
import type { BackupPlan, BackupRun, ExcludePreset, RepoKind, RetentionPreset } from '~/shared/backup'

export const runStatusLabel = (s: BackupRun['status']) => pickMsg({ ok: m.backup_run_ok, warning: m.backup_run_warning, failed: m.backup_run_failed }, s)

export function scheduleLabel(s: BackupPlan['schedule']): string {
  if (s.every === '6h') {
    const [h, min] = s.time.split(':')
    const times = [0, 6, 12, 18].map((o) => `${String((Number(h) % 6) + o).padStart(2, '0')}:${min}`)
    return m.backup_every_6h({ times: times.join(', ') })
  }
  return s.every === 'weekly' ? m.backup_every_weekly({ time: s.time }) : m.backup_every_daily({ time: s.time })
}

export const checkLabel = (c: BackupPlan['check']) => pickMsg({ monthly: m.backup_check_monthly, weekly: m.backup_check_weekly, never: m.backup_check_never }, c)

export const presetLabel = (p: ExcludePreset) => pickMsg({ caches: m.backup_preset_caches, temp: m.backup_preset_temp, logs: m.backup_preset_logs, nobackup: m.backup_preset_nobackup }, p)

export const kindLabel = (k: RepoKind) => pickMsg({ local: m.backup_kind_local, sftp: m.backup_kind_sftp, s3: m.backup_kind_s3, b2: m.backup_kind_b2, rest: m.backup_kind_rest }, k)

export const repoLabel = (r: BackupPlan['repo']) => (r.kind === 'local' ? r.location : `${r.kind}:${r.location}`)

/** "12 days", "4 weeks", "11 months", "10 years": how far back a retention reaches. */
export function spanLabel(days: number): string {
  if (days <= 1) return m.backup_span_day()
  if (days < 14) return m.backup_span_days({ n: days })
  if (days < 60) return m.backup_span_weeks({ n: Math.round(days / 7) })
  if (days < 730) return m.backup_span_months({ n: Math.round(days / 30.4) })
  return m.backup_span_years({ n: Math.round(days / 365) })
}

export const retentionPresetLabel = (p: RetentionPreset | 'custom') =>
  pickMsg({ week: m.backup_wizard_preset_week, year: m.backup_wizard_preset_year, years: m.backup_wizard_preset_years, custom: m.backup_wizard_preset_custom }, p)
