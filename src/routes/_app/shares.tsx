import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { useActions } from '~/components/Actions'
import { BusyButton, useBusy } from '~/components/Busy'
import { Glyph } from '~/components/Glyph'
import { InstallHint } from '~/components/InstallHint'
import { Modal } from '~/components/Modal'
import { PageHeader } from '~/components/PageHeader'
import { DiffView } from '~/components/QuadletEditor'
import { Pill } from '~/components/Status'
import { useToast } from '~/components/Toast'
import { useGuardedApi } from '~/components/Unlock'
import { api } from '~/lib/api'
import { age } from '~/lib/format'
import {
  validateNfs,
  validateSmb,
  type NfsClient,
  type NfsExportInfo,
  type NfsExportSpec,
  type ShareChange,
  type SharePreview,
  type ShareService,
  type ShareServiceAction,
  type SharesState,
  type SmbShareInfo,
  type SmbShareSpec,
} from '~/shared/shares'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'
import { usePolling } from '~/lib/polling'
import { fieldLabel } from '~/lib/classes'

export const Route = createFileRoute('/_app/shares')({
  head: () => ({ meta: [{ title: msg(m.page_title_shares) }] }),
  component: SharesPage,
})

const label = fieldLabel

function SharesPage() {
  const [state, setState] = useState<SharesState | null>(null)
  const [error, setError] = useState('')
  const [smbEdit, setSmbEdit] = useState<{ original?: SmbShareInfo } | null>(null)
  const [nfsEdit, setNfsEdit] = useState<{ original?: NfsExportInfo } | null>(null)
  const [pending, setPending] = useState<{ change: ShareChange; title: string; confirm: string; danger?: boolean } | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/shares')
      const d = (await r.json()) as SharesState & { error?: string }
      if (!r.ok) throw new Error(d.error ?? m.common_http({ status: r.status }))
      setState(d)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  usePolling(load, 30_000)

  return (
    <>
      <PageHeader title={m.shares_page_title()} subtitle={m.shares_page_subtitle()} />
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!state && !error && <p className="m-0 text-muted">{m.shares_page_loading()}</p>}
      {state && (
        <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-2">
          <SmbPanel
            state={state}
            onState={setState}
            onReload={load}
            onEdit={(original) => setSmbEdit({ original })}
            onDelete={(s) => setPending({ change: { kind: 'smb', original: s.name, spec: null }, title: m.shares_page_deleteSmb({ name: s.name }), confirm: m.common_delete(), danger: true })}
          />
          <NfsPanel
            state={state}
            onState={setState}
            onReload={load}
            onEdit={(original) => setNfsEdit({ original })}
            onDelete={(e) => setPending({ change: { kind: 'nfs', original: { file: e.file, path: e.path }, spec: null }, title: m.shares_page_deleteNfs({ path: e.path }), confirm: m.common_delete(), danger: true })}
          />
        </div>
      )}
      <SmbDialog
        open={!!smbEdit}
        original={smbEdit?.original}
        onClose={() => setSmbEdit(null)}
        onNext={(spec) => {
          const o = smbEdit?.original
          setSmbEdit(null)
          setPending({ change: { kind: 'smb', original: o?.name, spec }, title: o ? m.shares_page_changeSmb({ name: spec.name }) : m.shares_page_createSmb({ name: spec.name }), confirm: m.common_save() })
        }}
      />
      <NfsDialog
        open={!!nfsEdit}
        original={nfsEdit?.original}
        onClose={() => setNfsEdit(null)}
        onNext={(spec) => {
          const o = nfsEdit?.original
          setNfsEdit(null)
          setPending({
            change: { kind: 'nfs', original: o ? { file: o.file, path: o.path } : undefined, spec },
            title: o ? m.shares_page_changeNfs({ path: spec.path }) : m.shares_page_createNfs({ path: spec.path }),
            confirm: m.common_save(),
          })
        }}
      />
      <PreviewDialog pending={pending} onClose={() => setPending(null)} onDone={setState} />
    </>
  )
}

