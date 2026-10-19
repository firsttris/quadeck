import { useState } from 'react'
import { pickMsg } from '~/i18n'
import { api } from '~/lib/api'
import { kindLabel, presetLabel } from '~/lib/backup-labels'
import { bytes, weekdayTime } from '~/lib/format'
import { m } from '~/paraglide/messages'
import {
  type BackupPlan,
  type BackupSizes,
  type BackupState,
  backupActive,
  backupPathProblem,
  defaultPlan,
  EXCLUDE_PRESETS,
  holdsRepo,
  nextBackupRun,
  parseBackupPlan,
  REPO_KINDS,
  REPO_SECRETS,
  type RepoKind,
  repoProblem,
} from '~/shared/backup'
import { BusyButton } from './Busy'
import { FolderPicker, FolderPickerDialog } from './FolderPicker'
import { Modal } from './Modal'
import { RetentionPicker } from './Retention'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'

const placeholder: Record<RepoKind, string> = {
  local: '/mnt/backup/restic',
  sftp: 'backup@nas.lan:/srv/restic',
  s3: 's3.eu-central-1.amazonaws.com/bucket/server',
  b2: 'bucket-name:server',
  rest: 'https://backup.home.lan/server/',
}

const kindHelp = (k: RepoKind) => pickMsg({ local: m.backup_kindHelp_local, sftp: m.backup_kindHelp_sftp, s3: m.backup_kindHelp_s3, b2: m.backup_kindHelp_b2, rest: m.backup_kindHelp_rest }, k)

const label = (p: string) => (p.startsWith('volume:') ? `${m.backup_volume()} ${p.slice(7)}` : p)

export const SETUP_TABS = ['where', 'what', 'when'] as const
export type SetupTab = (typeof SETUP_TABS)[number]
const tabLabel = (t: SetupTab) => pickMsg({ where: m.backup_setup_where, what: m.backup_setup_what, when: m.backup_wizard_stepWhen }, t)

/**
 * The server backup, target first: without a plan only Where (the repository is created or opened,
 * the plan has no folders yet and no timer runs). With a plan, Where, What and When as tabs, like
 * a client's plan; `tab` is the one it opens on.
 */
