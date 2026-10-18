import { useCallback, useEffect, useState } from 'react'
import { pickMsg } from '~/i18n'
import { api } from '~/lib/api'
import { bytes, relative } from '~/lib/format'
import { useLiveState } from '~/lib/live'
import { m } from '~/paraglide/messages'
import {
  type BackupClient,
  CLIENT_NAME,
  type ClientAction,
  type ClientChangedBy,
  clientConnected,
  clientOnline,
  clientRepo,
  staleClients,
  TARGET_UNIT,
  type TargetConfig,
  type TargetState,
  targetHost,
} from '~/shared/backup'
import { type ClientInventory, inventoryHints, inventoryListing } from '~/shared/backup-agent'
import {
  CLIENT_PRESETS,
  type ClientLink,
  type ClientPlan,
  type ClientPreset,
  clientCalendar,
  parseClientPlan,
  recommendedClientPlan,
  reviewCommands,
  ruleKind,
  ruleProblem,
  setupCommand,
} from '~/shared/backup-client'
import { localeOf } from '~/shared/i18n'
import { useActions } from './Actions'
import { BusyButton, Spinner, useBusy } from './Busy'
import { FolderPicker, FolderPickerDialog } from './FolderPicker'
import { ConfirmDialog, Modal } from './Modal'
import { RetentionPicker } from './Retention'
import { RowMenu } from './RowMenu'
import { Dot, Pill, unitState, unitTone } from './Status'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'

