import { useEffect, useMemo, useState } from 'react'
import { api } from '~/lib/api'
import { kindLabel, presetLabel, retentionPresetLabel, scheduleLabel, spanLabel } from '~/lib/backup-labels'
import { bytes, weekdayTime } from '~/lib/format'
import {
  EXCLUDE_PRESETS,
  REPO_KINDS,
  REPO_SECRETS,
  defaultPlan,
  nextBackupRun,
  parseBackupPlan,
  repoProblem,
  retentionEstimate,
  retentionPreset,
  type BackupPlan,
  type BackupSizes,
  type BackupState,
  type BackupSuggestion,
  type RepoKind,
} from '~/shared/backup'
import { FolderPicker, FolderPickerDialog } from './FolderPicker'
import { RetentionPicker } from './Retention'
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
const reasonLabel = (r: 'broad' | 'contains' | 'media') => pickMsg({ broad: m.backup_wizard_reason_broad, contains: m.backup_wizard_reason_contains, media: m.backup_wizard_reason_media }, r)

const label = (p: string) => (p.startsWith('volume:') ? `${m.backup_volume()} ${p.slice(7)}` : p)

const STEPS = ['where', 'what', 'when', 'summary'] as const
type Step = (typeof STEPS)[number]
const stepLabel = (s: Step) => pickMsg({ where: m.backup_setup_where, what: m.backup_setup_what, when: m.backup_wizard_stepWhen, summary: m.backup_wizard_stepSummary }, s)

type Path = BackupSuggestion['paths'][number]

/**
 * Set up or change the server backup as a wizard: where to, what (with exclusions), when and how
 * long to keep, then a summary. Changing an existing plan opens on the summary.
 */
