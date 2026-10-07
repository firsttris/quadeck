import { useEffect, useMemo, useState } from 'react'
import { api } from '~/lib/api'
import { kindLabel, presetLabel } from '~/lib/backup-labels'
import { bytes } from '~/lib/format'
import {
  EXCLUDE_PRESETS,
  REPO_KINDS,
  REPO_SECRETS,
  defaultPlan,
  parseBackupPlan,
  retentionEstimate,
  type BackupPlan,
  type BackupSizes,
  type BackupState,
  type BackupSuggestion,
  type RepoKind,
} from '~/shared/backup'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'

const placeholder: Record<RepoKind, string> = {
  local: '/mnt/backup/restic',
  sftp: 'backup@nas.lan:/srv/restic',
  s3: 's3.eu-central-1.amazonaws.com/bucket/server',
  b2: 'bucket-name:server',
  rest: 'https://backup.home.lan/server/',
}

const kindHelp = (k: RepoKind) => pickMsg({ local: m.backup_kindHelp_local, sftp: m.backup_kindHelp_sftp, s3: m.backup_kindHelp_s3, b2: m.backup_kindHelp_b2, rest: m.backup_kindHelp_rest }, k)

const label = (p: string) => (p.startsWith('volume:') ? `${m.backup_volume()} ${p.slice(7)}` : p)

