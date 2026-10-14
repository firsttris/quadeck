import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { AddLinkDialog } from '~/components/AddLinkDialog'
import { type DefaultItem, EditableGrid, type GridSpec, recentlyDragged } from '~/components/EditableGrid'
import { Glyph } from '~/components/Glyph'
import { ConfirmDialog } from '~/components/Modal'
import { ServiceDialog } from '~/components/ServiceDialog'
import { ServiceTile } from '~/components/ServiceTile'
import { useToast } from '~/components/Toast'
import { pickMsg } from '~/i18n'
import { api } from '~/lib/api'
import { m } from '~/paraglide/messages'
import { type GridItem, ICON_SIZES, type IconSize } from '~/shared/layout'
import type { HiddenService, Service, ServiceGroup } from '~/shared/types'

// ---------- tile grid (level 2, inside the Services card) ----------

/** Breakpoints refer to the width of the Services card, not the window. */
const TILE_GRID_BASE = { breakpoints: { lg: 1100, md: 820, sm: 560, xs: 0 }, cols: { lg: 8, md: 6, sm: 4, xs: 2 }, rowHeight: 112, margin: [12, 12] as [number, number] }
/** Larger icons make the tiles taller, so name and host keep their room. */
const TILE_ROW: Record<IconSize, number> = { sm: 106, md: 118, lg: 130 }

function flowTiles(items: Service[], cols: number): DefaultItem[] {
  return items.map((s, n) => ({ i: s.key, x: n % cols, y: Math.floor(n / cols), w: 1, h: 1, maxW: Math.min(4, cols), maxH: 3 }))
}

// ---------- services (with tile grid per group) ----------

export const groupLabel = (name: string) =>
  pickMsg({ Medien: m.overview_groupNames_Medien, Netzwerk: m.overview_groupNames_Netzwerk, 'Produktivit\u00e4t': m.overview_groupNames_Produktivitaet }, name)

/** The tile group under the pointer of a drag event, the dragged tile itself looked through. */
function groupAt(e: Event): string | undefined {
  const p = (e as TouchEvent).changedTouches?.[0] ?? (e as MouseEvent)
  if (typeof p?.clientX !== 'number') return undefined
  for (const el of document.elementsFromPoint(p.clientX, p.clientY)) {
    if (el.closest('.react-draggable-dragging')) continue
    const g = el.closest<HTMLElement>('[data-tile-group]')
    if (g) return g.dataset.tileGroup
  }
  return undefined
}

/** Whether a service matches the search on the services page (name, host, URL, group). */
export function matchesService(s: Service, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [s.name, s.host, s.url, s.group, groupLabel(s.group)].some((v) => v.toLowerCase().includes(q))
}

/**
 * The services and links with their tile grid per group: the services widget on the overview and
 * the services page. Both share the tile layout, the icon size and the dialogs.
 */
