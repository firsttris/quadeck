import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { useActions } from '~/components/Actions'
import { BackupBrowser } from '~/components/BackupBrowser'
import { BackupSetup } from '~/components/BackupSetup'
import { BackupClients } from '~/components/BackupClients'
import { BusyButton, useBusy } from '~/components/Busy'
import { InstallHint } from '~/components/InstallHint'
import { ConfirmDialog, Modal } from '~/components/Modal'
import { PageHeader } from '~/components/PageHeader'
import { Dot, Pill, type Tone } from '~/components/Status'
import { useToast } from '~/components/Toast'
import { useGuardedApi } from '~/components/Unlock'
import { api } from '~/lib/api'
import { bytes, num, relative } from '~/lib/format'
import { localeOf } from '~/shared/i18n'
import { checkLabel, kindLabel, presetLabel, repoLabel, runStatusLabel, scheduleLabel } from '~/lib/backup-labels'
import { retentionEstimate, type BackupPlan, type BackupRun, type BackupState } from '~/shared/backup'
import { m } from '~/paraglide/messages'

export const Route = createFileRoute('/_app/backups')({
  validateSearch: (s: Record<string, unknown>): { tab?: 'clients'; snapshot?: string; dir?: string } => ({
    ...(s.tab === 'clients' ? { tab: 'clients' as const } : {}),
    ...(typeof s.snapshot === 'string' ? { snapshot: s.snapshot } : {}),
    ...(typeof s.dir === 'string' ? { dir: s.dir } : {}),
  }),
  head: () => ({ meta: [{ title: 'Backups · Quadeck' }] }),
  component: BackupsPage,
})

const dateTime = (ts: number) => new Date(ts).toLocaleString(localeOf(), { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const runTone = (r: BackupRun): Tone => (r.status === 'ok' ? 'ok' : r.status === 'warning' ? 'warn' : 'bad')
const seconds = (r: BackupRun) => Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000))
const took = (r: BackupRun) => (seconds(r) < 90 ? `${seconds(r)} s` : `${Math.round(seconds(r) / 60)} min`)

function BackupsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const [state, setState] = useState<BackupState | null>(null)
  const [error, setError] = useState('')
  const [setup, setSetup] = useState(false)

  const load = useCallback(async (refresh = false) => {
    try {
      setState(await api<BackupState>(`/api/backup${refresh ? '?refresh' : ''}`, { method: 'GET' }))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  // Follow a running backup closely, otherwise now and then.
  useEffect(() => {
    const t = setInterval(() => void load(), state?.running ? 3000 : 60_000)
    return () => clearInterval(t)
  }, [load, state?.running])

  if (search.snapshot && state?.plan)
    return (
      <>
        <PageHeader title={m.backup_browse_title()} subtitle={m.backup_browse_subtitle()} />
        <BackupBrowser state={state} snapshot={search.snapshot} dir={search.dir} onNavigate={(snapshot, dir) => void navigate({ to: '/backups', search: snapshot ? { snapshot, ...(dir ? { dir } : {}) } : {} })} />
      </>
    )

  return (
    <>
      <PageHeader title="Backups" subtitle={m.backup_subtitle()}>
        <div role="tablist" aria-label={m.backup_tabs()} className="flex gap-1.5">
          <button type="button" role="tab" aria-selected={!search.tab} className={`seg ${!search.tab ? 'on' : ''}`} onClick={() => void navigate({ to: '/backups', search: {} })}>
            {m.backup_tab_server()}
          </button>
          <button type="button" role="tab" aria-selected={search.tab === 'clients'} className={`seg ${search.tab === 'clients' ? 'on' : ''}`} onClick={() => void navigate({ to: '/backups', search: { tab: 'clients' } })}>
            {m.backup_tab_clients()}
          </button>
        </div>
      </PageHeader>
      {search.tab === 'clients' && <BackupClients />}
      {error && (
        <p role="alert" className="m-0 text-[13px] text-[#e3b341]">
          {error}
        </p>
      )}
      {!search.tab && !state && !error && <p className="m-0 text-muted">{m.backup_loading()}</p>}
      {!search.tab && state && !state.installed && (
        <section className="panel" aria-label={m.backup_install_label()}>
          <InstallHint feature="restic" what={m.backup_install_what()} onInstalled={() => void load()} />
        </section>
      )}
      {!search.tab && state?.installed && !state.plan && <Empty onSetup={() => setSetup(true)} />}
      {!search.tab && state?.plan && <Overview state={state} onState={setState} onEdit={() => setSetup(true)} onRefresh={() => load(true)} />}
      {state?.installed && setup && (
        <BackupSetup
          state={state}
          onClose={() => setSetup(false)}
          onSaved={(s) => {
            setState(s)
            setSetup(false)
          }}
        />
      )}
    </>
  )
}

function Empty({ onSetup }: { onSetup: () => void }) {
  const { readonly } = useActions()
  return (
    <section className="panel flex flex-col items-start gap-3 p-[22px]" aria-label={m.backup_empty_label()}>
      <h2 className="h2">{m.backup_empty_title()}</h2>
      <p className="m-0 max-w-[70ch] text-[13px] text-muted">{m.backup_empty_text()}</p>
      {!readonly && (
        <button type="button" className="btn primary" onClick={onSetup}>
          {m.backup_empty_setup()}
        </button>
      )}
    </section>
  )
}

function Overview({ state, onState, onEdit, onRefresh }: { state: BackupState; onState: (s: BackupState) => void; onEdit: () => void; onRefresh: () => Promise<void> }) {
  const plan = state.plan!
  const { readonly } = useActions()
  const guarded = useGuardedApi()
  const say = useToast()
  const navigate = useNavigate()
  const [password, setPassword] = useState<string | null>(null)
  const [disable, setDisable] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const work = useBusy<'backup' | 'check' | 'password' | 'saved'>()
  const backups = state.runs.filter((r) => r.kind === 'backup')
  const last = backups[0]
  const lastCheck = state.runs.find((r) => r.kind === 'check')

  const start = (kind: 'backup' | 'check') =>
    work.run(kind, async () => {
      try {
        const r = await guarded('/api/backup', { body: { start: kind } })
        if (!r) return
        say(kind === 'backup' ? m.backup_started() : m.backup_checkStarted())
        onState({ ...state, running: kind })
      } catch (e) {
        say((e as Error).message, 'bad')
      }
    })
  const showPassword = () =>
    work.run('password', async () => {
      try {
        const r = await guarded<{ password: string }>('/api/backup', { body: { password: true } })
        if (r) setPassword(r.password)
      } catch (e) {
        say((e as Error).message, 'bad')
      }
    })
  const switchOff = async () => {
    try {
      const s = await guarded<BackupState>('/api/backup', { body: { disable: true } })
      if (s) {
        onState(s)
        say(m.backup_disabled())
      }
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }

  return (
    <>
      {last?.status === 'failed' && (
        <section role="alert" className="panel alertcard flex flex-col gap-1 px-[18px] py-3 text-[13px]">
          <b>{m.backup_lastFailed({ when: relative(last.endedAt) })}</b>
          <span className="font-mono text-[12px] break-all text-[#ff8a80]">{last.message}</span>
        </section>
      )}
      {state.repoError && (
        <p role="alert" className="m-0 text-[13px] text-[#e3b341]">
          {m.backup_repoError({ message: state.repoError })}
        </p>
      )}
      {!plan.passwordSaved && (
        <section className="flex flex-wrap items-center gap-3 rounded-[12px] border border-[rgba(210,153,34,.35)] bg-[rgba(210,153,34,.08)] px-4 py-3 text-[13px]" aria-label={m.backup_password_label()}>
          <span className="grow">{m.backup_password_warn()}</span>
          {!readonly && (
            <BusyButton className="btn sm" busy={work.is('password')} busyLabel={m.common_opening()} disabled={work.busy !== null} onClick={() => void showPassword()}>
              {m.backup_password_show()}
            </BusyButton>
          )}
        </section>
      )}

      <section className="panel grid grid-cols-2 gap-[18px] p-[18px] lg:grid-cols-4" aria-label={m.backup_status_label()}>
        <Stat label={m.backup_status_last()}>
          {state.running === 'backup' ? (
            <span className="flex items-center gap-2">
              <Dot tone="warn" label={m.backup_running()} />
              {m.backup_running()}
            </span>
          ) : last ? (
            <span className="flex items-center gap-2">
              <Dot tone={runTone(last)} label={runStatusLabel(last.status)} />
              <span suppressHydrationWarning>{relative(last.endedAt)}</span>
            </span>
          ) : (
            m.backup_status_none()
          )}
          {last && <small>{[runStatusLabel(last.status), took(last), last.added !== undefined ? m.backup_added({ size: bytes(last.added) }) : ''].filter(Boolean).join(' · ')}</small>}
        </Stat>
        <Stat label={m.backup_status_next()}>
          <span suppressHydrationWarning>{state.next ? relative(state.next) : '–'}</span>
          <small>{scheduleLabel(plan.schedule)}</small>
        </Stat>
        <Stat label={m.backup_status_repo()}>
          {state.repoSize !== undefined ? bytes(state.repoSize) : '–'}
          <small suppressHydrationWarning>
            {m.backup_snapshotsCount({ n: state.snapshots.length })}
            {lastCheck ? ` · ${m.backup_checked({ when: relative(lastCheck.endedAt), status: runStatusLabel(lastCheck.status) })}` : ''}
          </small>
        </Stat>
        <Stat label={m.backup_status_target()}>
          <span className="font-mono text-[14px] break-all">{repoLabel(plan.repo)}</span>
          <small>{state.target ? m.backup_free({ free: bytes(state.target.free), size: bytes(state.target.size) }) : kindLabel(plan.repo.kind)}</small>
        </Stat>
      </section>

      {!readonly && (
        <div className="flex flex-wrap items-center gap-2">
          <BusyButton className="btn primary" busy={work.is('backup')} busyLabel={m.common_starting()} disabled={!!state.running || work.busy !== null} onClick={() => void start('backup')}>
            {m.backup_runNow()}
          </BusyButton>
          <BusyButton className="btn" busy={work.is('check')} busyLabel={m.common_starting()} disabled={!!state.running || work.busy !== null} onClick={() => void start('check')}>
            {m.backup_checkNow()}
          </BusyButton>
          <button type="button" className="btn" onClick={onEdit}>
            {m.backup_edit()}
          </button>
          <BusyButton className="btn" busy={work.is('password')} busyLabel={m.common_opening()} disabled={work.busy !== null} onClick={() => void showPassword()}>
            {m.backup_password_show()}
          </BusyButton>
          <span className="grow" />
          <button type="button" className="btn danger" onClick={() => setDisable(true)}>
            {m.backup_disable()}
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-2">
        <PlanPanel plan={plan} />
        <RunsPanel runs={state.runs} />
      </div>

      <section className="panel flex flex-col" aria-label={m.backup_snapshots()}>
        <div className="flex flex-wrap items-center gap-3 px-[18px] pt-4 pb-2">
          <h2 className="h2 grow">{m.backup_snapshots()}</h2>
          {state.snapshotsAt && (
            <span className="text-[12px] text-muted" suppressHydrationWarning>
              {m.backup_readAt({ when: relative(state.snapshotsAt) })}
            </span>
          )}
          <button
            type="button"
            className="btn sm"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true)
              await onRefresh()
              setRefreshing(false)
            }}
          >
            {refreshing ? m.backup_reading() : m.backup_readNow()}
          </button>
        </div>
        {state.snapshots.length === 0 ? (
          <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{m.backup_noSnapshots()}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{m.backup_col_time()}</th>
                  <th>ID</th>
                  <th>{m.backup_col_files()}</th>
                  <th>{m.backup_col_added()}</th>
                  <th>{m.backup_col_total()}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {state.snapshots.map((s) => (
                  <tr key={s.id} data-testid="snapshot">
                    <td suppressHydrationWarning>{dateTime(s.time)}</td>
                    <td className="font-mono text-[12px] text-subtle">{s.short}</td>
                    <td>{s.files !== undefined ? num(s.files) : '–'}</td>
                    <td>{s.added !== undefined ? bytes(s.added) : '–'}</td>
                    <td>{s.bytes !== undefined ? bytes(s.bytes) : '–'}</td>
                    <td className="text-right">
                      <button type="button" className="btn sm" onClick={() => void navigate({ to: '/backups', search: { snapshot: s.id } })} aria-label={m.backup_browseWith({ when: dateTime(s.time) })}>
                        {m.backup_browse()}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal open={password !== null} onClose={() => setPassword(null)} title={m.backup_password_title()} busy={work.is('saved')}>
        <p className="m-0 text-[13px] text-muted">{m.backup_password_text()}</p>
        <code className="block rounded-lg border border-edge bg-[#070a0e] px-3 py-2 font-mono text-[13px] break-all select-all" data-testid="backup-password">
          {password}
        </code>
        <div className="flex flex-wrap justify-end gap-2">
          <a className="btn" download="quadeck-backup-password.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(`${m.backup_password_fileNote({ repo: repoLabel(plan.repo) })}\n${password ?? ''}\n`)}`}>
            {m.backup_password_download()}
          </a>
          {!plan.passwordSaved && !readonly && (
            <BusyButton
              className="btn primary"
              busy={work.is('saved')}
              busyLabel={m.common_saving()}
              onClick={() =>
                void work.run('saved', async () => {
                  try {
                    const s = await guarded<BackupState>('/api/backup', { body: { save: { plan: { ...plan, passwordSaved: true }, secrets: {} } } })
                    if (s) onState(s)
                    setPassword(null)
                  } catch (e) {
                    say((e as Error).message, 'bad')
                  }
                })
              }
            >
              {m.backup_password_saved()}
            </BusyButton>
          )}
          <button type="button" className="btn" disabled={work.is('saved')} onClick={() => setPassword(null)}>
            {m.common_close()}
          </button>
        </div>
      </Modal>
      <ConfirmDialog open={disable} title={m.backup_disable_title()} body={<p className="m-0">{m.backup_disable_text()}</p>} confirm={m.backup_disable()} danger busyLabel={m.common_applying()} onConfirm={() => switchOff()} onClose={() => setDisable(false)} />
    </>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  const [main, ...rest] = Array.isArray(children) ? children : [children]
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="label-caps">{label}</span>
      <span className="text-[18px] font-semibold">{main}</span>
      <span className="text-[12px] text-subtle [&>small]:text-[12px]">{rest}</span>
    </div>
  )
}

function PlanPanel({ plan }: { plan: BackupPlan }) {
  const est = retentionEstimate(plan.keep)
  const presets = plan.exclude.presets.map(presetLabel)
  return (
    <section className="panel flex flex-col gap-3 p-[18px]" aria-label={m.backup_plan_label()}>
      <h2 className="h2">{m.backup_plan_title()}</h2>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {plan.paths.map((p) => (
          <li key={p} className="truncate font-mono text-[13px]" title={p}>
            {p.startsWith('volume:') ? `${m.backup_volume()} ${p.slice(7)}` : p}
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <span className="text-[12px] text-muted">{m.backup_plan_excludes()}</span>
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <span key={p} className="chip">
              {p}
            </span>
          ))}
          {[...plan.exclude.dirs, ...plan.exclude.patterns].map((p) => (
            <span key={p} className="chip" title={p}>
              {p.length > 48 ? `…${p.slice(-46)}` : p}
            </span>
          ))}
          {plan.exclude.maxSizeGB && <span className="chip">{m.backup_plan_maxSize({ gb: plan.exclude.maxSizeGB })}</span>}
        </div>
      </div>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-line pt-3 text-[13px]">
        <dt className="text-muted">{m.backup_plan_stop()}</dt>
        <dd className="m-0">{plan.stop.length ? plan.stop.join(', ') : '–'}</dd>
        <dt className="text-muted">{m.backup_plan_schedule()}</dt>
        <dd className="m-0">{scheduleLabel(plan.schedule)}</dd>
        <dt className="text-muted">{m.backup_plan_keep()}</dt>
        <dd className="m-0">
          {m.backup_keep({ daily: plan.keep.daily, weekly: plan.keep.weekly, monthly: plan.keep.monthly })} <span className="text-muted">({m.backup_estimate({ count: est.count, days: est.days })})</span>
        </dd>
        <dt className="text-muted">{m.backup_plan_check()}</dt>
        <dd className="m-0">{checkLabel(plan.check)}</dd>
      </dl>
    </section>
  )
}

function RunsPanel({ runs }: { runs: BackupRun[] }) {
  const [open, setOpen] = useState<number | null>(null)
  const backups = runs.filter((r) => r.kind === 'backup').slice(0, 14).reverse()
  const max = Math.max(1, ...backups.map((r) => r.added ?? 0))
  return (
    <section className="panel flex flex-col gap-3 p-[18px]" aria-label={m.backup_runs_title()}>
      <h2 className="h2">{m.backup_runs_title()}</h2>
      {backups.length > 0 && (
        <>
          <div aria-hidden="true" className="flex h-[64px] items-end gap-1.5">
            {backups.map((r) => (
              <div key={r.startedAt} title={`${dateTime(r.startedAt)} · ${bytes(r.added ?? 0)}`} className="flex-1 rounded-t-[3px]" style={{ height: `${Math.max(6, Math.round(((r.added ?? 0) / max) * 60))}px`, background: r.status === 'ok' ? 'color-mix(in srgb, var(--color-accent) 55%, transparent)' : r.status === 'warning' ? '#e3b341' : '#f85149' }} />
            ))}
          </div>
          <span className="text-[12px] text-muted">{m.backup_runs_chart()}</span>
        </>
      )}
      {runs.length === 0 && <p className="m-0 text-[13px] text-muted">{m.backup_runs_none()}</p>}
      <ul className="m-0 flex list-none flex-col p-0">
        {runs.slice(0, 8).map((r, i) => (
          <li key={`${r.kind}-${r.startedAt}`} className="border-b border-line py-2 text-[13px] last:border-0" data-testid="backup-run">
            <div className="flex items-center gap-2.5">
              <Dot tone={runTone(r)} label={runStatusLabel(r.status)} />
              <span className="w-[130px] shrink-0" suppressHydrationWarning>
                {dateTime(r.startedAt)}
              </span>
              <span className="min-w-0 grow truncate text-subtle">
                {r.kind === 'check'
                  ? m.backup_runCheck({ status: runStatusLabel(r.status) })
                  : r.status === 'failed'
                    ? (r.message ?? '')
                    : [took(r), r.added !== undefined ? m.backup_added({ size: bytes(r.added) }) : '', r.filesNew !== undefined ? m.backup_newFiles({ n: r.filesNew }) : ''].filter(Boolean).join(' · ')}
              </span>
              {r.errors.length > 0 && (
                <button type="button" className="btn sm" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                  <Pill tone="warn">{m.backup_errorsN({ n: r.errors.length })}</Pill>
                </button>
              )}
            </div>
            {open === i && (
              <ul className="mt-2 mb-0 flex list-none flex-col gap-1 p-0 font-mono text-[12px] text-[#e3b341]">
                {r.errors.map((e) => (
                  <li key={e} className="break-all">
                    {e}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
