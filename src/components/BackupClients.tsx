import { useCallback, useEffect, useState } from 'react'
import { api } from '~/lib/api'
import { bytes, relative } from '~/lib/format'
import { useLive } from '~/lib/live'
import { CLIENT_PRESETS, clientCalendar, defaultClientPlan, type ClientPlan, type ClientPreset } from '~/shared/backup-client'
import { pickMsg } from '~/i18n'
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
                    <th>{m.backup_clients_settings()}</th>
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
                        <td>
                          <SettingsChip client={c} />
                        </td>
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
            await load()
            // Next: what to back up, then the script for the computer.
            setEdit({ name, created: Date.now() })
          }}
        />
      )}
      {access && cfg && <AccessDialog config={cfg} name={access.name} password={access.password} onClose={() => setAccess(null)} />}
      {edit && (
        <ClientDialog
          client={state.clients.find((c) => c.name === edit.name) ?? edit}
          onClose={() => setEdit(null)}
          onSave={async (plan, warnDays) => {
            const a = await call<TargetState>({ client: { plan: { name: edit.name, plan } } })
            const b = a && (await call<TargetState>({ client: { update: { name: edit.name, change: { warnDays } } } }, m.backup_clients_saved()))
            if (b) setState(b)
            return !!b
          }}
          onLink={() => call<{ token: string; expires: number }>({ client: { link: { name: edit.name, origin: window.location.origin } } })}
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

/** What a client backs up and when, and the one-time command that carries it there. */
function ClientDialog({
  client,
  onClose,
  onSave,
  onLink,
}: {
  client: BackupClient
  onClose: () => void
  onSave: (plan: ClientPlan, warnDays: number | null) => Promise<boolean>
  onLink: () => Promise<{ token: string; expires: number } | undefined>
}) {
  const [plan, setPlan] = useState<ClientPlan>(client.plan ? structuredClone(client.plan) : defaultClientPlan())
  const [patterns, setPatterns] = useState((client.plan?.exclude.patterns ?? []).join('\n'))
  const [folder, setFolder] = useState('')
  const [warn, setWarn] = useState(client.warnDays !== undefined ? true : !client.plan)
  const [days, setDays] = useState(client.warnDays ?? 3)
  const [link, setLink] = useState<{ token: string; expires: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const full: ClientPlan = { ...plan, exclude: { ...plan.exclude, patterns: patterns.split('\n').map((l) => l.trim()).filter(Boolean) } }
  const saved = JSON.stringify(full) === JSON.stringify(client.plan) && (warn ? days : undefined) === client.warnDays
  const set = (p: Partial<ClientPlan>) => setPlan({ ...plan, ...p })
  const url = link ? `${window.location.origin}/api/backup/script/${link.token}` : ''

  const save = async () => {
    setBusy(true)
    const ok = await onSave(full, warn ? days : null)
    setBusy(false)
    return ok
  }
  const makeLink = async () => {
    if (!saved && !(await save())) return
    const l = await onLink()
    if (l) setLink(l)
  }

  return (
    <Modal open wide title={client.name} onClose={onClose}>
      <section className="flex flex-col gap-2.5" aria-label={m.backup_client_what()}>
        <h3 className="label-caps m-0 font-normal">{m.backup_client_what()}</h3>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {plan.folders.map((f) => (
            <li key={f} className="flex items-center gap-2 rounded-lg border border-edge bg-[#0e1319] px-2.5 py-1.5 text-[13px]">
              <span className="grow font-mono">{f}</span>
              <button type="button" className="btn sm" aria-label={m.backup_client_removeFolder({ folder: f })} onClick={() => set({ folders: plan.folders.filter((x) => x !== f) })}>
                {m.backup_client_remove()}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <input className="field font-mono" value={folder} placeholder="~/Musik" aria-label={m.backup_setup_addFolder()} onChange={(e) => setFolder(e.target.value)} />
          <button
            type="button"
            className="btn"
            disabled={!folder.trim()}
            onClick={() => {
              const v = folder.trim().replace(/\/+$/, '')
              if (v && !plan.folders.includes(v)) set({ folders: [...plan.folders, v] })
              setFolder('')
            }}
          >
            {m.backup_setup_add()}
          </button>
        </div>
        <p className="m-0 text-[12px] text-muted">{m.backup_client_home()}</p>
      </section>

      <section className="flex flex-col gap-2.5" aria-label={m.backup_setup_excludes()}>
        <h3 className="label-caps m-0 font-normal">{m.backup_setup_excludes()}</h3>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {CLIENT_PRESETS.map((p) => (
            <label key={p} className="flex items-center gap-2.5 text-[13px]">
              <input type="checkbox" checked={plan.exclude.presets.includes(p)} onChange={(e) => set({ exclude: { ...plan.exclude, presets: e.target.checked ? [...plan.exclude.presets, p] : plan.exclude.presets.filter((x) => x !== p) } })} />
              {presetLabel(p)}
            </label>
          ))}
        </div>
        <label className="flex flex-col gap-1.5 text-[13px]">
          {m.backup_setup_patterns()}
          <textarea className="field resize-y font-mono text-[13px]" rows={3} value={patterns} placeholder={'~/Videos/Aufnahmen\n*.mkv\n**/build'} onChange={(e) => setPatterns(e.target.value)} />
        </label>
        <p className="m-0 text-[12px] text-muted">{m.backup_setup_patternsHelp()}</p>
        <label className="flex flex-wrap items-center gap-2 text-[13px]">
          <input type="checkbox" checked={!!plan.exclude.maxSizeGB} onChange={(e) => set({ exclude: { ...plan.exclude, maxSizeGB: e.target.checked ? 2 : undefined } })} />
          {m.backup_setup_maxSizeBefore()}
          <input className="field !w-[64px] !py-1" type="number" min={1} aria-label={m.backup_setup_maxSizeLabel()} disabled={!plan.exclude.maxSizeGB} value={plan.exclude.maxSizeGB ?? 2} onChange={(e) => set({ exclude: { ...plan.exclude, maxSizeGB: Math.max(1, Number(e.target.value) || 1) } })} />
          {m.backup_setup_maxSizeAfter()}
        </label>
      </section>

      <section className="flex flex-col gap-2.5" aria-label={m.backup_setup_when()}>
        <h3 className="label-caps m-0 font-normal">{m.backup_setup_when()}</h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-[13px]">
            {m.backup_setup_every()}
            <select className="field" value={plan.schedule.every} onChange={(e) => set({ schedule: { ...plan.schedule, every: e.target.value as ClientPlan['schedule']['every'] } })}>
              <option value="hourly">{m.backup_client_hourly()}</option>
              <option value="6h">{m.backup_setup_6h()}</option>
              <option value="daily">{m.backup_setup_daily()}</option>
              <option value="weekly">{m.backup_setup_weekly()}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-[13px]">
            {m.backup_setup_time()}
            <input className="field" type="time" value={plan.schedule.time} onChange={(e) => set({ schedule: { ...plan.schedule, time: e.target.value } })} />
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
        <p className="m-0 text-[12px] text-muted">{m.backup_client_persistent({ calendar: clientCalendar(plan.schedule) })}</p>
        <WarnInput warn={warn} days={days} onChange={(w, d) => (setWarn(w), setDays(d))} />
        <label className="flex items-center gap-2.5 text-[13px]">
          <input type="checkbox" checked={plan.active} onChange={(e) => set({ active: e.target.checked })} />
          {m.backup_client_active()}
        </label>
      </section>

      <section className="flex flex-col gap-2.5 rounded-[12px] border border-[rgba(124,196,184,.35)] bg-[rgba(124,196,184,.06)] p-4" aria-label={m.backup_client_run()}>
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="m-0 grow text-[14px] font-semibold">{m.backup_client_run()}</h3>
          <SettingsChip client={client} />
        </div>
        <p className="m-0 text-[13px] text-[#c9d1d9]">{m.backup_client_runText()}</p>
        {link ? (
          <>
            <code className="block rounded-lg border border-edge bg-[#070a0e] px-3 py-2 font-mono text-[12.5px] break-all select-all" data-testid="client-command">
              curl -fsSL {url} | sh
            </code>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
              <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(`curl -fsSL ${url} | sh`)}>
                {m.backup_client_copy()}
              </button>
              <span suppressHydrationWarning>{m.backup_client_valid({ when: relative(link.expires) })}</span>
            </div>
            <details className="text-[13px]">
              <summary className="cursor-pointer text-subtle">{m.backup_client_review()}</summary>
              <code className="mt-2 block rounded-lg border border-edge bg-[#070a0e] px-3 py-2 font-mono text-[12.5px] break-all whitespace-pre-wrap select-all">
                {`curl -fsSL ${url} -o quadeck-backup-setup.sh\nless quadeck-backup-setup.sh\nsh quadeck-backup-setup.sh`}
              </code>
            </details>
          </>
        ) : (
          <button type="button" className="btn primary self-start" disabled={busy || !full.folders.length} onClick={() => void makeLink()}>
            {saved ? m.backup_client_makeLink() : m.backup_client_saveAndLink()}
          </button>
        )}
        <details className="text-[13px]">
          <summary className="cursor-pointer text-subtle">{m.backup_client_after()}</summary>
          <pre className="mt-2 mb-0 overflow-x-auto rounded-lg border border-edge bg-[#070a0e] px-3 py-2 font-mono text-[12.5px] leading-relaxed">
            {['quadeck-backup now        # back up right now', 'quadeck-backup check      # dry run: what would be backed up', 'quadeck-backup status     # last backups, next run', 'quadeck-backup mount      # backups as folders under ~/Backup', 'quadeck-backup restore ~/Dokumente/x', 'quadeck-backup uninstall  # remove the timer'].join('\n')}
          </pre>
        </details>
      </section>

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_close()}
        </button>
        <button type="button" className="btn primary" disabled={busy || saved || !full.folders.length} onClick={() => void save()}>
          {m.common_save()}
        </button>
      </div>
    </Modal>
  )
}