/** Clients tab: a restic rest-server as the backup target for the other computers at home. */
export function BackupClients() {
  const [state, setState] = useState<TargetState | null>(null)
  const [error, setError] = useState('')
  const [setup, setSetup] = useState(false)
  const [add, setAdd] = useState(false)
  const [access, setAccess] = useState<{ name: string; password: string } | null>(null)
  const [edit, setEdit] = useState<string | null>(null)
  const [command, setCommand] = useState<string | null>(null)
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

  // While a task waits for a computer: look more often, so the row shows soon when it was taken.
  const queued = !!state?.clients.some((c) => c.actions?.length)
  useEffect(() => {
    if (!queued) return
    const t = setInterval(() => void load(), 10_000)
    return () => clearInterval(t)
  }, [queued, load])

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
    const b = a && (await call<TargetState>({ client: { update: { name, change: { warnDays } } } }, m.backup_clients_savedPlan({ name })))
    if (b) setState(b)
    return !!b
  }
  const adopt = (name: string) =>
    rows.run(name, async () => {
      const s = await call<TargetState>({ client: { plan: { name, plan: recommendedClientPlan(localeOf().startsWith('de')) } } }, m.backup_clients_savedPlan({ name }))
      if (s) setState(s)
    })
  const act = (name: string, action: ClientAction) =>
    rows.run(name, async () => {
      const s = await call<TargetState>({ client: { action: { name, action } } }, action === 'run' ? m.backup_clients_runAsked({ name }) : m.backup_clients_scanAsked({ name }))
      if (s) setState(s)
    })
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
            <div className="relative overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{m.backup_clients_name()}</th>
                    <th>{m.backup_clients_device()}</th>
                    <th>{m.backup_status_last()}</th>
                    <th>{m.backup_browse_size()}</th>
                    <th>{m.backup_snapshots()}</th>
                    <th>{m.backup_clients_warn()}</th>
                    <th>{m.backup_clients_plan()}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {state.clients.map((c) => {
                    const late = stale.some((s) => s.name === c.name)
                    const connected = clientConnected(c)
                    return (
                      <tr key={c.name} data-testid="backup-client" className={rows.is(c.name) ? 'opacity-60' : undefined} aria-busy={rows.is(c.name) || undefined}>
                        <td>
                          <span className="font-medium">{c.name}</span> {c.disabled && <Pill tone="idle">{m.backup_clients_disabled()}</Pill>}
                        </td>
                        <td>
                          <DeviceCell client={c} />
                        </td>
                        <td>
                          <span className="inline-flex items-center gap-2" suppressHydrationWarning>
                            <Dot tone={c.disabled ? 'idle' : c.runs?.[0]?.status === 'failed' ? 'bad' : late || c.runs?.[0]?.status === 'warning' ? 'warn' : c.lastAt ? 'ok' : 'idle'} />
                            {c.lastAt ? relative(c.lastAt) : m.backup_clients_never()}
                          </span>
                          {c.runs?.[0] && c.runs[0].status !== 'ok' && (
                            <span
                              className={`block max-w-[38ch] truncate text-[12px] ${c.runs[0].status === 'failed' ? 'text-[#ff8a80]' : 'text-[#e3b341]'}`}
                              title={c.runs[0].message ?? c.runs[0].errors.join('\n')}
                            >
                              {(c.runs[0].status === 'failed' ? m.backup_clients_runFailed : m.backup_clients_runWarning)({ message: c.runs[0].message ?? c.runs[0].errors[0] ?? '' })}
                            </span>
                          )}
                        </td>
                        <td>{c.size !== undefined ? bytes(c.size) : '–'}</td>
                        <td>{c.snapshots ?? 0}</td>
                        <td className="text-subtle">{c.warnDays ? m.backup_clients_warnDays({ n: c.warnDays }) : '–'}</td>
                        <td>
                          <PlanCell client={c} readonly={readonly} busy={rows.busy !== null} onCommand={() => setCommand(c.name)} onPlan={() => setEdit(c.name)} onAdopt={() => void adopt(c.name)} />
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
                                  {
                                    label: m.backup_clients_runNow(),
                                    disabled: rows.busy !== null || !c.plan || !connected || !!c.disabled,
                                    onSelect: () => void act(c.name, 'run'),
                                  },
                                  { label: m.backup_clients_scanNow(), disabled: rows.busy !== null || !connected || !!c.disabled, onSelect: () => void act(c.name, 'scan') },
                                  { label: m.backup_clients_edit(), separator: true, onSelect: () => setEdit(c.name) },
                                  { label: m.backup_clients_showCommand(), onSelect: () => setCommand(c.name) },
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
                                        const s = await call<TargetState>(
                                          { client: { update: { name: c.name, change: { disabled: !c.disabled } } } },
                                          c.disabled ? m.backup_clients_enabled({ name: c.name }) : m.backup_clients_disabledNow({ name: c.name }),
                                        )
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
        <AddClient
          clients={state.clients}
          dataDir={cfg.dataDir}
          onClose={() => setAdd(false)}
          onCreate={async (name) => {
            // Warn after 3 days without a backup, as before; changed in the editor.
            const r = await call<{ password: string }>({ client: { add: { name, warnDays: 3 } } })
            if (r) await load()
            return !!r
          }}
          onLink={linkClient}
          onRefresh={refresh}
          onPlan={(name) => {
            setAdd(false)
            setEdit(name)
          }}
        />
      )}
      {command && cfg && state.clients.some((c) => c.name === command) && (
        <CommandDialog client={state.clients.find((c) => c.name === command)!} onClose={() => setCommand(null)} onLink={linkClient} onRefresh={refresh} />
      )}
      {access && cfg && <AccessDialog config={cfg} name={access.name} password={access.password} onClose={() => setAccess(null)} />}
      {edit && cfg && state.clients.some((c) => c.name === edit) && <ClientEditor client={state.clients.find((c) => c.name === edit)!} onClose={() => setEdit(null)} onSave={saveClient} />}
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
  const [c, setC] = useState<TargetConfig>(config ?? { dataDir: '/srv/backups', port: 8000, appendOnly: false, url: `http://${targetHost(window.location.hostname, host)}:8000` })
  const [busy, setBusy] = useState(false)
  return (
    <Modal open title={config ? m.backup_target_editTitle() : m.backup_target_setupTitle()} onClose={onClose} busy={busy}>
      <p className="m-0 text-[13px] text-muted">{m.backup_target_setupText()}</p>
      <label className="flex flex-col gap-1.5 text-[13px]">
        {m.backup_target_dataDir()}
        <input className="field font-mono" value={c.dataDir} onChange={(e) => setC({ ...c, dataDir: e.target.value.trim() })} />
      </label>
      <FolderPicker target value={c.dataDir} onChange={(dataDir) => setC({ ...c, dataDir })} />
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
      <input
        className="field !w-[64px] !py-1"
        type="number"
        min={1}
        max={60}
        aria-label={m.backup_clients_warn()}
        disabled={!warn}
        value={days}
        onChange={(e) => onChange(warn, Math.min(60, Math.max(1, Math.round(Number(e.target.value) || 1))))}
      />
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
  const lines = [
    `export RESTIC_REPOSITORY=${clientRepo(config, name)}`,
    `export RESTIC_REST_USERNAME=${name}`,
    `export RESTIC_REST_PASSWORD=${password}`,
    'restic init        # once, asks for a new repository password',
    'restic backup ~/Dokumente ~/Bilder',
  ]
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

const actionLabel = (a: ClientAction) => pickMsg({ run: m.backup_clients_runNow, scan: m.backup_clients_scanNow, sync: m.backup_clients_actionSync }, a)

/** Is the computer there: online (seen within 25 minutes), when it was last seen, or not connected yet. */
function DeviceCell({ client: c }: { client: BackupClient }) {
  const seen = c.lastSeen ?? c.applied?.at
  return (
    <>
      <span className="inline-flex items-center gap-2 whitespace-nowrap" suppressHydrationWarning>
        <Dot tone={!clientConnected(c) ? 'idle' : clientOnline(c) ? 'ok' : 'idle'} />
        {!clientConnected(c) ? m.backup_clients_notConnected() : clientOnline(c) ? m.backup_clients_online({ when: relative(seen) }) : m.backup_clients_seen({ when: relative(seen) })}
      </span>
      {c.actions?.length ? <span className="block text-[12px] text-muted">{m.backup_clients_queued({ what: c.actions.map(actionLabel).join(', ') })}</span> : null}
    </>
  )
}

const changedLabel = (by: ClientChangedBy, when: string) =>
  by === 'cli' ? m.backup_clients_changedCli({ when }) : by === 'client' ? m.backup_clients_changedClient({ when }) : m.backup_clients_changedUi({ when })

/** The plan: not connected yet (with its command), connected without a plan (with ways to set one), or its version and whether the computer runs it. */
function PlanCell({
  client: c,
  readonly,
  busy,
  onCommand,
  onPlan,
  onAdopt,
}: {
  client: BackupClient
  readonly: boolean
  busy: boolean
  onCommand: () => void
  onPlan: () => void
  onAdopt: () => void
}) {
  if (!clientConnected(c))
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="chip text-[#e3b341]">{m.backup_clients_notConnectedYet()}</span>
        {!readonly && (
          <button type="button" className="btn sm" onClick={onCommand}>
            {m.backup_clients_showCommand()}
          </button>
        )}
      </span>
    )
  if (!c.plan)
    return (
      <span className="flex max-w-[52ch] flex-col items-start gap-1.5">
        <span className="chip text-[#e3b341]">{m.backup_clients_noPlan()}</span>
        {!readonly && (
          <span className="flex flex-wrap gap-1.5">
            <button type="button" className="btn sm primary" disabled={busy} onClick={onPlan}>
              {m.backup_clients_setPlan()}
            </button>
            <button type="button" className="btn sm" disabled={busy} onClick={onAdopt}>
              {m.backup_clients_adopt()}
            </button>
          </span>
        )}
        <span className="text-[12px] whitespace-normal text-muted">
          {m.backup_clients_agentServer()} <code className="font-mono text-subtle">quadeck backup client plan set {c.name} -f plan.json</code> · {m.backup_clients_agentDevice()}{' '}
          <code className="font-mono text-subtle">quadeck-backup plan set</code>
        </span>
      </span>
    )
  const waiting = (c.applied?.version ?? -1) < (c.version ?? 0)
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12.5px]">v{c.version ?? 0}</span>
        {waiting ? <span className="chip text-[#e3b341]">{m.backup_clients_waiting()}</span> : <span className="chip q">{m.backup_clients_arrived()}</span>}
        {!c.plan.active && <Pill tone="idle">{m.backup_clients_paused()}</Pill>}
      </span>
      {c.changed && (
        <span className="text-[12px] text-muted" suppressHydrationWarning>
          {changedLabel(c.changed.by, relative(c.changed.at))}
        </span>
      )}
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

/** A mark from a client's scan: the preset that leaves it out, or a git project. */
const markLabel = (k: string) => (k === 'git' ? m.backup_mark_git() : (CLIENT_PRESETS as string[]).includes(k) ? presetLabel(k as ClientPreset) : k)

const EDITOR_TABS = ['what', 'when'] as const
type EditorTab = (typeof EDITOR_TABS)[number]
const editorTabLabel = (t: EditorTab) => pickMsg({ what: m.backup_setup_what, when: m.backup_wizard_stepWhen }, t)

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
 * A client's plan: what (with the exclusions) and when (schedule, retention, warning). Saved in
 * Quadeck; the computer takes it within about 10 minutes (its agent timer) or before its next
 * backup. A client without a plan starts from the recommended one.
 */
function ClientEditor({ client: c, onSave, onClose }: { client: BackupClient; onSave: (name: string, plan: ClientPlan, warnDays: number | null) => Promise<boolean>; onClose: () => void }) {
  const name = c.name
  const de = localeOf().startsWith('de')
  const [tab, setTab] = useState<EditorTab>('what')
  const [plan, setPlan] = useState<ClientPlan>(() => (c.plan ? structuredClone(c.plan) : recommendedClientPlan(de)))
  const [folder, setFolder] = useState('')
  const [rule, setRule] = useState('')
  const [ruleError, setRuleError] = useState(false)
  const [warn, setWarn] = useState(c.warnDays !== undefined)
  const [days, setDays] = useState(c.warnDays ?? 3)
  const [inventory, setInventory] = useState<ClientInventory | null>(null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (p: Partial<ClientPlan>) => setPlan({ ...plan, ...p })

  // The folders the device last reported, for the folder browser and the hints.
  const scannedAt = c.scannedAt
  useEffect(() => {
    if (!scannedAt) return
    let stale = false
    api<ClientInventory | null>(`/api/backup?inventory=${encodeURIComponent(name)}`, { method: 'GET' })
      .then((inv) => !stale && setInventory(inv))
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [name, scannedAt])
  const hints = inventory ? inventoryHints(inventory, plan).filter((h) => h.bytes > 0) : []

  const save = async () => {
    const p = parseClientPlan(plan).error
    if (p) {
      setTab('what')
      return setError(p)
    }
    setError('')
    setBusy(true)
    try {
      if (await onSave(name, plan, warn ? days : null)) onClose()
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

  return (
    <Modal open wide title={name} onClose={onClose} busy={busy}>
      {!c.plan && <p className="m-0 text-[13px] text-muted">{m.backup_editor_fromRecommended()}</p>}
      <div role="tablist" aria-label={m.backup_clients_plan()} className="flex flex-wrap gap-1.5">
        {EDITOR_TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`seg ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
            {editorTabLabel(t)}
          </button>
        ))}
      </div>

      <div className="flex min-h-[380px] flex-col gap-4">
        {tab === 'what' && (
          <>
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
                  <button
                    key={f}
                    type="button"
                    aria-pressed={plan.folders.includes(f)}
                    className={`${chip(plan.folders.includes(f))} font-mono`}
                    onClick={() => toggleFolder(f, !plan.folders.includes(f))}
                  >
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
                    <button
                      type="button"
                      className="text-muted hover:text-fg"
                      aria-label={m.backup_client_removeFolder({ folder: f })}
                      onClick={() => set({ folders: plan.folders.filter((x) => x !== f) })}
                    >
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
                <input
                  className="field font-mono"
                  value={folder}
                  placeholder={m.backup_clients_folderPlaceholder()}
                  aria-label={m.backup_setup_addFolder()}
                  onChange={(e) => setFolder(e.target.value)}
                />
                <button type="submit" className="btn" disabled={!folder.trim()}>
                  {m.backup_setup_add()}
                </button>
              </form>
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted" data-testid="client-folders-source">
                {inventory ? (
                  <>
                    <button type="button" className="btn sm" onClick={() => setPicking(true)}>
                      {m.backup_cwiz_browse()}
                    </button>
                    <span suppressHydrationWarning>{m.backup_cwiz_scanned({ when: relative(inventory.at) })}</span>
                  </>
                ) : (
                  <span>{c.agent ? m.backup_cwiz_noScan() : m.backup_cwiz_oldScript()}</span>
                )}
              </div>
            </section>

            <section className="flex flex-col gap-2.5" aria-label={m.backup_setup_excludes()}>
              <h3 className="label-caps m-0 font-normal">{m.backup_setup_excludes()}</h3>
              {hints.map((h) => (
                <p key={h.preset} className="m-0 flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-sunken px-2.5 py-1.5 text-[12.5px]" data-testid="client-hint">
                  <span className="grow">
                    {m.backup_cwiz_hint({ what: presetLabel(h.preset), size: bytes(h.bytes) })}
                    <span className="ml-1.5 font-mono text-muted">
                      {h.paths.slice(0, 2).join(', ')}
                      {h.paths.length > 2 ? ' …' : ''}
                    </span>
                  </span>
                  {h.on ? (
                    <span className="text-[#7ee2a8]">{m.backup_cwiz_hintOn()}</span>
                  ) : (
                    <button type="button" className="btn sm" onClick={() => set({ exclude: { ...plan.exclude, presets: [...plan.exclude.presets, h.preset] } })}>
                      {m.backup_cwiz_hintAdd()}
                    </button>
                  )}
                </p>
              ))}
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={m.backup_cwiz_presets()}>
                {CLIENT_PRESETS.map((p) => {
                  const on = plan.exclude.presets.includes(p)
                  return (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={on}
                      className={chip(on)}
                      onClick={() => set({ exclude: { ...plan.exclude, presets: on ? plan.exclude.presets.filter((x) => x !== p) : [...plan.exclude.presets, p] } })}
                    >
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
                      <button
                        type="button"
                        className="text-muted hover:text-fg"
                        aria-label={m.backup_cwiz_removeRule({ rule: r })}
                        onClick={() => set({ exclude: { ...plan.exclude, patterns: plan.exclude.patterns.filter((x) => x !== r) } })}
                      >
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
                <input
                  className={`field font-mono ${ruleError ? 'border-[#f85149]!' : ''}`}
                  value={rule}
                  placeholder={m.backup_cwiz_rulePlaceholder()}
                  aria-label={m.backup_cwiz_addRule()}
                  aria-invalid={ruleError || undefined}
                  onChange={(e) => {
                    setRule(e.target.value)
                    setRuleError(false)
                  }}
                />
                <button type="submit" className="btn" disabled={!rule.trim()}>
                  {m.backup_setup_add()}
                </button>
              </form>
              {ruleError && <p className="m-0 text-[12px] text-[#ff8a80]">{m.backup_cwiz_ruleInvalid()}</p>}
              <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                {m.backup_cwiz_examples()}
                {RULE_EXAMPLES.filter((x) => !plan.exclude.patterns.includes(x)).map((x) => (
                  <button
                    key={x}
                    type="button"
                    className="rounded-[5px] bg-raised px-1.5 py-0.5 font-mono text-subtle hover:text-fg"
                    aria-label={m.backup_cwiz_addExample({ rule: x })}
                    onClick={() => addRule(x)}
                  >
                    + {x}
                  </button>
                ))}
              </div>
              <p className="m-0 text-[12px] text-muted">{m.backup_setup_patternsHelp()}</p>
              <label className="flex flex-wrap items-center gap-2 text-[13px]">
                <input type="checkbox" checked={!!plan.exclude.maxSizeGB} onChange={(e) => set({ exclude: { ...plan.exclude, maxSizeGB: e.target.checked ? 2 : undefined } })} />
                {m.backup_setup_maxSizeBefore()}
                <input
                  className="field !w-[64px] !py-1"
                  type="number"
                  min={1}
                  aria-label={m.backup_setup_maxSizeLabel()}
                  disabled={!plan.exclude.maxSizeGB}
                  value={plan.exclude.maxSizeGB ?? 2}
                  onChange={(e) => set({ exclude: { ...plan.exclude, maxSizeGB: Math.max(1, Number(e.target.value) || 1) } })}
                />
                {m.backup_setup_maxSizeAfter()}
              </label>
              <p className="m-0 text-[12px] text-muted">
                {m.backup_cwiz_checkHint()} <code className="font-mono text-subtle">quadeck-backup check</code>
              </p>
            </section>
          </>
        )}

        {tab === 'when' && (
          <>
            <section className="flex flex-col gap-2.5 rounded-[10px] border border-rim p-3.5" aria-label={m.backup_setup_when()}>
              <h3 className="m-0 text-[14px] font-semibold">{m.backup_setup_when()}</h3>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={m.backup_wizard_every()}>
                  {(['hourly', '6h', 'daily', 'weekly'] as const).map((e) => (
                    <button
                      key={e}
                      type="button"
                      role="radio"
                      aria-checked={plan.schedule.every === e}
                      className={`btn ${plan.schedule.every === e ? 'border-accent! bg-accent/14! text-accent-soft' : ''}`}
                      onClick={() => set({ schedule: { ...plan.schedule, every: e } })}
                    >
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
              <WarnInput
                warn={warn}
                days={days}
                onChange={(w, d) => {
                  setWarn(w)
                  setDays(d)
                }}
              />
              <label className="flex items-center gap-2.5 text-[13px]">
                <input type="checkbox" checked={plan.active} onChange={(e) => set({ active: e.target.checked })} />
                {m.backup_client_active()}
              </label>
            </section>
          </>
        )}
      </div>

      {error && (
        <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
          {error}
        </p>
      )}
      <p className="m-0 text-[12px] text-muted">{m.backup_editor_arrives()}</p>
      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {m.common_cancel()}
        </button>
        <BusyButton className="btn primary" busy={busy} busyLabel={m.common_saving()} disabled={busy} onClick={() => void save()}>
          {m.common_save()}
        </BusyButton>
      </div>
      {picking && inventory && (
        <FolderPickerDialog
          title={m.backup_cwiz_browseTitle({ name })}
          root="~"
          source={async (p) => inventoryListing(inventory, p)}
          markLabel={markLabel}
          note={m.backup_cwiz_scanned({ when: relative(inventory.at) })}
          onClose={() => setPicking(false)}
          onPick={(f) => {
            if (!plan.folders.includes(f)) set({ folders: [...plan.folders, f] })
            setPicking(false)
          }}
        />
      )}
    </Modal>
  )
}

type Link = ClientLink

/** A new computer: only its name, then the command that connects it. What and when come afterwards. */
function AddClient({
  clients,
  dataDir,
  onCreate,
  onLink,
  onRefresh,
  onPlan,
  onClose,
}: {
  clients: BackupClient[]
  dataDir: string
  onCreate: (name: string) => Promise<boolean>
  onLink: (name: string) => Promise<Link | undefined>
  onRefresh: () => void
  onPlan: (name: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [link, setLink] = useState<Link | null>(null)
  const [created, setCreated] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const live = link ? clients.find((c) => c.name === name) : undefined

  const create = async () => {
    if (!CLIENT_NAME.test(name)) return setError(m.backup_error_clientName())
    if (created !== name && clients.some((c) => c.name === name)) return setError(m.backup_error_clientExists({ name }))
    setError('')
    setBusy(true)
    try {
      // Created already when only the link failed: try the link again.
      if (created !== name) {
        if (!(await onCreate(name))) return
        setCreated(name)
      }
      const l = await onLink(name)
      if (l) setLink(l)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open wide={!!link} title={m.backup_clients_addTitle()} onClose={onClose} busy={busy}>
      {!link || !live ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <p className="m-0 text-[13px] text-muted">{m.backup_add_text()}</p>
          <label className="flex flex-col gap-1.5 text-[13px]">
            {m.backup_cwiz_name()}
            <input className="field font-mono" value={name} placeholder="laptop" autoFocus disabled={busy} onChange={(e) => setName(e.target.value.trim().toLowerCase())} />
            <span className="text-[12px] text-muted">{m.backup_cwiz_nameHint({ dir: `${dataDir}/${name || 'laptop'}` })}</span>
          </label>
          {error && (
            <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              {m.common_cancel()}
            </button>
            <BusyButton type="submit" className="btn primary" busy={busy} busyLabel={m.common_creating()} disabled={busy}>
              {m.backup_add_create()}
            </BusyButton>
          </div>
        </form>
      ) : (
        <>
          <CommandPanel name={name} link={link} client={live} onRefresh={onRefresh} />
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            {clientConnected(live) && !live.plan ? (
              <>
                <button type="button" className="btn" onClick={onClose}>
                  {m.common_close()}
                </button>
                <button type="button" className="btn primary" onClick={() => onPlan(name)}>
                  {m.backup_clients_setPlan()}
                </button>
              </>
            ) : (
              <button type="button" className="btn primary" onClick={onClose}>
                {m.backup_cwiz_done()}
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}

/** A new setup command for a client (connects it, or renews its access and token). */
function CommandDialog({ client, onLink, onRefresh, onClose }: { client: BackupClient; onLink: (name: string) => Promise<Link | undefined>; onRefresh: () => void; onClose: () => void }) {
  const [link, setLink] = useState<Link | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let stale = false
    onLink(client.name).then((l) => {
      if (stale) return
      if (l) setLink(l)
      else setFailed(true)
    })
    return () => {
      stale = true
    }
  }, [client.name, onLink])
  return (
    <Modal open wide title={m.backup_command_title({ name: client.name })} onClose={onClose}>
      {link ? (
        <CommandPanel name={client.name} link={link} client={client} onRefresh={onRefresh} />
      ) : failed ? null : (
        <p className="m-0 flex items-center gap-2 text-[13px] text-muted">
          <Spinner /> {m.common_creating()}
        </p>
      )}
      {clientConnected(client) && <p className="m-0 text-[12px] text-muted">{m.backup_command_renews()}</p>}
      <div className="flex justify-end border-t border-line pt-4">
        <button type="button" className="btn primary" onClick={onClose}>
          {m.common_close()}
        </button>
      </div>
    </Modal>
  )
}

/** The command for the computer, how to run it, and whether it has connected. */
function CommandPanel({ name, link, client, onRefresh }: { name: string; link: Link; client: BackupClient; onRefresh: () => void }) {
  const origin = window.location.origin
  // Caddy's local CA only over https (the server checks that too): fetched, checked, then trusted.
  const ca = origin.startsWith('https://') ? link.ca : undefined
  const command = setupCommand(origin, link.token, ca)
  const waiting = !clientConnected(client)

  // While the device runs the command: look more often, so "connected" shows soon after.
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(onRefresh, 5000)
    return () => clearInterval(t)
  }, [waiting, onRefresh])

  return (
    <section className="flex flex-col gap-3 rounded-[12px] border border-accent/35 bg-accent/6 p-4" aria-label={m.backup_client_run()}>
      <h3 className="m-0 text-[14px] font-semibold">{m.backup_client_run()}</h3>
      <ol className="m-0 flex list-none flex-col gap-3 p-0 text-[13px]">
        <Numbered n={1}>{m.backup_cwiz_run1()}</Numbered>
        <Numbered n={2}>
          {m.backup_cwiz_run2()}
          <code className="mt-1.5 block rounded-lg border border-edge bg-[#070a0e] px-3 py-2 font-mono text-[12.5px] break-all select-all" data-testid="client-command">
            {command}
          </code>
          <span className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(command)}>
              {m.backup_client_copy()}
            </button>
            <span suppressHydrationWarning>{m.backup_client_valid({ when: relative(link.expires) })}</span>
          </span>
          <details className="mt-1.5">
            <summary className="cursor-pointer text-subtle">{m.backup_client_review()}</summary>
            <code className="mt-2 block rounded-lg border border-edge bg-[#070a0e] px-3 py-2 font-mono text-[12.5px] break-all whitespace-pre-wrap select-all" data-testid="client-review">
              {reviewCommands(origin, link.token, ca)}
            </code>
            {ca && (
              <span className="mt-1.5 block text-[12px] break-all text-muted" data-testid="client-ca">
                {m.backup_client_caFingerprint({ fingerprint: ca.fingerprint })}
                <br />
                {m.backup_client_caFile({ sha256: ca.sha256 })}
              </span>
            )}
          </details>
          {ca && <span className="mt-1.5 block text-[12px] text-muted">{m.backup_client_caText()}</span>}
        </Numbered>
        <Numbered n={3}>{m.backup_cwiz_run3()}</Numbered>
      </ol>
      {waiting ? (
        <p className="m-0 flex items-center gap-2 text-[13px] text-[#e3b341]" role="status">
          <Spinner /> {m.backup_cwiz_waiting()}
        </p>
      ) : (
        <p className="m-0 text-[13px] text-[#7ee2a8]" role="status" suppressHydrationWarning>
          {client.plan ? m.backup_command_connectedPlan({ name }) : m.backup_command_connected({ name })}
        </p>
      )}
      <p className="m-0 text-[12px] text-muted">{m.backup_client_runText()}</p>
      <details className="text-[13px]">
        <summary className="cursor-pointer text-subtle">{m.backup_client_after()}</summary>
        <pre className="mt-2 mb-0 overflow-x-auto rounded-lg border border-edge bg-[#070a0e] px-3 py-2 font-mono text-[12.5px] leading-relaxed">
          {[
            'quadeck-backup check      # how big, with the exclusions (dry run)',
            'quadeck-backup now        # back up right now',
            'quadeck-backup status     # last backups, next run',
            'quadeck-backup mount      # backups as folders under ~/Backup',
            'quadeck-backup restore ~/Dokumente/x',
            'quadeck-backup scan       # send the folder list to Quadeck',
            'quadeck-backup guide      # steps for an AI agent on this computer',
            'quadeck-backup uninstall  # remove the timers',
          ].join('\n')}
        </pre>
      </details>
    </section>
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