/** Set up or change the server backup: target, what, excludes, units to stop, schedule, retention. */
export function BackupSetup({ state, onClose, onSaved }: { state: BackupState; onClose: () => void; onSaved: (s: BackupState) => void }) {
  const guarded = useGuardedApi()
  const say = useToast()
  const [suggestion, setSuggestion] = useState<BackupSuggestion | null>(null)
  const [plan, setPlan] = useState<BackupPlan | null>(state.plan ? structuredClone(state.plan) : null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [extra, setExtra] = useState('')
  const [patterns, setPatterns] = useState((state.plan?.exclude.patterns ?? []).join('\n'))
  const [sizes, setSizes] = useState<BackupSizes | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<BackupSuggestion>('/api/backup?suggest', { method: 'GET' })
      .then((s) => {
        setSuggestion(s)
        setPlan((p) => p ?? defaultPlan(s))
      })
      .catch((e: Error) => {
        setSuggestion({ paths: [], excludes: [], stop: [] })
        setPlan((p) => p ?? defaultPlan({ paths: [], excludes: [], stop: [] }))
        setError(e.message)
      })
  }, [])

  // Everything on offer: the suggestions plus what the plan already has.
  const paths = useMemo(() => {
    const list = [...(suggestion?.paths ?? [])]
    for (const p of plan?.paths ?? []) if (!list.some((x) => x.path === p)) list.push({ path: p, from: '', checked: true })
    return list
  }, [suggestion, plan?.paths])
  const excludes = useMemo(() => {
    const list = [...(suggestion?.excludes ?? [])]
    for (const d of plan?.exclude.dirs ?? []) if (!list.some((x) => x.path === d)) list.push({ path: d, label: '', from: '' })
    return list
  }, [suggestion, plan?.exclude.dirs])
  const stops = useMemo(() => {
    const list = [...(suggestion?.stop ?? [])]
    for (const u of plan?.stop ?? []) if (!list.some((x) => x.unit === u)) list.push({ unit: u, from: '', database: false })
    return list
  }, [suggestion, plan?.stop])

  if (!plan)
    return (
      <Modal open wide title={m.backup_setup_title()} onClose={onClose}>
        <p className="m-0 text-muted">{m.backup_loading()}</p>
      </Modal>
    )

  const set = (p: Partial<BackupPlan>) => setPlan({ ...plan, ...p })
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v))
  const full = { ...plan, exclude: { ...plan.exclude, patterns: patterns.split('\n').map((l) => l.trim()).filter(Boolean) } }
  const est = retentionEstimate(plan.keep)
  const sizeOf = (p: string, list: 'paths' | 'excludes') => sizes?.[list].find((x) => x.path === p)?.bytes
  const total = sizes ? sizes.paths.filter((x) => plan.paths.includes(x.path)).reduce((n, x) => n + (x.bytes ?? 0), 0) : 0
  const skipped = sizes ? sizes.excludes.filter((x) => plan.exclude.dirs.includes(x.path)).reduce((n, x) => n + (x.bytes ?? 0), 0) : 0

  const measure = async () => {
    setMeasuring(true)
    try {
      setSizes(await api<BackupSizes>('/api/backup', { body: { sizes: { paths: paths.map((p) => p.path), excludes: excludes.map((e) => e.path) } } }))
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setMeasuring(false)
    }
  }

  const save = async () => {
    const checked = parseBackupPlan(full)
    if (checked.error) return setError(checked.error)
    setBusy(true)
    setError('')
    try {
      const s = await guarded<BackupState>('/api/backup', { body: { save: { plan: checked.plan, secrets } } })
      if (!s) return
      say(state.plan ? m.backup_setup_saved() : m.backup_setup_created())
      onSaved(s)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open wide title={state.plan ? m.backup_setup_editTitle() : m.backup_setup_title()} onClose={onClose}>
      <Section title={m.backup_setup_where()}>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label={m.backup_setup_where()}>
          {REPO_KINDS.map((k) => (
            <label key={k} className={`flex cursor-pointer flex-col gap-1 rounded-[10px] border p-3 ${plan.repo.kind === k ? 'border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]' : 'border-rim'} bg-sunken`}>
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <input type="radio" name="kind" checked={plan.repo.kind === k} onChange={() => set({ repo: { kind: k, location: k === state.plan?.repo.kind ? state.plan.repo.location : '' } })} />
                {kindLabel(k)}
              </span>
              <span className="pl-6 text-[12px] text-muted">{kindHelp(k)}</span>
            </label>
          ))}
        </div>
        <label className="flex flex-col gap-1.5 text-[13px]">
          {plan.repo.kind === 'local' ? m.backup_setup_folder() : m.backup_setup_location()}
          <input className="field font-mono" value={plan.repo.location} placeholder={placeholder[plan.repo.kind]} onChange={(e) => set({ repo: { ...plan.repo, location: e.target.value.trim() } })} />
        </label>
        {plan.repo.kind === 'local' && <p className="m-0 text-[12px] text-muted">{m.backup_setup_localHint()}</p>}
        {plan.repo.kind === 'sftp' && <p className="m-0 text-[12px] text-muted">{m.backup_setup_sftpHint()}</p>}
        {REPO_SECRETS[plan.repo.kind].length > 0 && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {REPO_SECRETS[plan.repo.kind].map((k) => (
              <label key={k} className="flex flex-col gap-1.5 text-[13px]">
                <span className="font-mono text-[12px]">{k}</span>
                <input className="field" type="password" autoComplete="off" value={secrets[k] ?? ''} placeholder={state.secretsSet.includes(k) ? m.backup_setup_secretKept() : ''} onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} />
              </label>
            ))}
          </div>
        )}
        {!state.plan && <p className="m-0 text-[12px] text-muted">{m.backup_setup_passwordNote()}</p>}
      </Section>

      <Section title={m.backup_setup_what()}>
        <p className="m-0 text-[12px] text-muted">{m.backup_setup_whatHelp()}</p>
        <ul className="m-0 flex list-none flex-col p-0" aria-label={m.backup_setup_what()}>
          {paths.map((p) => (
            <li key={p.path} className="border-b border-line last:border-0">
              <label className="flex items-center gap-2.5 py-1.5 text-[13px]">
                <input type="checkbox" checked={plan.paths.includes(p.path)} onChange={(e) => set({ paths: toggle(plan.paths, p.path, e.target.checked) })} />
                <span className="min-w-0 grow truncate font-mono" title={p.path}>
                  {label(p.path)}
                </span>
                {p.readOnly && <span className="chip">{m.backup_setup_readOnly()}</span>}
                <span className="text-[12px] text-muted">{p.from}</span>
                {sizes && <span className="w-[72px] text-right text-[12px] text-subtle">{bytes(sizeOf(p.path, 'paths'))}</span>}
              </label>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <input className="field font-mono" value={extra} placeholder="/srv/…" aria-label={m.backup_setup_addFolder()} onChange={(e) => setExtra(e.target.value)} />
          <button
            type="button"
            className="btn"
            disabled={!extra.trim()}
            onClick={() => {
              const v = extra.trim().replace(/\/+$/, '')
              if (v && !plan.paths.includes(v)) set({ paths: [...plan.paths, v] })
              setExtra('')
            }}
          >
            {m.backup_setup_add()}
          </button>
        </div>
      </Section>

      <Section title={m.backup_setup_excludes()}>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {EXCLUDE_PRESETS.map((p) => (
            <label key={p} className="flex items-center gap-2.5 text-[13px]">
              <input type="checkbox" checked={plan.exclude.presets.includes(p)} onChange={(e) => set({ exclude: { ...plan.exclude, presets: toggle(plan.exclude.presets, p, e.target.checked) } })} />
              {presetLabel(p)}
            </label>
          ))}
        </div>
        {excludes.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={m.backup_setup_appExcludes()}>
            {excludes.map((x) => (
              <li key={x.path}>
                <label className="flex items-center gap-2.5 text-[13px]">
                  <input type="checkbox" checked={plan.exclude.dirs.includes(x.path)} onChange={(e) => set({ exclude: { ...plan.exclude, dirs: toggle(plan.exclude.dirs, x.path, e.target.checked) } })} />
                  <span className="min-w-0 grow">
                    {x.label || m.backup_setup_folderExcluded()}
                    <span className="block truncate font-mono text-[12px] text-muted">{x.path}</span>
                  </span>
                  {sizes && <span className="w-[72px] text-right text-[12px] text-subtle">{bytes(sizeOf(x.path, 'excludes'))}</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
        <label className="flex flex-col gap-1.5 text-[13px]">
          {m.backup_setup_patterns()}
          <textarea className="field resize-y font-mono text-[13px]" rows={3} value={patterns} placeholder={'/srv/app/tmp\n*.iso\n**/node_modules'} onChange={(e) => setPatterns(e.target.value)} />
        </label>
        <p className="m-0 text-[12px] text-muted">{m.backup_setup_patternsHelp()}</p>
        <label className="flex flex-wrap items-center gap-2 text-[13px]">
          <input type="checkbox" checked={!!plan.exclude.maxSizeGB} onChange={(e) => set({ exclude: { ...plan.exclude, maxSizeGB: e.target.checked ? 4 : undefined } })} />
          {m.backup_setup_maxSizeBefore()}
          <input
            className="field !w-[72px] !py-1"
            type="number"
            min={1}
            aria-label={m.backup_setup_maxSizeLabel()}
            disabled={!plan.exclude.maxSizeGB}
            value={plan.exclude.maxSizeGB ?? 4}
            onChange={(e) => set({ exclude: { ...plan.exclude, maxSizeGB: Math.max(1, Number(e.target.value) || 1) } })}
          />
          {m.backup_setup_maxSizeAfter()}
        </label>
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-edge bg-sunken px-3.5 py-3 text-[13px]">
          {sizes ? <span className="grow">{m.backup_setup_sizes({ total: bytes(total), skipped: bytes(skipped) })}</span> : <span className="grow text-muted">{m.backup_setup_sizesHint()}</span>}
          <button type="button" className="btn sm" disabled={measuring} onClick={() => void measure()}>
            {measuring ? m.backup_setup_measuring() : m.backup_setup_measure()}
          </button>
        </div>
      </Section>

      {stops.length > 0 && (
        <Section title={m.backup_setup_during()}>
          <p className="m-0 text-[12px] text-muted">{m.backup_setup_duringHelp()}</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {stops.map((x) => (
              <label key={x.unit} className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={plan.stop.includes(x.unit)} onChange={(e) => set({ stop: toggle(plan.stop, x.unit, e.target.checked) })} />
                {x.from || x.unit}
                {x.database && <span className="chip">{m.backup_setup_database()}</span>}
              </label>
            ))}
          </div>
        </Section>
      )}

      <Section title={m.backup_setup_when()}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5 text-[13px]">
            {m.backup_setup_every()}
            <select className="field" value={plan.schedule.every} onChange={(e) => set({ schedule: { ...plan.schedule, every: e.target.value as BackupPlan['schedule']['every'] } })}>
              <option value="daily">{m.backup_setup_daily()}</option>
              <option value="6h">{m.backup_setup_6h()}</option>
              <option value="weekly">{m.backup_setup_weekly()}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-[13px]">
            {m.backup_setup_time()}
            <input className="field" type="time" value={plan.schedule.time} onChange={(e) => set({ schedule: { ...plan.schedule, time: e.target.value } })} />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px]">
            {m.backup_setup_checkLabel()}
            <select className="field" value={plan.check} onChange={(e) => set({ check: e.target.value as BackupPlan['check'] })}>
              <option value="monthly">{m.backup_check_monthly()}</option>
              <option value="weekly">{m.backup_check_weekly()}</option>
              <option value="never">{m.backup_check_never()}</option>
            </select>
          </label>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {(['daily', 'weekly', 'monthly'] as const).map((k) => (
            <label key={k} className="flex flex-col gap-1.5 text-[13px]">
              {pickMsg({ daily: m.backup_setup_keepDaily, weekly: m.backup_setup_keepWeekly, monthly: m.backup_setup_keepMonthly }, k)}
              <input className="field" type="number" min={0} max={1000} value={plan.keep[k]} onChange={(e) => set({ keep: { ...plan.keep, [k]: Math.max(0, Math.min(1000, Math.round(Number(e.target.value) || 0))) } })} />
            </label>
          ))}
        </div>
        <p className="m-0 text-[12px] text-muted">{m.backup_estimate({ count: est.count, days: est.days })}</p>
      </Section>

      {error && (
        <p role="alert" className="m-0 text-[13px] whitespace-pre-wrap text-[#ff8a80]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_cancel()}
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? m.backup_setup_saving() : state.plan ? m.common_save() : m.backup_setup_create()}
        </button>
      </div>
    </Modal>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5" aria-label={title}>
      <h3 className="label-caps m-0 font-normal">{title}</h3>
      {children}
    </section>
  )
}