// ---------- services ----------

function Services({ kind, services, onState }: { kind: 'smb' | 'nfs'; services: ShareService[]; onState: (s: SharesState) => void }) {
  const say = useToast()
  const guarded = useGuardedApi()
  const { readonly } = useActions()
  const work = useBusy<ShareServiceAction>()
  const busy = work.busy !== null
  if (!services.length) return null
  const active = services.every((s) => s.active)
  const enabled = services.every((s) => s.enabled)
  const act = (action: ShareServiceAction) =>
    work.run(action, async () => {
      try {
        const st = await guarded<SharesState>('/api/shares', { body: { service: { kind, action } } })
        if (st) {
          onState(st)
          say(`${services.map((s) => s.unit).join(', ')}: ${pickMsg({ stop: m.shares_services_done_stop, enable: m.shares_services_done_enable, restart: m.shares_services_done_restart, start: m.shares_services_done_start }, action)}`)
        }
      } catch (e) {
        say((e as Error).message, 'bad')
      }
    })
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line px-[18px] py-2.5 text-[12px]">
      {services.map((s) => (
        <Pill key={s.unit} tone={s.active ? 'ok' : 'idle'}>
          {s.unit.replace('.service', '')} {s.active ? m.shares_services_running() : m.shares_services_stopped()}
          {!s.enabled ? m.shares_services_notAtBoot() : ''}
        </Pill>
      ))}
      {!readonly && (
        <span className="ml-auto flex gap-1.5">
          {!enabled && (
            <BusyButton className="btn sm" busy={work.is('enable')} busyLabel={m.common_applying()} disabled={busy} onClick={() => void act('enable')}>
              {m.shares_services_enable()}
            </BusyButton>
          )}
          {active ? (
            <>
              <BusyButton className="btn sm" busy={work.is('restart')} busyLabel={m.common_restarting()} disabled={busy} onClick={() => void act('restart')}>
                {m.common_restart()}
              </BusyButton>
              <BusyButton className="btn sm danger" busy={work.is('stop')} busyLabel={m.common_stopping()} disabled={busy} onClick={() => void act('stop')}>
                {m.common_stop()}
              </BusyButton>
            </>
          ) : (
            <BusyButton className="btn sm primary" busy={work.is('start')} busyLabel={m.common_starting()} disabled={busy} onClick={() => void act('start')}>
              {m.common_start()}
            </BusyButton>
          )}
        </span>
      )}
    </div>
  )
}

// ---------- SMB ----------