export function BackupSetup({ state, tab: first = 'what', onClose, onSaved }: { state: BackupState; tab?: SetupTab; onClose: () => void; onSaved: (s: BackupState) => void }) {
  const guarded = useGuardedApi()
  const say = useToast()
  const editing = !!state.plan
  const [tab, setTab] = useState<SetupTab>(editing ? first : 'where')
  const [plan, setPlan] = useState<BackupPlan>(() => (state.plan ? structuredClone(state.plan) : defaultPlan()))
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [patterns, setPatterns] = useState((state.plan?.exclude.patterns ?? []).join('\n'))
  const [sizes, setSizes] = useState<BackupSizes | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState<'path' | 'exclude' | null>(null)
  // The first folders of a plan that had none: the first backup can start right away.
  const firstFolders = !!state.plan && !backupActive(state.plan) && backupActive(plan)
  const [startNow, setStartNow] = useState(true)

  const set = (p: Partial<BackupPlan>) => setPlan({ ...plan, ...p })
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v))
  // Stopping containers and the check interval are no choices any more: never stop, check monthly.
  const full: BackupPlan = {
    ...plan,
    stop: [],
    check: 'monthly',
    exclude: {
      ...plan.exclude,
      patterns: patterns
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    },
  }
  const sizeOf = (p: string, list: 'paths' | 'excludes') => sizes?.[list].find((x) => x.path === p)?.bytes
  const total = sizes ? sizes.paths.filter((x) => plan.paths.includes(x.path)).reduce((n, x) => n + (x.bytes ?? 0), 0) : 0
  const skipped = sizes ? sizes.excludes.filter((x) => plan.exclude.dirs.includes(x.path)).reduce((n, x) => n + (x.bytes ?? 0), 0) : 0

  /** What is missing for the target: the location and the credentials it needs. */
  const whereProblem = (): string | undefined => {
    if (!plan.repo.location) return m.backup_wizard_needLocation()
    const rp = repoProblem(plan.repo.kind, plan.repo.location)
    if (rp) return rp
    const kept = state.plan?.repo.kind === plan.repo.kind ? state.secretsSet : []
    const missing = REPO_SECRETS[plan.repo.kind].find((k) => !secrets[k] && !kept.includes(k))
    return missing ? m.backup_wizard_needSecret({ key: missing }) : undefined
  }
  // Shown at the folder: a path that cannot be backed up, or one inside the target.
  const folderProblem = (p: string) => backupPathProblem(p, plan.repo)

  const measure = async () => {
    setMeasuring(true)
    try {
      setSizes(await api<BackupSizes>('/api/backup', { body: { sizes: { paths: plan.paths, excludes: plan.exclude.dirs } } }))
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setMeasuring(false)
    }
  }

  const save = async () => {
    const wp = whereProblem()
    if (wp) {
      setTab('where')
      return setError(wp)
    }
    if (plan.paths.some(folderProblem)) {
      setTab('what')
      return setError(m.backup_setup_folderProblem())
    }
    const checked = parseBackupPlan(full)
    if (checked.error) return setError(checked.error)
    setBusy(true)
    setError('')
    try {
      const s = await guarded<BackupState>('/api/backup', { body: { save: { plan: checked.plan, secrets } } })
      if (!s) return
      say(editing ? m.backup_setup_saved() : m.backup_setup_created())
      if (firstFolders && startNow) {
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

  const where = (
    <section className="flex flex-col gap-2.5" aria-label={m.backup_setup_where()}>
      {!editing && <h3 className="label-caps m-0 font-normal">{m.backup_setup_where()}</h3>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label={m.backup_setup_where()}>
        {REPO_KINDS.map((k) => (
          <label
            key={k}
            className={`flex cursor-pointer flex-col gap-1 rounded-[10px] border p-3 ${plan.repo.kind === k ? 'border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]' : 'border-rim'} bg-sunken`}
          >
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
              <input
                className="field"
                type="password"
                autoComplete="off"
                value={secrets[k] ?? ''}
                placeholder={state.plan?.repo.kind === plan.repo.kind && state.secretsSet.includes(k) ? m.backup_setup_secretKept() : ''}
                onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })}
              />
            </label>
          ))}
        </div>
      )}
      {!editing && (
        <>
          <p className="m-0 rounded-[10px] border border-accent/35 bg-accent/7 px-3 py-2.5 text-[12.5px] text-accent-soft">{m.backup_setup_passwordNote()}</p>
          <p className="m-0 text-[12px] text-muted">{m.backup_setup_targetFirst()}</p>
        </>
      )}
    </section>
  )

  return (
    <Modal open wide title={editing ? m.backup_setup_editTitle() : m.backup_setup_title()} onClose={onClose} busy={busy}>
      {editing && (
        <div role="tablist" aria-label={m.backup_clients_plan()} className="flex flex-wrap gap-1.5">
          {SETUP_TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={`seg ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
              {tabLabel(t)}
            </button>
          ))}
        </div>
      )}

      <div className={`flex flex-col gap-4 ${editing ? 'min-h-[380px]' : ''}`}>
        {tab === 'where' && where}

        {tab === 'what' && (
          <>
            <Section
              title={m.backup_setup_what()}
              action={
                <button type="button" className="btn sm" onClick={() => setPicking('path')}>
                  {m.backup_cwiz_browse()}
                </button>
              }
            >
              <p className="m-0 text-[12px] text-muted">{m.backup_setup_whatHelp()}</p>
              {plan.paths.length === 0 && <p className="m-0 rounded-lg border border-dashed border-rim px-3 py-2.5 text-[13px] text-muted">{m.backup_setup_noFolders()}</p>}
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label={m.backup_setup_what()}>
                {plan.paths.map((p) => {
                  const problem = folderProblem(p)
                  return (
                    <li
                      key={p}
                      className={`flex flex-col gap-0.5 rounded-lg border bg-sunken px-2.5 py-1.5 text-[13px] ${problem ? 'border-[#f85149]/60' : 'border-edge'}`}
                      data-testid="backup-folder"
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 grow truncate font-mono" title={p}>
                          {label(p)}
                        </span>
                        {sizes && <span className="shrink-0 text-[12px] text-subtle">{bytes(sizeOf(p, 'paths'))}</span>}
                        <button
                          type="button"
                          className="text-muted hover:text-fg"
                          aria-label={m.backup_client_removeFolder({ folder: p })}
                          onClick={() => set({ paths: plan.paths.filter((x) => x !== p) })}
                        >
                          ✕
                        </button>
                      </span>
                      {problem ? (
                        <span role="alert" className="text-[12px] text-[#ff8a80]">
                          {problem}
                        </span>
                      ) : (
                        holdsRepo(p, plan.repo) && <span className="text-[12px] text-[#e3b341]">{m.backup_setup_holdsRepo()}</span>
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
                    <input
                      type="checkbox"
                      checked={plan.exclude.presets.includes(p)}
                      onChange={(e) => set({ exclude: { ...plan.exclude, presets: toggle(plan.exclude.presets, p, e.target.checked) } })}
                    />
                    {presetLabel(p)}
                  </label>
                ))}
              </div>
              {plan.exclude.dirs.length > 0 && (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label={m.backup_setup_excludedFolders()}>
                  {plan.exclude.dirs.map((d) => (
                    <li key={d} className="flex items-center gap-2 rounded-lg border border-edge bg-sunken px-2.5 py-1.5 text-[13px]">
                      <span className="min-w-0 grow truncate font-mono" title={d}>
                        {d}
                      </span>
                      {sizes && <span className="shrink-0 text-[12px] text-subtle">{bytes(sizeOf(d, 'excludes'))}</span>}
                      <button
                        type="button"
                        className="text-muted hover:text-fg"
                        aria-label={m.backup_cwiz_removeRule({ rule: d })}
                        onClick={() => set({ exclude: { ...plan.exclude, dirs: plan.exclude.dirs.filter((x) => x !== d) } })}
                      >
                        ✕
                      </button>
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
              {plan.paths.length > 0 && (
                <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-edge bg-sunken px-3.5 py-3 text-[13px]">
                  {sizes ? (
                    <span className="grow">{m.backup_setup_sizes({ total: bytes(total), skipped: bytes(skipped) })}</span>
                  ) : (
                    <span className="grow text-muted">{m.backup_setup_sizesHint()}</span>
                  )}
                  <button type="button" className="btn sm" disabled={measuring} onClick={() => void measure()}>
                    {measuring ? m.backup_setup_measuring() : m.backup_setup_measure()}
                  </button>
                </div>
              )}
            </Section>
          </>
        )}

        {tab === 'when' && (
          <>
            <Box title={m.backup_setup_when()}>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={m.backup_wizard_every()}>
                  {(['daily', '6h', 'weekly'] as const).map((e) => (
                    <button
                      key={e}
                      type="button"
                      role="radio"
                      aria-checked={plan.schedule.every === e}
                      className={`btn ${plan.schedule.every === e ? 'border-accent! bg-accent/14! text-accent-soft' : ''}`}
                      onClick={() => set({ schedule: { ...plan.schedule, every: e } })}
                    >
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
                {backupActive(plan) ? (
                  <>
                    {m.backup_wizard_nextRun({ when: weekdayTime(nextBackupRun(plan.schedule, new Date())) })} · {m.backup_wizard_catchUp()}
                  </>
                ) : (
                  m.backup_error_noFolders()
                )}
              </p>
            </Box>

            <Box title={m.backup_wizard_retention()}>
              <RetentionPicker keep={plan.keep} onChange={(keep) => set({ keep })} />
            </Box>
            <p className="m-0 text-[12px] text-muted">{m.backup_wizard_checkHint()}</p>
          </>
        )}
      </div>

      {firstFolders && (
        <div className="flex flex-col gap-2">
          <p className="m-0 rounded-[10px] border border-accent/35 bg-accent/7 px-3 py-2.5 text-[12.5px] text-accent-soft">{m.backup_wizard_firstRun()}</p>
          <label className="flex items-center gap-2.5 text-[13px]">
            <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
            {m.backup_wizard_startNow()}
          </label>
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-[13px] whitespace-pre-wrap text-[#ff8a80]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {m.common_cancel()}
        </button>
        <BusyButton className="btn primary" busy={busy} busyLabel={editing ? m.common_saving() : m.backup_setup_saving()} onClick={() => void save()}>
          {editing ? m.common_save() : m.backup_setup_create()}
        </BusyButton>
      </div>

      {picking && (
        <FolderPickerDialog
          title={picking === 'path' ? m.folders_pickTitle() : m.backup_wizard_excludePick()}
          onClose={() => setPicking(null)}
          onPick={(p) => {
            if (picking === 'path' && !plan.paths.includes(p)) set({ paths: [...plan.paths, p] })
            if (picking === 'exclude' && !plan.exclude.dirs.includes(p)) set({ exclude: { ...plan.exclude, dirs: [...plan.exclude.dirs, p] } })
            setPicking(null)
            setError('')
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
