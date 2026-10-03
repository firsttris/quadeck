// Words for the backup plan and its runs, in the viewer's language.

import { pickMsg } from '~/i18n'
import { m } from '~/paraglide/messages'
import type { BackupPlan, BackupRun, ExcludePreset, RepoKind } from '~/shared/backup'

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