function SmbPanel({ state, onState, onEdit, onDelete, onReload }: { state: SharesState; onState: (s: SharesState) => void; onEdit: (s?: SmbShareInfo) => void; onDelete: (s: SmbShareInfo) => void; onReload: () => void }) {
  const { readonly } = useActions()
  const smb = state.smb
  return (
    <section className="panel flex flex-col self-start" aria-label={m.shares_smb_panel()}>
      <div className="flex flex-wrap items-center gap-2 px-[18px] pt-4 pb-2">
        <span className="chip q">SMB</span>
        <h2 className="h2 grow">Samba</h2>
        {!readonly && smb.installed && (
          <button type="button" className="btn sm" onClick={() => onEdit(undefined)}>
            <Glyph name="plus" size={13} /> {m.shares_smb_newShare()}
          </button>
        )}
      </div>
      {!smb.installed && (
        <div className="border-t border-line">
          <InstallHint feature="samba" what={m.shares_smb_notInstalled()} onInstalled={onReload} />
        </div>
      )}
      {smb.installed && smb.shares.length === 0 && <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{m.shares_smb_noShares({ file: smb.file })}</p>}
      {smb.shares.map((s) => (
        <div key={s.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-[18px] py-[10px]" data-testid="smb-share">
          <div className="min-w-0 grow">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{s.name}</span>
              <span className="chip">{s.readOnly ? m.shares_smb_read() : m.shares_smb_readWrite()}</span>
              {s.guestOk && <span className="chip">{m.shares_smb_guest()}</span>}
              {!s.browseable && <span className="chip">{m.shares_smb_hidden()}</span>}
              {s.connections > 0 && <Pill tone="ok">{m.shares_smb_connected({ n: s.connections })}</Pill>}
            </div>
            <div className="truncate font-mono text-[11px] text-muted">
              {s.path}
              {s.validUsers ? m.shares_smb_only({ users: s.validUsers }) : ''}
              {s.comment ? ` · ${s.comment}` : ''}
            </div>
            {s.extraKeys.length > 0 && <div className="truncate text-[11px] text-subtle">{m.shares_smb_extraKept({ keys: s.extraKeys.join(', ') })}</div>}
          </div>
          {!readonly && (
            <span className="flex gap-1.5">
              <button type="button" className="btn sm" onClick={() => onEdit(s)} aria-label={m.shares_smb_editLabel({ name: s.name })}>
                {m.common_edit()}
              </button>
              <button type="button" className="btn sm danger" onClick={() => onDelete(s)} aria-label={m.shares_smb_deleteLabel({ name: s.name })}>
                <Glyph name="trash" size={13} />
              </button>
            </span>
          )}
        </div>
      ))}
      {smb.connections.length > 0 && (
        <div className="border-t border-line px-[18px] py-2 text-[12px] text-muted">
          {m.shares_smb_connectedLabel()}{' '}
          {smb.connections.map((c, i) => (
            <span key={i} className="mr-3 font-mono" suppressHydrationWarning>
              {c.client} → {c.share}
              {c.since ? m.shares_smb_since({ when: age(c.since) }) : ''}
            </span>
          ))}
        </div>
      )}
      <Services kind="smb" services={smb.services} onState={onState} />
    </section>
  )
}

const emptySmb: SmbShareSpec = { name: '', path: '/mnt/', comment: '', readOnly: false, guestOk: false, validUsers: '', browseable: true }

function SmbDialog({ open, original, onClose, onNext }: { open: boolean; original?: SmbShareInfo; onClose: () => void; onNext: (s: SmbShareSpec) => void }) {
  const [s, setS] = useState<SmbShareSpec>(emptySmb)
  useEffect(() => {
    if (open) setS(original ? { name: original.name, path: original.path, comment: original.comment, readOnly: original.readOnly, guestOk: original.guestOk, validUsers: original.validUsers, browseable: original.browseable } : emptySmb)
  }, [open, original])
  const errors = validateSmb(s)
  const set = (p: Partial<SmbShareSpec>) => setS((x) => ({ ...x, ...p }))
  return (
    <Modal open={open} onClose={onClose} title={original ? m.shares_smbDialog_editTitle({ name: original.name }) : m.shares_smbDialog_newTitle()}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!errors.length) onNext(s)
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>
            {m.shares_smbDialog_name()}
            <input className="field" value={s.name} onChange={(e) => set({ name: e.target.value })} placeholder={m.shares_smbDialog_namePlaceholder()} autoFocus required />
          </label>
          <label className={label}>
            {m.common_path()}
            <input className="field font-mono" value={s.path} onChange={(e) => set({ path: e.target.value })} placeholder="/mnt/storage/media" required />
          </label>
        </div>
        <label className={label}>
          {m.shares_smbDialog_comment()}
          <input className="field" value={s.comment} onChange={(e) => set({ comment: e.target.value })} placeholder={m.shares_smbDialog_optional()} />
        </label>
        <fieldset className="m-0 flex flex-wrap gap-4 border-0 p-0 text-[13px]">
          <legend className="mb-1 text-[12px] font-medium text-muted">{m.shares_smbDialog_access()}</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="smb-access" checked={s.readOnly} onChange={() => set({ readOnly: true })} /> {m.common_readonly()}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="smb-access" checked={!s.readOnly} onChange={() => set({ readOnly: false })} /> {m.shares_smbDialog_readWrite()}
          </label>
        </fieldset>
        <label className={label}>
          {m.shares_smbDialog_users()}
          <input className="field font-mono" value={s.validUsers} onChange={(e) => set({ validUsers: e.target.value })} placeholder={m.shares_smbDialog_usersPlaceholder()} />
          <span className="font-normal">
            {m.shares_smbDialog_passwordHint()} <span className="font-mono">smbpasswd -a name</span>
          </span>
        </label>
        <div className="flex flex-wrap gap-4 text-[13px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.guestOk} onChange={(e) => set({ guestOk: e.target.checked })} /> {m.shares_smbDialog_guests()}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.browseable} onChange={(e) => set({ browseable: e.target.checked })} /> {m.shares_smbDialog_visible()}
          </label>
        </div>
        {errors.length > 0 && s.name && (
          <ul className="m-0 list-none p-0 text-[13px] text-[#ff8a80]" role="alert">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {m.common_cancel()}
          </button>
          <button type="submit" className="btn primary" disabled={errors.length > 0}>
            {m.shares_smbDialog_next()}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ---------- NFS ----------

function NfsPanel({ state, onState, onEdit, onDelete, onReload }: { state: SharesState; onState: (s: SharesState) => void; onEdit: (e?: NfsExportInfo) => void; onDelete: (e: NfsExportInfo) => void; onReload: () => void }) {
  const { readonly } = useActions()
  const nfs = state.nfs
  return (
    <section className="panel flex flex-col self-start" aria-label={m.shares_nfs_panel()}>
      <div className="flex flex-wrap items-center gap-2 px-[18px] pt-4 pb-2">
        <span className="chip">NFS</span>
        <h2 className="h2 grow">NFS</h2>
        {!readonly && nfs.installed && (
          <button type="button" className="btn sm" onClick={() => onEdit(undefined)}>
            <Glyph name="plus" size={13} /> {m.shares_nfs_newExport()}
          </button>
        )}
      </div>
      {!nfs.installed && (
        <div className="border-t border-line">
          <InstallHint feature="nfs" what={m.shares_nfs_notInstalled()} onInstalled={onReload} />
        </div>
      )}
      {nfs.installed && nfs.exports.length === 0 && <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{m.shares_nfs_noExports()}</p>}
      {nfs.exports.map((e) => (
        <div key={`${e.file}:${e.path}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-[18px] py-[10px]" data-testid="nfs-export">
          <div className="min-w-0 grow">
            <div className="truncate font-mono text-[13px] font-medium">{e.path}</div>
            <div className="mt-0.5 flex flex-wrap gap-1.5">
              {e.clients.map((c) => (
                <span key={c.host} className="chip" title={c.options.join(', ')}>
                  {c.host} · {c.options.includes('rw') ? 'rw' : 'ro'}
                  {c.options.includes('no_root_squash') ? ' · no_root_squash' : ''}
                </span>
              ))}
            </div>
            {!e.managed && <div className="text-[11px] text-subtle">{m.shares_nfs_inFile({ file: e.file })}</div>}
          </div>
          {!readonly && (
            <span className="flex gap-1.5">
              <button type="button" className="btn sm" onClick={() => onEdit(e)} aria-label={m.shares_smb_editLabel({ name: e.path })}>
                {m.common_edit()}
              </button>
              <button type="button" className="btn sm danger" onClick={() => onDelete(e)} aria-label={m.shares_smb_deleteLabel({ name: e.path })}>
                <Glyph name="trash" size={13} />
              </button>
            </span>
          )}
        </div>
      ))}
      {nfs.clients.length > 0 && (
        <div className="border-t border-line px-[18px] py-2 text-[12px] text-muted">
          {m.shares_nfs_clientsConnected()} <span className="font-mono">{nfs.clients.join(', ')}</span>
        </div>
      )}
      <Services kind="nfs" services={nfs.services} onState={onState} />
    </section>
  )
}

type Squash = 'root_squash' | 'no_root_squash' | 'all_squash'
interface ClientForm {
  host: string
  rw: boolean
  sync: boolean
  subtree: boolean
  squash: Squash
  extra: string
}

const KNOWN = new Set(['rw', 'ro', 'sync', 'async', 'no_subtree_check', 'subtree_check', 'root_squash', 'no_root_squash', 'all_squash'])

function toForm(c: NfsClient): ClientForm {
  return {
    host: c.host,
    rw: c.options.includes('rw'),
    sync: !c.options.includes('async'),
    subtree: c.options.includes('subtree_check'),
    squash: c.options.includes('no_root_squash') ? 'no_root_squash' : c.options.includes('all_squash') ? 'all_squash' : 'root_squash',
    extra: c.options.filter((o) => !KNOWN.has(o)).join(','),
  }
}

function fromForm(c: ClientForm): NfsClient {
  return {
    host: c.host.trim(),
    options: [
      c.rw ? 'rw' : 'ro',
      c.sync ? 'sync' : 'async',
      c.subtree ? 'subtree_check' : 'no_subtree_check',
      ...(c.squash === 'root_squash' ? [] : [c.squash]),
      ...c.extra
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ],
  }
}

const newClient: ClientForm = { host: '192.168.1.0/24', rw: true, sync: true, subtree: false, squash: 'root_squash', extra: '' }

function NfsDialog({ open, original, onClose, onNext }: { open: boolean; original?: NfsExportInfo; onClose: () => void; onNext: (s: NfsExportSpec) => void }) {
  const [path, setPath] = useState('/mnt/')
  const [clients, setClients] = useState<ClientForm[]>([newClient])
  useEffect(() => {
    if (!open) return
    setPath(original?.path ?? '/mnt/')
    setClients(original ? original.clients.map(toForm) : [newClient])
  }, [open, original])
  const spec: NfsExportSpec = { path: path.trim(), clients: clients.map(fromForm) }
  const errors = validateNfs(spec)
  const upd = (i: number, p: Partial<ClientForm>) => setClients((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)))
  return (
    <Modal open={open} onClose={onClose} title={original ? m.shares_nfsDialog_editTitle({ path: original.path }) : m.shares_nfsDialog_newTitle()} wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!errors.length) onNext(spec)
        }}
      >
        <label className={label}>
          {m.shares_nfsDialog_directory()}
          <input className="field font-mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/mnt/storage/backup" autoFocus required />
        </label>
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-muted">Clients</span>
          {clients.map((c, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 rounded-[10px] border border-edge p-3" data-testid="nfs-client">
              <label className={`${label} min-w-[180px] grow`}>
                {m.shares_nfsDialog_host()}
                <input className="field font-mono" value={c.host} onChange={(e) => upd(i, { host: e.target.value })} placeholder="192.168.1.0/24" aria-label={`Client ${i + 1}`} />
              </label>
              <label className={label}>
                {m.shares_smbDialog_access()}
                <select className="field" value={c.rw ? 'rw' : 'ro'} onChange={(e) => upd(i, { rw: e.target.value === 'rw' })} aria-label={m.shares_nfsDialog_accessLabel({ n: i + 1 })}>
                  <option value="ro">{m.shares_nfsDialog_ro()}</option>
                  <option value="rw">{m.shares_nfsDialog_rw()}</option>
                </select>
              </label>
              <label className={label}>
                {m.shares_nfsDialog_rootFromClient()}
                <select className="field" value={c.squash} onChange={(e) => upd(i, { squash: e.target.value as Squash })} aria-label={`root ${i + 1}`}>
                  <option value="root_squash">{m.shares_nfsDialog_rootSquash()}</option>
                  <option value="all_squash">{m.shares_nfsDialog_allSquash()}</option>
                  <option value="no_root_squash">{m.shares_nfsDialog_noRootSquash()}</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5 pb-2 text-[13px]" title={m.shares_nfsDialog_syncTitle()}>
                <input type="checkbox" checked={c.sync} onChange={(e) => upd(i, { sync: e.target.checked })} /> sync
              </label>
              <label className={`${label} w-[140px]`}>
                {m.shares_nfsDialog_extra()}
                <input className="field font-mono" value={c.extra} onChange={(e) => upd(i, { extra: e.target.value })} placeholder="crossmnt,fsid=0" />
              </label>
              {clients.length > 1 && (
                <button type="button" className="btn sm mb-1" onClick={() => setClients((cs) => cs.filter((_, j) => j !== i))} aria-label={m.shares_nfsDialog_removeClient({ n: i + 1 })}>
                  <Glyph name="trash" size={13} />
                </button>
              )}
            </div>
          ))}
          <button type="button" className="btn sm self-start" onClick={() => setClients((cs) => [...cs, { ...newClient, host: '' }])}>
            <Glyph name="plus" size={13} /> {m.shares_nfsDialog_addClient()}
          </button>
        </div>
        <p className="m-0 font-mono text-[12px] text-muted" aria-label={m.shares_nfsDialog_exportsLine()}>
          {spec.path} {spec.clients.map((c) => `${c.host}(${c.options.join(',')})`).join(' ')}
        </p>
        {errors.length > 0 && (
          <ul className="m-0 list-none p-0 text-[13px] text-[#ff8a80]" role="alert">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {m.common_cancel()}
          </button>
          <button type="submit" className="btn primary" disabled={errors.length > 0}>
            {m.shares_nfsDialog_next()}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ---------- preview + apply ----------

function PreviewDialog({ pending, onClose, onDone }: { pending: { change: ShareChange; title: string; confirm: string; danger?: boolean } | null; onClose: () => void; onDone: (s: SharesState) => void }) {
  const say = useToast()
  const guarded = useGuardedApi()
  const [preview, setPreview] = useState<SharePreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setPreview(null)
    setError('')
    if (!pending) return
    api<SharePreview>('/api/shares', { body: { change: pending.change, preview: true } })
      .then(setPreview)
      .catch((e: Error) => setError(e.message))
  }, [pending])
  const apply = async () => {
    if (!pending) return
    setBusy(true)
    try {
      const st = await guarded<SharesState>('/api/shares', { body: { change: pending.change } })
      if (!st) return
      onDone(st)
      say(pending.change.kind === 'smb' ? m.shares_preview_smbSaved() : m.shares_preview_nfsSaved())
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={!!pending} onClose={onClose} title={pending?.title ?? ''} wide>
      {!preview && !error && <p className="m-0 text-muted">{m.shares_preview_creating()}</p>}
      {preview && (
        <>
          <p className="m-0 text-[12px] text-muted">
            {m.shares_preview_changeIn()} <span className="font-mono">{preview.file}</span> {m.shares_preview_backupBefore()}
            <span className="font-mono">.quadeck-bak</span>
            {m.shares_preview_backupAfter()}
          </p>
          <DiffView before={preview.before} after={preview.after} />
          {preview.warnings.map((w) => (
            <p key={w} className="m-0 text-[13px] text-[#e3b341]">
              {w}
            </p>
          ))}
        </>
      )}
      {error && (
        <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_cancel()}
        </button>
        <button type="button" className={pending?.danger ? 'btn danger' : 'btn primary'} disabled={!preview || busy} onClick={apply}>
          {busy ? m.shares_preview_saving() : pending?.confirm}
        </button>
      </div>
    </Modal>
  )
}