export function BackupSetup({ state, onClose, onSaved }: { state: BackupState; onClose: () => void; onSaved: (s: BackupState) => void }) {
  const guarded = useGuardedApi()
  const say = useToast()
  const editing = !!state.plan
  const [step, setStep] = useState<Step>(editing ? 'summary' : 'where')
  const [suggestion, setSuggestion] = useState<BackupSuggestion | null>(null)
  const [plan, setPlan] = useState<BackupPlan | null>(state.plan ? structuredClone(state.plan) : null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [patterns, setPatterns] = useState((state.plan?.exclude.patterns ?? []).join('\n'))
  const [sizes, setSizes] = useState<BackupSizes | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState<'path' | 'exclude' | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set([m.backup_wizard_ownFolders()]))
  const [startNow, setStartNow] = useState(true)

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

  // Everything on offer: the suggestions plus what the plan already has (own folders).
  const paths = useMemo(() => {
    const list: Path[] = [...(suggestion?.paths ?? [])]
    for (const p of plan?.paths ?? []) if (!list.some((x) => x.path === p)) list.push({ path: p, from: '', checked: true })
    return list
  }, [suggestion, plan?.paths])
  const groups = useMemo(() => {
    const own = m.backup_wizard_ownFolders()
    const out = new Map<string, Path[]>()
    for (const p of paths) {
      const key = p.from || own
      out.set(key, [...(out.get(key) ?? []), p])
    }
    return [...out]
  }, [paths])
  const excludes = useMemo(() => {
    const list = [...(suggestion?.excludes ?? [])]
    for (const d of plan?.exclude.dirs ?? []) if (!list.some((x) => x.path === d)) list.push({ path: d, label: '', from: '' })
    return list
  }, [suggestion, plan?.exclude.dirs])

  if (!plan)
    return (
      <Modal open wide title={m.backup_setup_title()} onClose={onClose}>
        <p className="m-0 text-muted">{m.backup_loading()}</p>
      </Modal>
    )

  const set = (p: Partial<BackupPlan>) => setPlan({ ...plan, ...p })
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v))
  // Stopping containers and the check interval are no choices any more: never stop, check monthly.
  const full: BackupPlan = { ...plan, stop: [], check: 'monthly', exclude: { ...plan.exclude, patterns: patterns.split('\n').map((l) => l.trim()).filter(Boolean) } }
  const sizeOf = (p: string, list: 'paths' | 'excludes') => sizes?.[list].find((x) => x.path === p)?.bytes
  const total = sizes ? sizes.paths.filter((x) => plan.paths.includes(x.path)).reduce((n, x) => n + (x.bytes ?? 0), 0) : 0
  const skipped = sizes ? sizes.excludes.filter((x) => plan.exclude.dirs.includes(x.path)).reduce((n, x) => n + (x.bytes ?? 0), 0) : 0
  const est = retentionEstimate(plan.keep)
  const exclusions = full.exclude.presets.length + full.exclude.dirs.length + full.exclude.patterns.length + (full.exclude.maxSizeGB ? 1 : 0)

  /** What keeps the wizard from going on from a step. */
  const problem = (s: Step): string | undefined => {
    if (s === 'where') {
      if (!plan.repo.location) return m.backup_wizard_needLocation()
      const rp = repoProblem(plan.repo.kind, plan.repo.location)
      if (rp) return rp
      const kept = state.plan?.repo.kind === plan.repo.kind ? state.secretsSet : []
      const missing = REPO_SECRETS[plan.repo.kind].find((k) => !secrets[k] && !kept.includes(k))
      return missing ? m.backup_wizard_needSecret({ key: missing }) : undefined
    }
    if (s === 'what' || s === 'when') return parseBackupPlan(full).error
    return undefined
  }
  const go = (to: Step) => {
    // Forward only past steps that are complete; back is always fine.
    for (const s of STEPS.slice(0, STEPS.indexOf(to))) {
      const p = problem(s)
      if (p) {
        setStep(s)
        return setError(p)
      }
    }
    setError('')
    setStep(to)
  }
  const next = () => go(STEPS[STEPS.indexOf(step) + 1]!)

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
      say(editing ? m.backup_setup_saved() : m.backup_setup_created())
      if (!editing && startNow) {
        await guarded('/api/backup', { body: { start: 'backup' } })
          .then((r) => r && say(m.backup_started()))
          .catch((e: Error) => say(e.message, 'bad'))
      }
      onSaved(s)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const selectedIn = (list: Path[]) => list.filter((p) => plan.paths.includes(p.path))

  return (
    <Modal open wide title={editing ? m.backup_setup_editTitle() : m.backup_setup_title()} onClose={onClose}>
      <ol className="m-0 flex list-none items-center gap-1.5 p-0 text-[12.5px]" aria-label={m.backup_wizard_steps()}>
        {STEPS.map((s, i) => {
          const at = STEPS.indexOf(step)
          return (
            <li key={s} className="flex min-w-0 flex-1 items-center gap-1.5 last:flex-none">
              <button
                type="button"
                aria-current={s === step ? 'step' : undefined}
                className={`flex shrink-0 items-center gap-1.5 rounded-full border py-1 pr-2.5 pl-1 ${s === step ? 'border-accent bg-accent/12 text-fg' : 'border-rim text-muted hover:text-fg'}`}
                onClick={() => go(s)}
              >
                <span className={`grid size-5 place-items-center rounded-full text-[11px] ${s === step ? 'bg-accent text-bg' : i < at ? 'bg-accent/25 text-accent-soft' : 'bg-raised text-subtle'}`}>{i < at ? '✓' : i + 1}</span>
                <span className="hidden sm:inline">{stepLabel(s)}</span>
              </button>
              {i < STEPS.length - 1 && <span className="h-px min-w-2 flex-1 bg-rim" aria-hidden="true" />}
            </li>
          )
        })}
      </ol>

      <div className="flex min-h-[420px] flex-col gap-4">
        {step === 'where' && (
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
            {plan.repo.kind === 'local' && <FolderPicker target value={plan.repo.location} compare={plan.paths} onChange={(location) => set({ repo: { ...plan.repo, location } })} />}
            {plan.repo.kind === 'local' && <p className="m-0 text-[12px] text-muted">{m.backup_setup_localHint()}</p>}
            {plan.repo.kind === 'sftp' && <p className="m-0 text-[12px] text-muted">{m.backup_setup_sftpHint()}</p>}
            {REPO_SECRETS[plan.repo.kind].length > 0 && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {REPO_SECRETS[plan.repo.kind].map((k) => (
                  <label key={k} className="flex flex-col gap-1.5 text-[13px]">
                    <span className="font-mono text-[12px]">{k}</span>
                    <input className="field" type="password" autoComplete="off" value={secrets[k] ?? ''} placeholder={state.plan?.repo.kind === plan.repo.kind && state.secretsSet.includes(k) ? m.backup_setup_secretKept() : ''} onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} />
                  </label>
                ))}
              </div>
            )}
            {!editing && <p className="m-0 rounded-[10px] border border-accent/35 bg-accent/7 px-3 py-2.5 text-[12.5px] text-accent-soft">{m.backup_setup_passwordNote()}</p>}
          </Section>
        )}

        {step === 'what' && (
          <>
            <Section
              title={m.backup_setup_what()}
              action={
                <button type="button" className="btn sm" onClick={() => setPicking('path')}>
                  + {m.backup_setup_addFolder()} …
                </button>
              }
            >
              <p className="m-0 text-[12px] text-muted">{m.backup_setup_whatHelp()}</p>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label={m.backup_setup_what()}>
                {groups.map(([name, list]) => {
                  const chosen = selectedIn(list)
                  const all = chosen.length === list.length
                  const expanded = open.has(name)
                  const size = sizes ? list.filter((p) => plan.paths.includes(p.path)).reduce((n, p) => n + (sizeOf(p.path, 'paths') ?? 0), 0) : undefined
                  return (
                    <li key={name} className="overflow-hidden rounded-[10px] border border-rim" data-testid="backup-group">
                      <div className="flex items-center gap-2.5 bg-sunken px-3 py-2 text-[13px]">
                        <input
                          type="checkbox"
                          aria-label={name}
                          checked={all}
                          ref={(el) => {
                            if (el) el.indeterminate = chosen.length > 0 && !all
                          }}
                          onChange={(e) => set({ paths: e.target.checked ? [...new Set([...plan.paths, ...list.map((p) => p.path)])] : plan.paths.filter((p) => !list.some((x) => x.path === p)) })}
                        />
                        <button type="button" className="flex min-w-0 grow items-center gap-2 text-left" aria-expanded={expanded} aria-label={m.backup_wizard_showFolders({ name })} onClick={() => setOpen((o) => (o.has(name) ? new Set([...o].filter((x) => x !== name)) : new Set([...o, name])))}>
                          <span className="text-muted">{expanded ? '▾' : '▸'}</span>
                          <b className="truncate">{name}</b>
                          <span className="ml-auto shrink-0 text-[12px] text-muted">
                            {m.backup_wizard_groupCount({ selected: chosen.length, total: list.length })}
                            {size !== undefined && ` · ${bytes(size)}`}
                          </span>
                        </button>
                      </div>
                      {expanded && (
                        <ul className="m-0 list-none p-0">
                          {list.map((p) => (
                            <li key={p.path} className="border-t border-line">
                              <label className="flex items-center gap-2.5 py-1.5 pr-3 pl-9 text-[13px]">
                                <input type="checkbox" checked={plan.paths.includes(p.path)} onChange={(e) => set({ paths: toggle(plan.paths, p.path, e.target.checked) })} />
                                <span className="min-w-0 grow truncate font-mono text-[12.5px]" title={p.path}>
                                  {label(p.path)}
                                </span>
                                {p.readOnly && <span className="chip">{m.backup_setup_readOnly()}</span>}
                                {p.reason && <span className="chip bg-[rgba(210,153,34,.14)]! text-[#e3b341]">{reasonLabel(p.reason)}</span>}
                                {sizes && <span className="w-[72px] text-right text-[12px] text-subtle">{bytes(sizeOf(p.path, 'paths'))}</span>}
                              </label>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            </Section>

            <Section
              title={m.backup_setup_excludes()}
              action={
                <button type="button" className="btn sm" onClick={() => setPicking('exclude')}>
                  {m.backup_wizard_excludeFolder()}
                </button>
              }
            >
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
                <textarea className="field resize-y font-mono text-[13px]" rows={2} value={patterns} placeholder={'*.iso\n**/node_modules'} onChange={(e) => setPatterns(e.target.value)} />
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
          </>
        )}

        {step === 'when' && (
          <>
            <Box title={m.backup_setup_when()}>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={m.backup_wizard_every()}>
                  {(['daily', '6h', 'weekly'] as const).map((e) => (
                    <button key={e} type="button" role="radio" aria-checked={plan.schedule.every === e} className={`btn ${plan.schedule.every === e ? 'border-accent! bg-accent/14! text-accent-soft' : ''}`} onClick={() => set({ schedule: { ...plan.schedule, every: e } })}>
                      {pickMsg({ daily: m.backup_setup_daily, '6h': m.backup_setup_6h, weekly: m.backup_setup_weekly }, e)}
                    </button>
                  ))}
                </div>
                <label className="flex flex-col gap-1.5 text-[13px]">
                  {m.backup_setup_time()}
                  <input className="field w-[110px]" type="time" value={plan.schedule.time} onChange={(e) => e.target.value && set({ schedule: { ...plan.schedule, time: e.target.value } })} />
                </label>
              </div>
              <p className="m-0 text-[12px] text-muted" data-testid="next-run">
                {m.backup_wizard_nextRun({ when: weekdayTime(nextBackupRun(plan.schedule, new Date())) })} · {m.backup_wizard_catchUp()}
              </p>
            </Box>

            <Box title={m.backup_wizard_retention()}>
              <RetentionPicker keep={plan.keep} onChange={(keep) => set({ keep })} />
            </Box>
            <p className="m-0 text-[12px] text-muted">{m.backup_wizard_checkHint()}</p>
          </>
        )}

        {step === 'summary' && (
          <Section title={m.backup_wizard_stepSummary()}>
            <dl className="m-0 grid grid-cols-[minmax(90px,130px)_1fr_auto] overflow-hidden rounded-[10px] border border-rim text-[13px]">
              <Row term={stepLabel('where')} onChange={() => go('where')}>
                {kindLabel(plan.repo.kind)} · <span className="font-mono break-all">{plan.repo.location || '–'}</span>
              </Row>
              <Row term={stepLabel('what')} onChange={() => go('what')}>
                {m.backup_wizard_whatSummary({ count: plan.paths.length })}
                {sizes && ` · ${bytes(total)}`}
                <span className="block text-[12px] text-muted">{m.backup_wizard_excludeSummary({ count: exclusions })}</span>
              </Row>
              <Row term={stepLabel('when')} onChange={() => go('when')}>
                {scheduleLabel(plan.schedule)}
                <span className="block text-[12px] text-muted">{m.backup_wizard_nextRun({ when: weekdayTime(nextBackupRun(plan.schedule, new Date())) })}</span>
              </Row>
              <Row term={m.backup_wizard_keepShort()} onChange={() => go('when')}>
                {m.backup_wizard_retentionSummary({ preset: retentionPresetLabel(retentionPreset(plan.keep)), span: spanLabel(est.days), count: est.count })}
              </Row>
              {!editing && (
                <Row term={m.backup_wizard_password()} last>
                  {m.backup_wizard_passwordValue()}
                </Row>
              )}
            </dl>
            {!editing && (
              <>
                <p className="m-0 rounded-[10px] border border-accent/35 bg-accent/7 px-3 py-2.5 text-[12.5px] text-accent-soft">{m.backup_wizard_firstRun()}</p>
                <label className="flex items-center gap-2.5 text-[13px]">
                  <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
                  {m.backup_wizard_startNow()}
                </label>
              </>
            )}
          </Section>
        )}
      </div>

      {error && (
        <p role="alert" className="m-0 text-[13px] whitespace-pre-wrap text-[#ff8a80]">
          {error}
        </p>
      )}
      <div className="flex justify-between gap-2 border-t border-line pt-4">
        {step === 'where' || (editing && step === 'summary') ? (
          <button type="button" className="btn" onClick={onClose}>
            {m.common_cancel()}
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => go(STEPS[STEPS.indexOf(step) - 1]!)}>
            ← {m.backup_wizard_back()}
          </button>
        )}
        {step === 'summary' ? (
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? m.backup_setup_saving() : editing ? m.common_save() : m.backup_setup_create()}
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={next}>
            {m.backup_wizard_next()} →
          </button>
        )}
      </div>

      {picking && (
        <FolderPickerDialog
          title={picking === 'path' ? m.folders_pickTitle() : m.backup_wizard_excludePick()}
          onClose={() => setPicking(null)}
          onPick={(p) => {
            if (picking === 'path' && !plan.paths.includes(p)) set({ paths: [...plan.paths, p] })
            if (picking === 'exclude' && !plan.exclude.dirs.includes(p)) set({ exclude: { ...plan.exclude, dirs: [...plan.exclude.dirs, p] } })
            setPicking(null)
          }}
        />
      )}
    </Modal>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5" aria-label={title}>
      <div className="flex items-center gap-2">
        <h3 className="label-caps m-0 font-normal">{title}</h3>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  )
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-[10px] border border-rim p-3.5" aria-label={title}>
      <h3 className="m-0 text-[14px] font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function Row({ term, onChange, last, children }: { term: string; onChange?: () => void; last?: boolean; children: React.ReactNode }) {
  const b = last ? '' : 'border-b border-line'
  return (
    <>
      <dt className={`px-3 py-2.5 text-muted ${b}`}>{term}</dt>
      <dd className={`m-0 px-3 py-2.5 ${b}`}>{children}</dd>
      <div className={`px-3 py-2.5 text-right ${b}`}>
        {onChange && (
          <button type="button" className="text-[12.5px] text-accent hover:text-accent-soft" aria-label={m.backup_wizard_changeStep({ step: term })} onClick={onChange}>
            {m.backup_wizard_change()}
          </button>
        )}
      </div>
    </>
  )
}
