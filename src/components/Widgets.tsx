// Widgets added from the catalog: the catalog dialog and the widgets themselves (note, …).

import { useEffect, useMemo, useState } from 'react'
import { api } from '~/lib/api'
import { linkify, NOTE_MAX, TITLE_MAX, WIDGETS, type BuiltinCard, type InstanceKind, type NoteConfig, type WidgetCategory, type WidgetInstance } from '~/shared/widgets'
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
