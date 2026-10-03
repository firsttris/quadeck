import { useCallback, useEffect, useState } from 'react'
import { api } from '~/lib/api'
import { bytes, relative } from '~/lib/format'
import { useLive } from '~/lib/live'
import { CLIENT_NAME, TARGET_UNIT, clientRepo, staleClients, type BackupClient, type TargetConfig, type TargetState } from '~/shared/backup'
import { useActions } from './Actions'
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
  const { readonly } = useActions()
  const guarded = useGuardedApi()
  const say = useToast()
  const { snapshot } = useLive()
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
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {state.clients.map((c) => {
                    const late = stale.some((s) => s.name === c.name)
                    return (
                      <tr key={c.name} data-testid="backup-client">
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
                        <td className="text-right">
                          {!readonly && (
                            <RowMenu
                              label={m.common_actionsFor({ name: c.name })}
                              items={[
                                { label: m.backup_clients_edit(), onSelect: () => setEdit(c) },
                                {
                                  label: m.backup_clients_renew(),
                                  onSelect: async () => {
                                    const r = await call<{ password: string }>({ client: { renew: c.name } })
                                    if (r) setAccess({ name: c.name, password: r.password })
                                  },
                                },
                                {
                                  label: c.disabled ? m.backup_clients_enable() : m.backup_clients_disable(),
                                  onSelect: async () => {
                                    const s = await call<TargetState>({ client: { update: { name: c.name, change: { disabled: !c.disabled } } } }, c.disabled ? m.backup_clients_enabled({ name: c.name }) : m.backup_clients_disabledNow({ name: c.name }))
                                    if (s) setState(s)
                                  },
                                },
                                { label: m.common_deleteDots(), danger: true, separator: true, onSelect: () => setRemove(c) },
                              ]}
                            />
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
          taken={state.clients.map((c) => c.name)}
          onClose={() => setAdd(false)}
          onAdd={async (name, warnDays) => {
            const r = await call<{ password: string }>({ client: { add: { name, warnDays } } })
            if (!r) return
            setAdd(false)
            setAccess({ name, password: r.password })
            void load()
          }}
        />
      )}
      {access && cfg && <AccessDialog config={cfg} name={access.name} password={access.password} onClose={() => setAccess(null)} />}
      {edit && (
        <EditClient
          client={edit}
          onClose={() => setEdit(null)}
          onSave={async (warnDays) => {
            const s = await call<TargetState>({ client: { update: { name: edit.name, change: { warnDays } } } }, m.backup_clients_saved())
            if (s) {
              setState(s)
              setEdit(null)
            }
          }}
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
    <Modal open title={config ? m.backup_target_editTitle() : m.backup_target_setupTitle()} onClose={onClose}>
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
        <button type="button" className="btn" onClick={onClose}>
          {m.common_cancel()}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await onSave(c)
            setBusy(false)
          }}
        >
          {busy ? m.backup_setup_saving() : config ? m.common_save() : m.backup_setup_create()}
        </button>
      </div>
    </Modal>
  )
}

function AddClient({ taken, onClose, onAdd }: { taken: string[]; onClose: () => void; onAdd: (name: string, warnDays: number | null) => Promise<void> }) {
  const [name, setName] = useState('')
  const [warn, setWarn] = useState(true)
  const [days, setDays] = useState(3)
  const valid = CLIENT_NAME.test(name)
  return (
    <Modal open title={m.backup_clients_addTitle()} onClose={onClose}>
      <label className="flex flex-col gap-1.5 text-[13px]">
        {m.backup_clients_name()}
        <input className="field font-mono" value={name} placeholder="laptop" autoFocus onChange={(e) => setName(e.target.value.trim().toLowerCase())} />
      </label>
      {name && !valid && <p className="m-0 text-[13px] text-[#ff8a80]">{m.backup_error_clientName()}</p>}
      {taken.includes(name) && <p className="m-0 text-[13px] text-[#ff8a80]">{m.backup_error_clientExists({ name })}</p>}
      <WarnInput warn={warn} days={days} onChange={(w, d) => (setWarn(w), setDays(d))} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_cancel()}
        </button>
        <button type="button" className="btn primary" disabled={!valid || taken.includes(name)} onClick={() => void onAdd(name, warn ? days : null)}>
          {m.backup_clients_create()}
        </button>
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

function EditClient({ client, onClose, onSave }: { client: BackupClient; onClose: () => void; onSave: (warnDays: number | null) => Promise<void> }) {
  const [warn, setWarn] = useState(!!client.warnDays)
  const [days, setDays] = useState(client.warnDays ?? 3)
  return (
    <Modal open title={client.name} onClose={onClose}>
      <WarnInput warn={warn} days={days} onChange={(w, d) => (setWarn(w), setDays(d))} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_cancel()}
        </button>
        <button type="button" className="btn primary" onClick={() => void onSave(warn ? days : null)}>
          {m.common_save()}
        </button>
      </div>
    </Modal>
  )
}

function RemoveClient({ client, dataDir, onClose, onRemove }: { client: BackupClient; dataDir?: string; onClose: () => void; onRemove: (deleteData: boolean) => Promise<void> }) {
  const [data, setData] = useState(false)
  return (
    <Modal open title={m.backup_clients_removeTitle({ name: client.name })} onClose={onClose}>
      <p className="m-0 text-[13px]">{m.backup_clients_removeText()}</p>
      <label className="flex items-start gap-2.5 text-[13px]">
        <input type="checkbox" className="mt-0.5" checked={data} onChange={(e) => setData(e.target.checked)} />
        <span>
          {m.backup_clients_removeData()}
          {dataDir && <span className="block font-mono text-[12px] text-muted">{`${dataDir}/${client.name}`}</span>}
          {data && <span className="mt-1 block text-[#ff8a80]">{m.backup_clients_removeDataWarn()}</span>}
        </span>
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_cancel()}
        </button>
        <button type="button" className="btn danger" onClick={() => void onRemove(data)}>
          {m.common_delete()}
        </button>
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
