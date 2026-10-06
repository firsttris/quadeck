// Widgets added from the catalog: the catalog dialog and the widgets themselves (note, …).

import { useEffect, useMemo, useState } from 'react'
import { api } from '~/lib/api'
import { isWebUrl, linkify, LINKS_MAX, NOTE_MAX, TITLE_MAX, WIDGETS, type BuiltinCard, type ContainersConfig, type DiskConfig, type InstanceKind, type LinksConfig, type NoteConfig, type ServiceConfig, type WidgetCategory, type WidgetInstance } from '~/shared/widgets'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'
import { BusyButton } from './Busy'
import { Glyph } from './Glyph'
import { Modal } from './Modal'
import { useToast } from './Toast'

export type CatalogKind = BuiltinCard | InstanceKind

export const widgetName = (kind: CatalogKind) =>
  pickMsg(
    {
      services: m.overview_cards_services,
      storage: m.overview_cards_storage,
      timers: m.overview_cards_timers,
      shares: m.overview_cards_shares,
      cpu: m.overview_cards_cpu,
      ram: m.overview_cards_ram,
      temp: m.overview_cards_temp,
      net: m.overview_cards_net,
      gpu: m.overview_cards_gpu,
      power: m.overview_cards_power,
      note: m.widgets_note_name,
      updates: m.widgets_updates_name,
      backups: m.widgets_backups_name,
      disk: m.widgets_disk_name,
      containers: m.widgets_containers_name,
      alerts: m.widgets_alerts_name,
      service: m.widgets_service_name,
      devices: m.widgets_devices_name,
      speed: m.widgets_speed_name,
      logins: m.widgets_logins_name,
      links: m.widgets_links_name,
    },
    kind,
  )

const widgetDesc = (kind: CatalogKind) =>
  pickMsg(
    {
      services: m.widgets_desc_services,
      storage: m.widgets_desc_storage,
      timers: m.widgets_desc_timers,
      shares: m.widgets_desc_shares,
      cpu: m.widgets_desc_cpu,
      ram: m.widgets_desc_ram,
      temp: m.widgets_desc_temp,
      net: m.widgets_desc_net,
      gpu: m.widgets_desc_gpu,
      power: m.widgets_desc_power,
      note: m.widgets_desc_note,
      updates: m.widgets_desc_updates,
      backups: m.widgets_desc_backups,
      disk: m.widgets_desc_disk,
      containers: m.widgets_desc_containers,
      alerts: m.widgets_desc_alerts,
      service: m.widgets_desc_service,
      devices: m.widgets_desc_devices,
      speed: m.widgets_desc_speed,
      logins: m.widgets_desc_logins,
      links: m.widgets_desc_links,
    },
    kind,
  )

const CATEGORY_LABEL = (c: WidgetCategory | 'all') =>
  pickMsg({ all: m.widgets_cat_all, system: m.widgets_cat_system, storage: m.widgets_cat_storage, services: m.widgets_cat_services, network: m.widgets_cat_network, other: m.widgets_cat_other }, c)

export interface CatalogEntry {
  kind: CatalogKind
  /** How often it is on the dashboard right now. */
  count: number
  /** Why it can't be added here (no GPU, …). */
  unavailable?: string
}

