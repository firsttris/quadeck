import { useCallback, useEffect, useState } from 'react'
import { api } from '~/lib/api'
import { bytes, relative } from '~/lib/format'
import { useLiveState } from '~/lib/live'
import { CLIENT_PRESETS, clientCalendar, defaultClientPlan, parseClientPlan, ruleKind, ruleProblem, type ClientPlan, type ClientPreset } from '~/shared/backup-client'
import { pickMsg } from '~/i18n'
import { localeOf } from '~/shared/i18n'
import { retentionPresetLabel } from '~/lib/backup-labels'
import { RetentionPicker } from './Retention'
import { CLIENT_NAME, TARGET_UNIT, clientRepo, retentionPreset, staleClients, type BackupClient, type TargetConfig, type TargetState } from '~/shared/backup'
import { useActions } from './Actions'
import { BusyButton, Spinner, useBusy } from './Busy'
import { ConfirmDialog, Modal } from './Modal'
import { RowMenu } from './RowMenu'
import { Dot, Pill, unitState, unitTone } from './Status'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'
import { m } from '~/paraglide/messages'

/** Clients tab: a restic rest-server as the backup target for the other computers at home. */
export function BackupClients() {
  const [state, setState] = useState<TargetState | null>(null)
  const [error, setError] = useState('')
  const [setup, setSetup] = useState(false)
  const [add, setAdd] = useState(false)
  const [access, setAccess] = useState<{ name: string; password: string } | null>(null)
  const [edit, setEdit] = useState<BackupClient | null>(null)
  const [remove, setRemove] = useState<BackupClient | null>(null)
  const [off, setOff] = useState(false)
  const [measuring, setMeasuring] = useState(false)
  const rows = useBusy()
  const { readonly } = useActions()
  const guarded = useGuardedApi()
  const say = useToast()
  const { snapshot } = useLiveState()
  const unit = snapshot.units.find((u) => u.name === TARGET_UNIT)

  const load = useCallback(async (refresh = false) => {
    try {
      setState(await api<TargetState>(`/api/backup?target${refresh ? '&refresh' : ''}`, { method: 'GET' }))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 60_000)
    return () => clearInterval(t)
  }, [load])

  const call = async <T,>(body: unknown, done?: string): Promise<T | undefined> => {
    try {
      const r = await guarded<T>('/api/backup', { body })
      if (r && done) say(done)
      return r
    } catch (e) {
      say((e as Error).message, 'bad')
      return undefined
    }
  }

  const saveClient = async (name: string, plan: ClientPlan, warnDays: number | null) => {
    const a = await call<TargetState>({ client: { plan: { name, plan } } })
    const b = a && (await call<TargetState>({ client: { update: { name, change: { warnDays } } } }, m.backup_clients_saved()))
    if (b) setState(b)
    return !!b
  }
  const linkClient = (name: string) => call<{ token: string; expires: number }>({ client: { link: { name, origin: window.location.origin } } })
  const refresh = useCallback(() => void load(), [load])

  if (error)
    return (
      <p role="alert" className="m-0 text-[13px] text-[#e3b341]">
        {error}
      </p>
    )
  if (!state) return <p className="m-0 text-muted">{m.backup_loading()}</p>
  const cfg = state.config
  const stale = staleClients(state.clients)

  return (
    <>
      {!cfg && (
        <section className="panel flex flex-col items-start gap-3 p-[22px]" aria-label={m.backup_target_label()}>
          <h2 className="h2">{m.backup_target_emptyTitle()}</h2>
          <p className="m-0 max-w-[75ch] text-[13px] text-muted">{m.backup_target_emptyText()}</p>
          {state.clients.length > 0 && <p className="m-0 text-[13px] text-muted">{m.backup_target_kept({ n: state.clients.length })}</p>}
          {!readonly && (
            <button type="button" className="btn primary" onClick={() => setSetup(true)}>
              {m.backup_target_setup()}
            </button>
          )}
        </section>
      )}
      {cfg && (
        <section className="panel flex flex-wrap items-center gap-x-7 gap-y-3 px-[18px] py-4 text-[13px]" aria-label={m.backup_target_label()}>
          <span className="flex items-center gap-2 font-semibold">
            <Dot tone={unit ? unitTone(unit) : 'idle'} label={unit ? unitState(unit) : m.backup_target_notLoaded()} />
            rest-server {unit ? unitState(unit) : m.backup_target_notLoaded()}
          </span>
          <span className="text-subtle">
            {m.backup_target_address()} <span className="font-mono text-fg">{cfg.url}</span>
          </span>
          <span className="text-subtle">
            {m.backup_target_data()} <span className="font-mono text-fg">{cfg.dataDir}</span>
            {state.disk ? ` · ${m.backup_free({ free: bytes(state.disk.free), size: bytes(state.disk.size) })}` : ''}
          </span>
          {cfg.appendOnly && <span className="chip q">append-only</span>}
          <span className="grow" />
          {!readonly && (
            <>
              <button type="button" className="btn sm" onClick={() => setSetup(true)}>
                {m.backup_target_edit()}
              </button>
              <button type="button" className="btn sm danger" onClick={() => setOff(true)}>
                {m.backup_target_off()}
              </button>
            </>
          )}
        </section>
      )}
      {stale.map((s) => (
        <section key={s.name} role="alert" className="flex items-center gap-3 rounded-[12px] border border-[rgba(210,153,34,.35)] bg-[rgba(210,153,34,.08)] px-4 py-3 text-[13px]">
          <Dot tone="warn" />
          <span className="grow">{s.never ? m.backup_alert_clientNever({ name: s.name }) : m.backup_alert_client({ name: s.name, days: s.days })}</span>
        </section>
      ))}
      {cfg && (
        <section className="panel flex flex-col" aria-label={m.backup_clients_title()}>
          <div className="flex flex-wrap items-center gap-3 px-[18px] pt-4 pb-2">
            <h2 className="h2 grow">{m.backup_clients_title()}</h2>
            <button
              type="button"
              className="btn sm"
              disabled={measuring}
              onClick={async () => {
                setMeasuring(true)
                await load(true)
                setMeasuring(false)
              }}
            >
              {measuring ? m.backup_setup_measuring() : m.backup_clients_measure()}
            </button>
            {!readonly && (
              <button type="button" className="btn primary sm" onClick={() => setAdd(true)}>
                {m.backup_clients_add()}
              </button>
            )}
          </div>
          {state.clients.length === 0 ? (
            <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{m.backup_clients_none()}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{m.backup_clients_name()}</th>
                    <th>{m.backup_status_last()}</th>
                    <th>{m.backup_browse_size()}</th>
                    <th>{m.backup_snapshots()}</th>
                    <th>{m.backup_clients_warn()}</th>
                    <th>{m.backup_clients_settings()}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {state.clients.map((c) => {
                    const late = stale.some((s) => s.name === c.name)
                    return (
                      <tr key={c.name} data-testid="backup-client" className={rows.is(c.name) ? 'opacity-60' : undefined} aria-busy={rows.is(c.name) || undefined}>
                        <td>
                          <span className="font-medium">{c.name}</span> {c.disabled && <Pill tone="idle">{m.backup_clients_disabled()}</Pill>}
                        </td>
                        <td>
                          <span className="inline-flex items-center gap-2" suppressHydrationWarning>
                            <Dot tone={c.disabled ? 'idle' : late ? 'warn' : c.lastAt ? 'ok' : 'idle'} />
                            {c.lastAt ? relative(c.lastAt) : m.backup_clients_never()}
                          </span>
                        </td>
                        <td>{c.size !== undefined ? bytes(c.size) : '–'}</td>
                        <td>{c.snapshots ?? 0}</td>
                        <td className="text-subtle">{c.warnDays ? m.backup_clients_warnDays({ n: c.warnDays }) : '–'}</td>
                        <td>
                          <SettingsChip client={c} />
                        </td>
                        <td className="text-right">
                          {!readonly && (
                            <span className="inline-flex items-center gap-2">
                              {rows.is(c.name) && (
                                <span className="inline-flex items-center gap-1.5 text-[12px] text-muted" aria-live="polite">
                                  <Spinner />
                                  {m.common_working()}
                                </span>
                              )}
                              <RowMenu
                                label={m.common_actionsFor({ name: c.name })}
                                items={[
                                  { label: m.backup_clients_edit(), onSelect: () => setEdit(c) },
                                  {
                                    label: m.backup_clients_renew(),
                                    disabled: rows.busy !== null,
                                    onSelect: () =>
                                      void rows.run(c.name, async () => {
                                        const r = await call<{ password: string }>({ client: { renew: c.name } })
                                        if (r) setAccess({ name: c.name, password: r.password })
                                      }),
                                  },
                                  {
                                    label: c.disabled ? m.backup_clients_enable() : m.backup_clients_disable(),
                                    disabled: rows.busy !== null,
                                    onSelect: () =>
                                      void rows.run(c.name, async () => {
                                        const s = await call<TargetState>({ client: { update: { name: c.name, change: { disabled: !c.disabled } } } }, c.disabled ? m.backup_clients_enabled({ name: c.name }) : m.backup_clients_disabledNow({ name: c.name }))
                                        if (s) setState(s)
                                      }),
                                  },
                                  { label: m.common_deleteDots(), danger: true, separator: true, disabled: rows.is(c.name), onSelect: () => setRemove(c) },
                                ]}
                              />
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="m-0 border-t border-line px-[18px] py-3 text-[12px] text-muted">{m.backup_clients_privacy()}</p>
        </section>
      )}

      {setup && (
        <TargetDialog
          config={cfg}
          host={snapshot.host.hostname}
          onClose={() => setSetup(false)}
          onSave={async (config) => {
            const s = await call<TargetState>({ target: { setup: config } }, m.backup_target_saved())
            if (s) {
              setState(s)
              setSetup(false)
            }
          }}
        />
      )}
      {add && cfg && (
        <ClientWizard
          clients={state.clients}
          dataDir={cfg.dataDir}
          onClose={() => setAdd(false)}
          onCreate={async (name) => {
            const r = await call<{ password: string }>({ client: { add: { name } } })
            if (r) await load()
            return !!r
          }}
          onSave={saveClient}
          onLink={linkClient}
          onRefresh={refresh}
        />
      )}
      {access && cfg && <AccessDialog config={cfg} name={access.name} password={access.password} onClose={() => setAccess(null)} />}
      {edit && cfg && (
        <ClientWizard
          client={state.clients.find((c) => c.name === edit.name) ?? edit}
          clients={state.clients}
          dataDir={cfg.dataDir}
          onClose={() => setEdit(null)}
          onCreate={async () => true}
          onSave={saveClient}
          onLink={linkClient}
          onRefresh={refresh}
        />
      )}
      {remove && (
        <RemoveClient
          client={remove}
          dataDir={cfg?.dataDir}
          onClose={() => setRemove(null)}
          onRemove={async (deleteData) => {
            const s = await call<TargetState>({ client: { remove: { name: remove.name, deleteData } } }, m.backup_clients_removed({ name: remove.name }))
            if (s) {
              setState(s)
              setRemove(null)
            }
          }}
        />
      )}
      <ConfirmDialog
        open={off}
        title={m.backup_target_offTitle()}
        body={<p className="m-0">{m.backup_target_offText()}</p>}
        confirm={m.backup_target_off()}
        busyLabel={m.common_applying()}
        danger
        onConfirm={async () => {
          const s = await call<TargetState>({ target: { remove: true } }, m.backup_target_offDone())
          if (s) setState(s)
        }}
        onClose={() => setOff(false)}
      />
    </>
  )
}

function TargetDialog({ config, host, onClose, onSave }: { config?: TargetConfig; host: string; onClose: () => void; onSave: (c: TargetConfig) => Promise<void> }) {
  const [c, setC] = useState<TargetConfig>(config ?? { dataDir: '/srv/backups', port: 8000, appendOnly: false, url: `http://${host || 'server'}:8000` })
  const [busy, setBusy] = useState(false)
  return (
    <Modal open title={config ? m.backup_target_editTitle() : m.backup_target_setupTitle()} onClose={onClose} busy={busy}>
      <p className="m-0 text-[13px] text-muted">{m.backup_target_setupText()}</p>
      <label className="flex flex-col gap-1.5 text-[13px]">
        {m.backup_target_dataDir()}
        <input className="field font-mono" value={c.dataDir} onChange={(e) => setC({ ...c, dataDir: e.target.value.trim() })} />
      </label>
      <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3">
        <label className="flex flex-col gap-1.5 text-[13px]">
          {m.backup_target_port()}
          <input
            className="field"
            type="number"
            min={1}
            max={65535}
            value={c.port}
            onChange={(e) => {
              const port = Math.round(Number(e.target.value) || 0)
              setC({ ...c, port, url: c.url.replace(/:\d+$/, `:${port}`) })
            }}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          {m.backup_target_url()}
          <input className="field font-mono" value={c.url} onChange={(e) => setC({ ...c, url: e.target.value.trim() })} />
        </label>
      </div>
      <p className="m-0 text-[12px] text-muted">{m.backup_target_urlHelp()}</p>
      <label className="flex items-start gap-2.5 text-[13px]">
        <input type="checkbox" className="mt-0.5" checked={c.appendOnly} onChange={(e) => setC({ ...c, appendOnly: e.target.checked })} />
        <span>
          {m.backup_target_appendOnly()}
          <span className="block text-[12px] text-muted">{m.backup_target_appendOnlyHelp()}</span>
        </span>
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {m.common_cancel()}
        </button>
        <BusyButton
          className="btn primary"
          busy={busy}
          busyLabel={config ? m.common_saving() : m.backup_setup_saving()}
          onClick={async () => {
            setBusy(true)
            await onSave(c)
            setBusy(false)
          }}
        >
          {config ? m.common_save() : m.backup_setup_create()}
        </BusyButton>
      </div>
    </Modal>
  )
}

function WarnInput({ warn, days, onChange }: { warn: boolean; days: number; onChange: (warn: boolean, days: number) => void }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-[13px]">
      <input type="checkbox" checked={warn} onChange={(e) => onChange(e.target.checked, days)} />
      {m.backup_clients_warnBefore()}
      <input className="field !w-[64px] !py-1" type="number" min={1} max={60} aria-label={m.backup_clients_warn()} disabled={!warn} value={days} onChange={(e) => onChange(warn, Math.min(60, Math.max(1, Math.round(Number(e.target.value) || 1))))} />
      {m.backup_clients_warnAfter()}
    </label>
  )
}

function RemoveClient({ client, dataDir, onClose, onRemove }: { client: BackupClient; dataDir?: string; onClose: () => void; onRemove: (deleteData: boolean) => Promise<void> }) {
  const [data, setData] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <Modal open title={m.backup_clients_removeTitle({ name: client.name })} onClose={onClose} busy={busy}>
      <p className="m-0 text-[13px]">{m.backup_clients_removeText()}</p>
      <label className="flex items-start gap-2.5 text-[13px]">
        <input type="checkbox" className="mt-0.5" checked={data} disabled={busy} onChange={(e) => setData(e.target.checked)} />
        <span>
          {m.backup_clients_removeData()}
          {dataDir && <span className="block font-mono text-[12px] text-muted">{`${dataDir}/${client.name}`}</span>}
          {data && <span className="mt-1 block text-[#ff8a80]">{m.backup_clients_removeDataWarn()}</span>}
        </span>
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {m.common_cancel()}
        </button>
        <BusyButton
          className="btn danger"
          busy={busy}
          busyLabel={m.common_deleting()}
          onClick={async () => {
            setBusy(true)
            try {
              await onRemove(data)
            } finally {
              setBusy(false)
            }
          }}
        >
          {m.common_delete()}
        </BusyButton>
      </div>
    </Modal>
  )
}

/** The access, shown once: what the client needs to back up here. */
function AccessDialog({ config, name, password, onClose }: { config: TargetConfig; name: string; password: string; onClose: () => void }) {
  const lines = [`export RESTIC_REPOSITORY=${clientRepo(config, name)}`, `export RESTIC_REST_USERNAME=${name}`, `export RESTIC_REST_PASSWORD=${password}`, 'restic init        # once, asks for a new repository password', 'restic backup ~/Dokumente ~/Bilder']
  return (
    <Modal open wide title={m.backup_access_title({ name })} onClose={onClose}>
      <p className="m-0 text-[13px] text-[#e3b341]">{m.backup_access_once()}</p>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-muted">{m.backup_access_repo()}</dt>
        <dd className="m-0 font-mono break-all select-all">{clientRepo(config, name)}</dd>
        <dt className="text-muted">{m.backup_access_user()}</dt>
        <dd className="m-0 font-mono select-all">{name}</dd>
        <dt className="text-muted">{m.backup_access_password()}</dt>
        <dd className="m-0 font-mono break-all select-all" data-testid="client-password">
          {password}
        </dd>
      </dl>
      <p className="m-0 text-[13px] text-muted">{m.backup_access_howto()}</p>
      <pre className="m-0 overflow-x-auto rounded-lg border border-edge bg-[#070a0e] px-3 py-2 font-mono text-[12.5px] leading-relaxed select-all">{lines.join('\n')}</pre>
      <p className="m-0 text-[12px] text-muted">{m.backup_access_repoPassword()}</p>
      <div className="flex justify-end">
        <button type="button" className="btn primary" onClick={onClose}>
          {m.common_close()}
        </button>
      </div>
    </Modal>
  )
}

function SettingsChip({ client: c }: { client: BackupClient }) {
  if (!c.applied) return <span className="chip text-[#e3b341]">{m.backup_clients_notSetUp()}</span>
  if ((c.version ?? 0) > c.applied.version) return <span className="chip text-[#e3b341]">{m.backup_clients_pending()}</span>
  return (
    <span className="chip q" suppressHydrationWarning>
      {m.backup_clients_applied({ when: relative(c.applied.at) })}
    </span>
  )
}

const presetLabel = (p: ClientPreset) =>
  pickMsg(
    {
      caches: m.backup_cpreset_caches,
      trash: m.backup_cpreset_trash,
      dev: m.backup_cpreset_dev,
      temp: m.backup_cpreset_temp,
      downloads: m.backup_cpreset_downloads,
      vms: m.backup_cpreset_vms,
      games: m.backup_cpreset_games,
      nobackup: m.backup_cpreset_nobackup,
    },
    p,
  )

const CLIENT_STEPS = ['what', 'when', 'setup'] as const
type ClientStep = (typeof CLIENT_STEPS)[number]
const clientStepLabel = (s: ClientStep) => pickMsg({ what: m.backup_cwiz_stepWhat, when: m.backup_wizard_stepWhen, setup: m.backup_cwiz_stepSetup }, s)

/** Standard folders in the home: the name in both languages (the script finds either, or the XDG folder). */
const STANDARD_FOLDERS = [
  { de: 'Dokumente', en: 'Documents' },
  { de: 'Bilder', en: 'Pictures' },
  { de: 'Musik', en: 'Music' },
  { de: 'Videos', en: 'Videos' },
  { de: 'Schreibtisch', en: 'Desktop' },
]
const OTHER_FOLDERS = ['~/.ssh', '~/.config']
const RULE_EXAMPLES = ['*.iso', '*.mkv', '**/.git', '**/build', '~/Videos']

const ruleKindLabel = (k: ReturnType<typeof ruleKind>) => pickMsg({ type: m.backup_cwiz_kind_type, pattern: m.backup_cwiz_kind_pattern, path: m.backup_cwiz_kind_path }, k)

/**
 * A client as a wizard: the device and what (with the exclusions), when and how long, then the
 * one-time command for the device. Adding creates the client when leaving "when"; changing one
 * opens on the last step.
 */
function ClientWizard({
  client,
  clients,
  dataDir,
  onCreate,
  onSave,
  onLink,
  onRefresh,
  onClose,
}: {
  /** Undefined while adding. */
  client?: BackupClient
  clients: BackupClient[]
  dataDir: string
  onCreate: (name: string) => Promise<boolean>
  onSave: (name: string, plan: ClientPlan, warnDays: number | null) => Promise<boolean>
  onLink: (name: string) => Promise<{ token: string; expires: number } | undefined>
  onRefresh: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(client?.name ?? '')
  const [created, setCreated] = useState(!!client)
  const [step, setStep] = useState<ClientStep>(client ? 'setup' : 'what')
  // A new device starts with the standard folders named in the UI's language (the script finds either).
  const [plan, setPlan] = useState<ClientPlan>(() => (client?.plan ? structuredClone(client.plan) : { ...defaultClientPlan(), folders: localeOf().startsWith('de') ? ['~/Dokumente', '~/Bilder'] : ['~/Documents', '~/Pictures'] }))
  const [folder, setFolder] = useState('')
  const [rule, setRule] = useState('')
  const [ruleError, setRuleError] = useState(false)
  const [warn, setWarn] = useState(client ? client.warnDays !== undefined : true)
  const [days, setDays] = useState(client?.warnDays ?? 3)
  const [link, setLink] = useState<{ token: string; expires: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const live = clients.find((c) => c.name === name)
  const savedPlan = live?.plan ?? client?.plan
  const savedWarn = live ? live.warnDays : client?.warnDays
  const saved = created && JSON.stringify(plan) === JSON.stringify(savedPlan) && (warn ? days : undefined) === savedWarn
  const set = (p: Partial<ClientPlan>) => setPlan({ ...plan, ...p })
  const url = link ? `${window.location.origin}/api/backup/script/${link.token}` : ''
  const de = localeOf().startsWith('de')
  const waiting = !!link && !!live && (!live.applied || (live.version ?? 0) > live.applied.version)

  // While the device runs the command: look more often, so "set up" shows soon after.
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(onRefresh, 5000)
    return () => clearInterval(t)
  }, [waiting, onRefresh])

  const problem = (s: ClientStep): string | undefined => {
    if (s === 'what' && !created) {
      if (!CLIENT_NAME.test(name)) return m.backup_error_clientName()
      if (clients.some((c) => c.name === name)) return m.backup_error_clientExists({ name })
    }
    return s === 'setup' ? undefined : parseClientPlan(plan).error
  }
  const go = async (to: ClientStep) => {
    for (const s of CLIENT_STEPS.slice(0, CLIENT_STEPS.indexOf(to))) {
      const p = problem(s)
      if (p) {
        setStep(s)
        return setError(p)
      }
    }
    setError('')
    // Entering the last step stores the client and its plan: the command carries what is saved.
    if (to === 'setup' && !saved) {
      setBusy(true)
      try {
        if (!created) {
          if (!(await onCreate(name))) return
          setCreated(true)
        }
        if (!(await onSave(name, plan, warn ? days : null))) return
        setLink(null) // an older command would carry the old plan
      } finally {
        setBusy(false)
      }
    }
    setStep(to)
  }

  const makeLink = async () => {
    setBusy(true)
    try {
      const l = await onLink(name)
      if (l) setLink(l)
    } finally {
      setBusy(false)
    }
  }

  const toggleStandard = (f: { de: string; en: string }, on: boolean) => {
    const both = [`~/${f.de}`, `~/${f.en}`]
    set({ folders: on ? [...plan.folders, `~/${de ? f.de : f.en}`] : plan.folders.filter((x) => !both.includes(x)) })
  }
  const toggleFolder = (f: string, on: boolean) => set({ folders: on ? [...plan.folders.filter((x) => x !== f), f] : plan.folders.filter((x) => x !== f) })
  const addRule = (r: string) => {
    const v = r.trim()
    if (ruleProblem(v)) return setRuleError(true)
    setRuleError(false)
    if (!plan.exclude.patterns.includes(v)) set({ exclude: { ...plan.exclude, patterns: [...plan.exclude.patterns, v] } })
    setRule('')
  }
  const chip = (on: boolean) => `rounded-full border px-3 py-1 text-[12.5px] ${on ? 'border-accent bg-accent/14 text-accent-soft' : 'border-rim bg-sunken text-subtle hover:text-fg'}`
  const exclusions = plan.exclude.presets.length + plan.exclude.patterns.length + (plan.exclude.maxSizeGB ? 1 : 0)

  return (
    <Modal open wide title={client ? client.name : m.backup_clients_addTitle()} onClose={onClose} busy={busy}>
      <ol className="m-0 flex list-none items-center gap-1.5 p-0 text-[12.5px]" aria-label={m.backup_wizard_steps()}>
        {CLIENT_STEPS.map((s, i) => {
          const at = CLIENT_STEPS.indexOf(step)
          return (
            <li key={s} className="flex min-w-0 flex-1 items-center gap-1.5 last:flex-none">
              <button type="button" aria-current={s === step ? 'step' : undefined} disabled={busy} className={`flex shrink-0 items-center gap-1.5 rounded-full border py-1 pr-2.5 pl-1 ${s === step ? 'border-accent bg-accent/12 text-fg' : 'border-rim text-muted hover:text-fg'}`} onClick={() => void go(s)}>
                <span className={`grid size-5 place-items-center rounded-full text-[11px] ${s === step ? 'bg-accent text-bg' : i < at ? 'bg-accent/25 text-accent-soft' : 'bg-raised text-subtle'}`}>{i < at ? '✓' : i + 1}</span>
                <span className="hidden sm:inline">{clientStepLabel(s)}</span>
              </button>
              {i < CLIENT_STEPS.length - 1 && <span className="h-px min-w-2 flex-1 bg-rim" aria-hidden="true" />}
            </li>
          )
        })}
      </ol>

      <div className="flex min-h-[380px] flex-col gap-4">
        {step === 'what' && (
          <>
            {!created && (
              <label className="flex flex-col gap-1.5 text-[13px]">
                {m.backup_cwiz_name()}
                <input className="field font-mono" value={name} placeholder="laptop" autoFocus onChange={(e) => setName(e.target.value.trim().toLowerCase())} />
                <span className="text-[12px] text-muted">{m.backup_cwiz_nameHint({ dir: `${dataDir}/${name || 'laptop'}` })}</span>
              </label>
            )}
            <section className="flex flex-col gap-2.5" aria-label={m.backup_client_what()}>
              <h3 className="label-caps m-0 font-normal">{m.backup_cwiz_what()}</h3>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={m.backup_cwiz_quick()}>
                {STANDARD_FOLDERS.map((f) => {
                  const on = plan.folders.includes(`~/${f.de}`) || plan.folders.includes(`~/${f.en}`)
                  return (
                    <button key={f.en} type="button" aria-pressed={on} className={chip(on)} onClick={() => toggleStandard(f, !on)}>
                      {on && '✓ '}
                      {de ? f.de : f.en}
                    </button>
                  )
                })}
                {OTHER_FOLDERS.map((f) => (
                  <button key={f} type="button" aria-pressed={plan.folders.includes(f)} className={`${chip(plan.folders.includes(f))} font-mono`} onClick={() => toggleFolder(f, !plan.folders.includes(f))}>
                    {plan.folders.includes(f) && '✓ '}
                    {f}
                  </button>
                ))}
                <button type="button" aria-pressed={plan.folders.includes('~')} className={chip(plan.folders.includes('~'))} onClick={() => toggleFolder('~', !plan.folders.includes('~'))}>
                  {plan.folders.includes('~') && '✓ '}
                  {m.backup_cwiz_wholeHome()}
                </button>
              </div>
              <p className="m-0 text-[12px] text-muted">{m.backup_cwiz_xdgHint()}</p>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label={m.backup_client_what()}>
                {plan.folders.map((f) => (
                  <li key={f} className="flex items-center gap-2 rounded-lg border border-edge bg-sunken px-2.5 py-1.5 text-[13px]">
                    <span className="grow font-mono">{f}</span>
                    <button type="button" className="text-muted hover:text-fg" aria-label={m.backup_client_removeFolder({ folder: f })} onClick={() => set({ folders: plan.folders.filter((x) => x !== f) })}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  const v = folder.trim().replace(/\/+$/, '')
                  if (v && !plan.folders.includes(v)) set({ folders: [...plan.folders, v] })
                  setFolder('')
                }}
              >
                <input className="field font-mono" value={folder} placeholder={m.backup_clients_folderPlaceholder()} aria-label={m.backup_setup_addFolder()} onChange={(e) => setFolder(e.target.value)} />
                <button type="submit" className="btn" disabled={!folder.trim()}>
                  {m.backup_setup_add()}
                </button>
              </form>
            </section>

            <section className="flex flex-col gap-2.5" aria-label={m.backup_setup_excludes()}>
              <h3 className="label-caps m-0 font-normal">{m.backup_setup_excludes()}</h3>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={m.backup_cwiz_presets()}>
                {CLIENT_PRESETS.map((p) => {
                  const on = plan.exclude.presets.includes(p)
                  return (
                    <button key={p} type="button" aria-pressed={on} className={chip(on)} onClick={() => set({ exclude: { ...plan.exclude, presets: on ? plan.exclude.presets.filter((x) => x !== p) : [...plan.exclude.presets, p] } })}>
                      {on && '✓ '}
                      {presetLabel(p)}
                    </button>
                  )
                })}
              </div>
              <span className="text-[13px]">{m.backup_cwiz_own()}</span>
              {plan.exclude.patterns.length > 0 && (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label={m.backup_cwiz_own()}>
                  {plan.exclude.patterns.map((r) => (
                    <li key={r} className="flex items-center gap-2 rounded-lg border border-edge bg-sunken px-2.5 py-1.5 text-[13px]">
                      <span className="font-mono">{r}</span>
                      <span className="chip">{ruleKindLabel(ruleKind(r))}</span>
                      <span className="grow" />
                      <button type="button" className="text-muted hover:text-fg" aria-label={m.backup_cwiz_removeRule({ rule: r })} onClick={() => set({ exclude: { ...plan.exclude, patterns: plan.exclude.patterns.filter((x) => x !== r) } })}>
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  addRule(rule)
                }}
              >
                <input className={`field font-mono ${ruleError ? 'border-[#f85149]!' : ''}`} value={rule} placeholder={m.backup_cwiz_rulePlaceholder()} aria-label={m.backup_cwiz_addRule()} aria-invalid={ruleError || undefined} onChange={(e) => (setRule(e.target.value), setRuleError(false))} />
                <button type="submit" className="btn" disabled={!rule.trim()}>
                  {m.backup_setup_add()}
                </button>
              </form>
              {ruleError && <p className="m-0 text-[12px] text-[#ff8a80]">{m.backup_cwiz_ruleInvalid()}</p>}
              <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                {m.backup_cwiz_examples()}
                {RULE_EXAMPLES.filter((x) => !plan.exclude.patterns.includes(x)).map((x) => (
                  <button key={x} type="button" className="rounded-[5px] bg-raised px-1.5 py-0.5 font-mono text-subtle hover:text-fg" aria-label={m.backup_cwiz_addExample({ rule: x })} onClick={() => addRule(x)}>
                    + {x}
                  </button>
                ))}
              </div>
              <p className="m-0 text-[12px] text-muted">{m.backup_setup_patternsHelp()}</p>
              <label className="flex flex-wrap items-center gap-2 text-[13px]">
                <input type="checkbox" checked={!!plan.exclude.maxSizeGB} onChange={(e) => set({ exclude: { ...plan.exclude, maxSizeGB: e.target.checked ? 2 : undefined } })} />
                {m.backup_setup_maxSizeBefore()}
                <input className="field !w-[64px] !py-1" type="number" min={1} aria-label={m.backup_setup_maxSizeLabel()} disabled={!plan.exclude.maxSizeGB} value={plan.exclude.maxSizeGB ?? 2} onChange={(e) => set({ exclude: { ...plan.exclude, maxSizeGB: Math.max(1, Number(e.target.value) || 1) } })} />
                {m.backup_setup_maxSizeAfter()}
              </label>
              <p className="m-0 text-[12px] text-muted">
                {m.backup_cwiz_checkHint()} <code className="font-mono text-subtle">quadeck-backup check</code>
              </p>
            </section>
          </>
        )}

        {step === 'when' && (
          <>
            <section className="flex flex-col gap-2.5 rounded-[10px] border border-rim p-3.5" aria-label={m.backup_setup_when()}>
              <h3 className="m-0 text-[14px] font-semibold">{m.backup_setup_when()}</h3>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={m.backup_wizard_every()}>
                  {(['hourly', '6h', 'daily', 'weekly'] as const).map((e) => (
                    <button key={e} type="button" role="radio" aria-checked={plan.schedule.every === e} className={`btn ${plan.schedule.every === e ? 'border-accent! bg-accent/14! text-accent-soft' : ''}`} onClick={() => set({ schedule: { ...plan.schedule, every: e } })}>
                      {pickMsg({ hourly: m.backup_client_hourly, '6h': m.backup_setup_6h, daily: m.backup_setup_daily, weekly: m.backup_setup_weekly }, e)}
                    </button>
                  ))}
                </div>
                <label className="flex flex-col gap-1.5 text-[13px]">
                  {m.backup_setup_time()}
                  <input className="field w-[110px]" type="time" value={plan.schedule.time} onChange={(e) => e.target.value && set({ schedule: { ...plan.schedule, time: e.target.value } })} />
                </label>
              </div>
              <p className="m-0 text-[12px] text-muted">{m.backup_client_persistent({ calendar: clientCalendar(plan.schedule) })}</p>
            </section>
            <section className="flex flex-col gap-2.5 rounded-[10px] border border-rim p-3.5" aria-label={m.backup_wizard_retention()}>
              <h3 className="m-0 text-[14px] font-semibold">{m.backup_wizard_retention()}</h3>
              <RetentionPicker keep={plan.keep} onChange={(keep) => set({ keep })} />
            </section>
            <section className="flex flex-col gap-2.5 rounded-[10px] border border-rim p-3.5" aria-label={m.backup_cwiz_missing()}>
              <h3 className="m-0 text-[14px] font-semibold">{m.backup_cwiz_missing()}</h3>
              <WarnInput warn={warn} days={days} onChange={(w, d) => (setWarn(w), setDays(d))} />
              <label className="flex items-center gap-2.5 text-[13px]">
                <input type="checkbox" checked={plan.active} onChange={(e) => set({ active: e.target.checked })} />
                {m.backup_client_active()}
              </label>
            </section>
          </>
        )}

        {step === 'setup' && (
          <>
            <dl className="m-0 grid grid-cols-[minmax(80px,120px)_1fr_auto] overflow-hidden rounded-[10px] border border-rim text-[13px]">
              <dt className="border-b border-line px-3 py-2.5 text-muted">{m.backup_cwiz_device()}</dt>
              <dd className="m-0 border-b border-line px-3 py-2.5 font-mono break-all">
                {name} → {dataDir}/{name}
              </dd>
              <div className="border-b border-line px-3 py-2.5" />
              <dt className="border-b border-line px-3 py-2.5 text-muted">{m.backup_setup_what()}</dt>
              <dd className="m-0 border-b border-line px-3 py-2.5">
                {m.backup_wizard_whatSummary({ count: plan.folders.length })} · {m.backup_wizard_excludeSummary({ count: exclusions })}
              </dd>
              <div className="border-b border-line px-3 py-2.5 text-right">
                <button type="button" className="text-[12.5px] text-accent hover:text-accent-soft" aria-label={m.backup_wizard_changeStep({ step: m.backup_setup_what() })} onClick={() => void go('what')}>
                  {m.backup_wizard_change()}
                </button>
              </div>
              <dt className="px-3 py-2.5 text-muted">{m.backup_wizard_stepWhen()}</dt>
              <dd className="m-0 px-3 py-2.5">
                {pickMsg({ hourly: m.backup_client_hourly, '6h': m.backup_setup_6h, daily: m.backup_setup_daily, weekly: m.backup_setup_weekly }, plan.schedule.every)} · {retentionPresetLabel(retentionPreset(plan.keep))}
                {plan.active ? '' : ` · ${m.backup_clients_disabled()}`}
              </dd>
              <div className="px-3 py-2.5 text-right">
                <button type="button" className="text-[12.5px] text-accent hover:text-accent-soft" aria-label={m.backup_wizard_changeStep({ step: m.backup_wizard_stepWhen() })} onClick={() => void go('when')}>
                  {m.backup_wizard_change()}
                </button>
              </div>
            </dl>

            <section className="flex flex-col gap-3 rounded-[12px] border border-accent/35 bg-accent/6 p-4" aria-label={m.backup_client_run()}>
              <div className="flex flex-wrap items-center gap-2.5">
                <h3 className="m-0 grow text-[14px] font-semibold">{m.backup_client_run()}</h3>
                {live && <SettingsChip client={live} />}
              </div>
              <ol className="m-0 flex list-none flex-col gap-3 p-0 text-[13px]">
                <Numbered n={1}>{m.backup_cwiz_run1()}</Numbered>
                <Numbered n={2}>
                  {m.backup_cwiz_run2()}
                  {link ? (
                    <>
                      <code className="mt-1.5 block rounded-lg border border-edge bg-[#070a0e] px-3 py-2 font-mono text-[12.5px] break-all select-all" data-testid="client-command">
                        curl -fsSL {url} | sh
                      </code>
                      <span className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                        <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(`curl -fsSL ${url} | sh`)}>
                          {m.backup_client_copy()}
                        </button>
                        <span suppressHydrationWarning>{m.backup_client_valid({ when: relative(link.expires) })}</span>
                      </span>
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-subtle">{m.backup_client_review()}</summary>
                        <code className="mt-2 block rounded-lg border border-edge bg-[#070a0e] px-3 py-2 font-mono text-[12.5px] break-all whitespace-pre-wrap select-all">{`curl -fsSL ${url} -o quadeck-backup-setup.sh\nless quadeck-backup-setup.sh\nsh quadeck-backup-setup.sh`}</code>
                      </details>
                    </>
                  ) : (
                    <span className="mt-1.5 block">
                      <BusyButton className="btn primary" busy={busy} busyLabel={m.common_creating()} disabled={busy || !saved} onClick={() => void makeLink()}>
                        {m.backup_client_makeLink()}
                      </BusyButton>
                    </span>
                  )}
                </Numbered>
                <Numbered n={3}>{m.backup_cwiz_run3()}</Numbered>
              </ol>
              {waiting && (
                <p className="m-0 flex items-center gap-2 text-[13px] text-[#e3b341]" role="status">
                  <Spinner /> {m.backup_cwiz_waiting()}
                </p>
              )}
              <p className="m-0 text-[12px] text-muted">{m.backup_client_runText()}</p>
              <details className="text-[13px]">
                <summary className="cursor-pointer text-subtle">{m.backup_client_after()}</summary>
                <pre className="mt-2 mb-0 overflow-x-auto rounded-lg border border-edge bg-[#070a0e] px-3 py-2 font-mono text-[12.5px] leading-relaxed">
                  {['quadeck-backup check      # how big, with the exclusions (dry run)', 'quadeck-backup now        # back up right now', 'quadeck-backup status     # last backups, next run', 'quadeck-backup mount      # backups as folders under ~/Backup', 'quadeck-backup restore ~/Dokumente/x', 'quadeck-backup uninstall  # remove the timer'].join('\n')}
                </pre>
              </details>
            </section>
          </>
        )}
      </div>

      {error && (
        <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
          {error}
        </p>
      )}
      <div className="flex justify-between gap-2 border-t border-line pt-4">
        {step === 'what' || (client && step === 'setup') ? (
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {step === 'setup' ? m.common_close() : m.common_cancel()}
          </button>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={() => void go(CLIENT_STEPS[CLIENT_STEPS.indexOf(step) - 1]!)}>
            ← {m.backup_wizard_back()}
          </button>
        )}
        {step === 'setup' ? (
          <button type="button" className="btn primary" onClick={onClose}>
            {m.backup_cwiz_done()}
          </button>
        ) : (
          <BusyButton className="btn primary" busy={busy} busyLabel={m.common_saving()} disabled={busy} onClick={() => void go(CLIENT_STEPS[CLIENT_STEPS.indexOf(step) + 1]!)}>
            {m.backup_wizard_next()} →
          </BusyButton>
        )}
      </div>
    </Modal>
  )
}

function Numbered({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-raised text-[12px] text-accent-soft">{n}</span>
      <span className="min-w-0 grow pt-0.5">{children}</span>
    </li>
  )
}