export function Services({
  groups,
  editing,
  saved,
  onSave,
  iconSize,
  onIconSize,
  heading = true,
  query = '',
  extra,
}: {
  groups: ServiceGroup[]
  editing: boolean
  saved: Record<string, GridItem[]>
  onSave: (bp: string, items: GridItem[]) => void
  iconSize: IconSize
  onIconSize: (size: IconSize) => void
  /** The card heading; the services page has its own page title. */
  heading?: boolean
  /** Search (services page): matching tiles in one flat list instead of the editable groups. */
  query?: string
  /** More buttons in the header row, e.g. the link to the services page. */
  extra?: ReactNode
}) {
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Service | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  // Drag and drop between groups (edit mode): the group the tile would land in.
  const [dropTarget, setDropTarget] = useState<string>()
  const say = useToast()
  const groupNames = useMemo(() => groups.map((g) => g.name), [groups])
  const groupOf = (key: string) => groups.find((g) => g.items.some((s) => s.key === key))
  // The drop lands where the highlight is (the groups below can still shift as the grid compacts).
  const lastTarget = useRef<string | undefined>(undefined)
  const dragOver = (key: string, e: Event) => {
    const g = groupAt(e)
    if (!g) return // in the gap between two groups: the last one stays highlighted
    lastTarget.current = g !== groupOf(key)?.name ? g : undefined
    setDropTarget(lastTarget.current)
  }
  const drop = (key: string, e: Event) => {
    const at = groupAt(e)
    const target = at && at !== groupOf(key)?.name ? at : lastTarget.current
    lastTarget.current = undefined
    setDropTarget(undefined)
    const s = groupOf(key)?.items.find((x) => x.key === key)
    if (!s || !target || target === groupOf(key)?.name) return false
    api('/api/services/override', { body: { key, group: target, onlyGroup: true } })
      .then(() => say(m.overview_services_moved({ name: s.name, group: groupLabel(target) })))
      .catch((err: Error) => say(err.message, 'bad'))
    return true
  }
  // Look the service up live, so the dialog follows SSE updates.
  const edited = editingKey ? (groups.flatMap((g) => g.items).find((s) => s.key === editingKey) ?? null) : null
  const searching = !editing && !!query.trim()
  const found = searching ? groups.flatMap((g) => g.items).filter((s) => matchesService(s, query)) : []
  return (
    <section className="flex flex-col gap-[14px] p-[18px]" aria-label={m.overview_cards_services()}>
      <div className="flex flex-wrap items-center gap-3 in-[.editing]:pr-16">
        {heading && <h2 className="h2">{m.overview_cards_services()}</h2>}
        {/* in edit mode: how tiles change group, next to the icon size */}
        <span className="grow text-[12px] text-muted">{editing ? groups.length > 1 && m.overview_services_dragHint() : m.overview_services_detected()}</span>
        {editing && (
          <div className="no-drag flex items-center gap-1.5" role="radiogroup" aria-label={m.overview_services_iconSize()}>
            <span className="text-[12px] text-muted">{m.overview_services_iconSize()}</span>
            {ICON_SIZES.map((z) => (
              <button key={z} type="button" role="radio" aria-checked={iconSize === z} className={`seg ${iconSize === z ? 'on' : ''}`} onClick={() => onIconSize(z)}>
                {pickMsg({ sm: m.overview_services_iconSmall, md: m.overview_services_iconMedium, lg: m.overview_services_iconLarge }, z)}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="btn sm no-drag" onClick={() => setAdding(true)}>
          <Glyph name="plus" size={14} strokeWidth={2} />
          {m.overview_services_addLink()}
        </button>
        {extra}
      </div>
      {groups.length === 0 && <p className="m-0 text-[13px] text-muted">{m.overview_services_empty()}</p>}
      {searching && found.length === 0 && groups.length > 0 && <p className="m-0 text-[13px] text-muted">{m.services_page_noMatch({ query: query.trim() })}</p>}
      {searching && found.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3" data-testid="service-results">
          {found.map((s) => (
            <div key={s.key} style={{ height: TILE_ROW[iconSize] }}>
              <ServiceTile s={s} size={iconSize} />
            </div>
          ))}
        </div>
      )}
      {!searching &&
        groups.map((g) => (
          <TileGroup
            key={g.name}
            group={g}
            iconSize={iconSize}
            editing={editing}
            saved={saved}
            onSave={onSave}
            onDelete={setRemoving}
            onEdit={(s) => {
              if (!recentlyDragged()) setEditingKey(s.key)
            }}
            dropTarget={dropTarget === g.name}
            onItemDrag={groups.length > 1 ? dragOver : undefined}
            onItemDrop={groups.length > 1 ? drop : undefined}
          />
        ))}
      <AddLinkDialog open={adding} onClose={() => setAdding(false)} groups={groupNames} />
      <ServiceDialog service={edited} groups={groupNames} onClose={() => setEditingKey(null)} />
      <ConfirmDialog
        open={!!removing}
        title={m.overview_services_removeTitle({ name: removing?.name ?? '' })}
        body={<p className="m-0">{m.overview_services_removeBody()}</p>}
        confirm={m.common_remove()}
        danger
        busyLabel={m.common_deleting()}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return
          try {
            await api(`/api/links/${removing.manualId}`, { method: 'DELETE' })
            say(m.overview_services_removed({ name: removing.name }))
          } catch (e) {
            say((e as Error).message, 'bad')
          }
        }}
      />
    </section>
  )
}

function TileGroup({
  group,
  iconSize,
  editing,
  saved,
  onSave,
  onDelete,
  onEdit,
  dropTarget,
  onItemDrag,
  onItemDrop,
}: {
  group: ServiceGroup
  iconSize: IconSize
  editing: boolean
  saved: Record<string, GridItem[]>
  onSave: (bp: string, items: GridItem[]) => void
  onDelete: (s: Service) => void
  onEdit: (s: Service) => void
  dropTarget: boolean
  onItemDrag?: (key: string, e: Event) => void
  onItemDrop?: (key: string, e: Event) => boolean
}) {
  const keys = group.items.map((s) => s.key).join('\n')
  // biome-ignore lint/correctness/useExhaustiveDependencies: only rebuilt when the tiles or the icon size change
  const spec: GridSpec = useMemo(() => ({ ...TILE_GRID_BASE, rowHeight: TILE_ROW[iconSize], defaults: (_bp, cols) => flowTiles(group.items, cols) }), [keys, iconSize])
  // Only this group's tiles are relevant for its grid.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keys stand for the group's items, which are new on every update
  const own = useMemo(() => {
    const ids = new Set(group.items.map((s) => s.key))
    return Object.fromEntries(Object.entries(saved).map(([bp, items]) => [bp, items.filter((it) => ids.has(it.i))]))
  }, [saved, keys])
  return (
    <div
      className={`-m-1.5 flex flex-col gap-[10px] rounded-[10px] p-1.5 outline-2 outline-offset-2 ${dropTarget ? 'bg-accent/10 outline-accent outline-dashed' : 'outline-transparent'}`}
      data-tile-group={group.name}
      data-testid="tile-group"
      aria-label={groupLabel(group.name)}
      role="group"
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] tracking-[.08em] text-muted uppercase">{groupLabel(group.name)}</span>
        <span className="text-[11px] text-dim">{group.note}</span>
      </div>
      <EditableGrid
        spec={spec}
        ssrBreakpoint="sm"
        items={group.items.map((s) => ({
          i: s.key,
          node: <ServiceTile s={s} size={iconSize} editing={editing} onEdit={() => onEdit(s)} onDelete={s.manualId !== undefined ? () => onDelete(s) : undefined} />,
        }))}
        saved={own}
        editing={editing}
        onSave={onSave}
        measureItems={false}
        onItemDrag={onItemDrag}
        onItemDrop={onItemDrop}
      />
    </div>
  )
}

/** Edit bar part: hidden services, each with a button to show it again. */
export function HiddenServices({ hidden }: { hidden: HiddenService[] }) {
  const say = useToast()
  if (!hidden.length) return null
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {m.overview_edit_hiddenServices()}
      {hidden.map((h) => (
        <button
          key={h.key}
          type="button"
          className="seg"
          aria-label={m.overview_edit_showAgain({ name: h.name })}
          onClick={() => api('/api/services/override', { body: { key: h.key, hidden: false, onlyHidden: true } }).catch((e) => say((e as Error).message, 'bad'))}
        >
          <Glyph name="plus" size={12} strokeWidth={2} />
          {h.name}
        </button>
      ))}
    </span>
  )
}

/** "E" toggles edit mode (not while typing or in a dialog). */
export function useEditKey(toggle: () => void) {
  const latest = useRef(toggle)
  latest.current = toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'e' || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable], dialog[open]') || document.querySelector('dialog[open]')) return
      latest.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