/** "Add widget": every widget with what it shows, whether it is already there, and an add button. */
export function WidgetCatalog({ open, entries, onClose, onAdd }: { open: boolean; entries: CatalogEntry[]; onClose: () => void; onAdd: (kind: CatalogKind) => Promise<void> }) {
  const [cat, setCat] = useState<WidgetCategory | 'all'>('all')
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState<CatalogKind | null>(null)
  useEffect(() => {
    if (open) {
      setCat('all')
      setQuery('')
    }
  }, [open])
  const q = query.trim().toLowerCase()
  const shown = entries.filter((e) => (cat === 'all' || WIDGETS[e.kind].category === cat) && (!q || `${widgetName(e.kind)} ${widgetDesc(e.kind)}`.toLowerCase().includes(q)))
  const cats: (WidgetCategory | 'all')[] = ['all', 'system', 'storage', 'services', 'network', 'other']
  return (
    <Modal open={open} onClose={onClose} title={m.widgets_catalog_title()} wide>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={m.widgets_catalog_categories()} className="flex flex-wrap gap-1.5">
          {cats.map((c) => (
            <button key={c} type="button" className="seg" aria-pressed={cat === c} onClick={() => setCat(c)}>
              {CATEGORY_LABEL(c)}
            </button>
          ))}
        </div>
        <input className="field ml-auto w-full sm:w-[220px]" type="search" placeholder={m.widgets_catalog_search()} aria-label={m.widgets_catalog_search()} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2 lg:grid-cols-3" aria-label={m.widgets_catalog_title()}>
        {shown.map((e) => {
          const meta = WIDGETS[e.kind]
          const taken = !meta.multi && e.count > 0
          return (
            <li key={e.kind} className="flex flex-col gap-1.5 rounded-[11px] border border-edge bg-[#11161d] p-3" data-testid="catalog-entry">
              <div className="flex items-center gap-2">
                <b className="text-[14px]">{widgetName(e.kind)}</b>
                {meta.multi && <span className="rounded-[4px] border border-[#4a3f78] px-1 font-mono text-[10px] font-semibold text-[#b4a0ff]">{m.widgets_catalog_multi()}</span>}
              </div>
              <p className="m-0 grow text-[12.5px] text-[#aab3bf]">{widgetDesc(e.kind)}</p>
              <div className="flex items-center justify-between gap-2 text-[11.5px] text-muted">
                <span className={e.count ? 'text-accent' : undefined}>{e.unavailable ?? (taken ? m.widgets_catalog_onDashboard() : e.count ? m.widgets_catalog_onDashboardN({ n: e.count }) : '')}</span>
                <BusyButton
                  className={taken || e.unavailable ? 'btn sm' : 'btn sm primary'}
                  disabled={taken || !!e.unavailable || !!adding}
                  busy={adding === e.kind}
                  busyLabel={m.common_working()}
                  aria-label={m.widgets_catalog_addNamed({ name: widgetName(e.kind) })}
                  onClick={async () => {
                    setAdding(e.kind)
                    try {
                      await onAdd(e.kind)
                    } finally {
                      setAdding(null)
                    }
                  }}
                >
                  {m.widgets_catalog_add()}
                </BusyButton>
              </div>
            </li>
          )
        })}
      </ul>
      {shown.length === 0 && <p className="m-0 text-[13px] text-muted">{m.widgets_catalog_none()}</p>}
      <div className="flex justify-end">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_close()}
        </button>
      </div>
    </Modal>
  )
}

// ---------- note ----------

/** Text with clickable http(s) links; everything else stays plain text. */
function Linked({ text }: { text: string }) {
  const parts = useMemo(() => linkify(text), [text])
  return (
    <>
      {parts.map((p, i) =>
        p.href ? (
          <a key={i} href={p.href} target="_blank" rel="noreferrer noopener" className="no-drag text-accent underline">
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

export function NoteWidget({ widget, editing, onEdit }: { widget: WidgetInstance & { kind: 'note' }; editing: boolean; onEdit: () => void }) {
  const { title, text } = widget.config
  const heading = title || m.widgets_note_name()
  return (
    <section className="flex flex-col gap-2 p-[18px]" aria-label={heading} data-testid="note-widget">
      <div className="flex items-center gap-2 pr-16">
        <h2 className="h2 min-w-0 grow truncate">{heading}</h2>
        {/* in edit mode the ⚙ of the frame does this */}
        {!editing && (
          <button type="button" className="btn sm no-drag" onClick={onEdit} aria-label={m.widgets_note_editNamed({ name: heading })}>
            <Glyph name="edit" size={13} />
          </button>
        )}
      </div>
      {text ? (
        <p className="m-0 text-[13px] break-words whitespace-pre-wrap text-[#c9d1d9]">
          <Linked text={text} />
        </p>
      ) : (
        <p className="m-0 text-[13px] text-muted">{m.widgets_note_empty()}</p>
      )}
    </section>
  )
}

/** Title and text of a note. */
export function NoteDialog({ widget, onClose, onSaved }: { widget: (WidgetInstance & { kind: 'note' }) | null; onClose: () => void; onSaved: (w: WidgetInstance) => void }) {
  const [draft, setDraft] = useState<NoteConfig>({ title: '', text: '' })
  const [busy, setBusy] = useState(false)
  const say = useToast()
  useEffect(() => {
    if (widget) setDraft(widget.config)
  }, [widget])
  const save = async () => {
    if (!widget) return
    setBusy(true)
    try {
      onSaved(await api<WidgetInstance>('/api/layout/widgets', { method: 'PUT', body: { id: widget.id, config: draft } }))
      onClose()
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={!!widget} onClose={onClose} title={m.widgets_note_dialogTitle()} busy={busy}>
      <label className="flex flex-col gap-1 text-[13px]">
        {m.widgets_note_title()}
        <input className="field" maxLength={TITLE_MAX} value={draft.title} placeholder={m.widgets_note_name()} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        {m.widgets_note_text()}
        <textarea className="field min-h-[180px] font-sans" maxLength={NOTE_MAX} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
        <span className="text-[11.5px] text-muted">{m.widgets_note_hint({ n: draft.text.length, max: NOTE_MAX })}</span>
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {m.common_cancel()}
        </button>
        <BusyButton className="btn primary" busy={busy} busyLabel={m.common_saving()} onClick={() => void save()}>
          {m.common_save()}
        </BusyButton>
      </div>
    </Modal>
  )
}

// ---------- settings of the other widgets ----------

export type Configurable = WidgetInstance & { kind: 'disk' | 'containers' | 'service' | 'links' }

/** ⚙ of a disk (mount point), the busiest containers (CPU or memory), a service (which unit) or a link group. */
export function WidgetSettingsDialog({ widget, mounts, units, onClose, onSaved }: { widget: Configurable | null; mounts: { mount: string; label: string }[]; units: { name: string; label: string }[]; onClose: () => void; onSaved: (w: WidgetInstance) => void }) {
  const [disk, setDisk] = useState<DiskConfig>({ mount: '' })
  const [top, setTop] = useState<ContainersConfig>({ metric: 'ram' })
  const [service, setService] = useState<ServiceConfig>({ unit: '' })
  const [links, setLinks] = useState<LinksConfig>({ title: '', links: [] })
  const [busy, setBusy] = useState(false)
  const say = useToast()
  useEffect(() => {
    if (widget?.kind === 'disk') setDisk({ mount: widget.config.mount || mounts[0]?.mount || '' })
    if (widget?.kind === 'containers') setTop(widget.config)
    if (widget?.kind === 'service') setService({ unit: widget.config.unit || units[0]?.name || '' })
    if (widget?.kind === 'links') setLinks(widget.config.links.length ? widget.config : { ...widget.config, links: [{ name: '', url: '' }] })
    // only when another widget opens: live updates bring new mount and unit lists every few
    // seconds and must not throw away what is being typed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget?.id])
  const badLink = links.links.findIndex((l) => (l.name.trim() || l.url.trim()) && (!l.name.trim() || !isWebUrl(l.url.trim())))
  const save = async () => {
    if (!widget) return
    setBusy(true)
    try {
      const config = widget.kind === 'disk' ? disk : widget.kind === 'containers' ? top : widget.kind === 'service' ? service : links
      onSaved(await api<WidgetInstance>('/api/layout/widgets', { method: 'PUT', body: { id: widget.id, config } }))
      onClose()
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={!!widget} onClose={onClose} title={widget ? m.widgets_settings_title({ name: widgetName(widget.kind) }) : ''} busy={busy}>
      {widget?.kind === 'disk' && (
        <label className="flex flex-col gap-1 text-[13px]">
          {m.widgets_disk_mount()}
          {mounts.length ? (
            <select className="field" value={disk.mount} onChange={(e) => setDisk({ mount: e.target.value })}>
              {mounts.map((x) => (
                <option key={x.mount} value={x.mount}>
                  {x.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-muted">{m.widgets_disk_noMounts()}</span>
          )}
        </label>
      )}
      {widget?.kind === 'containers' && (
        <div role="radiogroup" aria-label={m.widgets_containers_by()} className="flex flex-col gap-1.5 text-[13px]">
          <span>{m.widgets_containers_by()}</span>
          {(['ram', 'cpu'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2">
              <input type="radio" name="metric" checked={top.metric === k} onChange={() => setTop({ metric: k })} />
              {k === 'cpu' ? m.widgets_containers_cpu() : m.widgets_containers_ram()}
            </label>
          ))}
        </div>
      )}
      {widget?.kind === 'service' && (
        <label className="flex flex-col gap-1 text-[13px]">
          {m.widgets_service_unit()}
          {units.length ? (
            <select className="field" value={service.unit} onChange={(e) => setService({ unit: e.target.value })}>
              {units.map((u) => (
                <option key={u.name} value={u.name}>
                  {u.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-muted">{m.widgets_service_noUnits()}</span>
          )}
        </label>
      )}
      {widget?.kind === 'links' && (
        <div className="flex flex-col gap-2.5 text-[13px]">
          <label className="flex flex-col gap-1">
            {m.widgets_note_title()}
            <input className="field" maxLength={TITLE_MAX} value={links.title} placeholder={m.widgets_links_name()} onChange={(e) => setLinks({ ...links, title: e.target.value })} />
          </label>
          <span>{m.widgets_links_list()}</span>
          {links.links.map((l, i) => (
            <div key={i} className="flex flex-wrap gap-1.5">
              <input className="field w-[150px]" maxLength={TITLE_MAX} value={l.name} placeholder={m.widgets_links_namePlaceholder()} aria-label={m.widgets_links_nameN({ n: i + 1 })} onChange={(e) => setLinks({ ...links, links: links.links.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <input className="field min-w-0 grow font-mono" value={l.url} placeholder="http://192.168.178.1" aria-label={m.widgets_links_urlN({ n: i + 1 })} aria-invalid={badLink === i || undefined} onChange={(e) => setLinks({ ...links, links: links.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
              <button type="button" className="btn sm" aria-label={m.widgets_links_removeN({ n: i + 1 })} onClick={() => setLinks({ ...links, links: links.links.filter((_, j) => j !== i) })}>
                <Glyph name="close" size={13} />
              </button>
            </div>
          ))}
          {links.links.length < LINKS_MAX && (
            <button type="button" className="btn sm self-start" onClick={() => setLinks({ ...links, links: [...links.links, { name: '', url: '' }] })}>
              <Glyph name="plus" size={13} /> {m.widgets_links_add()}
            </button>
          )}
          {badLink >= 0 && <p className="m-0 text-[12px] text-[#e3b341]">{m.widgets_links_invalid({ n: badLink + 1 })}</p>}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {m.common_cancel()}
        </button>
        <BusyButton className="btn primary" busy={busy} busyLabel={m.common_saving()} disabled={(widget?.kind === 'disk' && !disk.mount) || (widget?.kind === 'service' && !service.unit) || (widget?.kind === 'links' && badLink >= 0)} onClick={() => void save()}>
          {m.common_save()}
        </BusyButton>
      </div>
    </Modal>
  )
}
