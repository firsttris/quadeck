import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Responsive, useContainerWidth, type Layout, type LayoutItem } from 'react-grid-layout'
import type { GridItem } from '~/shared/layout'

/** Default position for one item; h undefined = automatic height (measured from the content). */
export interface DefaultItem {
  i: string
  x: number
  y: number
  w: number
  h?: number
  minW?: number
  minH?: number
  maxW?: number
  maxH?: number
}

export interface GridSpec {
  breakpoints: Record<string, number>
  cols: Record<string, number>
  rowHeight: number
  margin: [number, number]
  /** Default layout for a breakpoint, for the items currently shown (in order). */
  defaults: (bp: string, cols: number) => DefaultItem[]
}

// The click that ends a drag must not count as a click on the item.
let lastGestureAt = 0
export const recentlyDragged = () => Date.now() - lastGestureAt < 400

const rowsFor = (px: number, rowHeight: number, gap: number) => Math.max(1, Math.ceil((px + gap) / (rowHeight + gap)))

/**
 * Merges saved positions with the defaults: saved items keep x/y/w/h (h = 0:
 * automatic height); items without a saved position keep their default slot
 * but go below the saved ones, where vertical compaction pulls them up.
 */
export function mergeLayout(defaults: DefaultItem[], saved: GridItem[] | undefined, measured: Record<string, number>, spec: Pick<GridSpec, 'rowHeight' | 'margin'>): (LayoutItem & { auto: boolean })[] {
  const byId = new Map((saved ?? []).map((s) => [s.i, s]))
  const offset = saved?.length ? 1000 : 0
  return defaults.map((d) => {
    const s = byId.get(d.i)
    const autoDefault = d.h === undefined
    const auto = s ? s.h === 0 && autoDefault : autoDefault
    const autoH = measured[d.i] !== undefined ? rowsFor(measured[d.i]!, spec.rowHeight, spec.margin[1]) : (d.minH ?? 4)
    // Saved heights below the minimum (older layouts, cards that grew) are raised.
    const h = Math.max(auto ? autoH : s?.h || d.h || 1, d.minH ?? 1)
    const base = s ? { x: s.x, y: s.y, w: s.w } : { x: d.x, y: d.y + offset, w: d.w }
    return { i: d.i, ...base, h, minW: d.minW, minH: d.minH, maxW: d.maxW, maxH: d.maxH, auto }
  })
}

function currentBreakpoint(breakpoints: Record<string, number>, width: number) {
  return Object.entries(breakpoints)
    .sort((a, b) => b[1] - a[1])
    .find(([, min]) => width >= min)![0]
}

export interface EditableGridProps {
  spec: GridSpec
  items: { i: string; node: ReactNode }[]
  saved: Record<string, GridItem[]>
  editing: boolean
  /** Persist the layout of one breakpoint (auto-height items carry h = 0). */
  onSave: (bp: string, items: GridItem[]) => void
  /** CSS selector of the drag handle (cards); without it the whole item drags (tiles). */
  handle?: string
  className?: string
  /** Breakpoint used for the server render before the width is known. */
  ssrBreakpoint: string
  /** Class for each grid item (e.g. the card frame). */
  itemClassName?: string
  /** Measure content for automatic heights (cards); tiles have fixed sizes. */
  measureItems?: boolean
  /** Extra controls per item in edit mode (drag handle, hide button). */
  renderChrome?: (id: string) => ReactNode
}

/**
 * react-grid-layout with per-breakpoint persistence and automatic heights.
 * Before mount (SSR) the same layout is rendered as a CSS grid, so the page
 * does not jump when the grid takes over.
 */
export function EditableGrid({ spec, items, saved, editing, onSave, handle, className, ssrBreakpoint, itemClassName, measureItems = true, renderChrome }: EditableGridProps) {
  const { width, containerRef, mounted } = useContainerWidth()
  const [measured, setMeasured] = useState<Record<string, number>>({})
  const observer = useRef<ResizeObserver | null>(null)
  const resized = useRef(new Set<string>())

  useEffect(() => () => observer.current?.disconnect(), [])

  const measure = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (!el || typeof ResizeObserver === 'undefined') return
      observer.current ??= new ResizeObserver((entries) => {
        setMeasured((prev) => {
          let next = prev
          for (const e of entries) {
            const gid = (e.target as HTMLElement).dataset.gridId!
            const h = Math.ceil((e.target as HTMLElement).offsetHeight)
            if (prev[gid] !== h) next = { ...next, [gid]: h }
          }
          return next
        })
      })
      el.dataset.gridId = id
      observer.current.observe(el)
    },
    [],
  )

  const ids = items.map((it) => it.i).join('\n')
  const layouts = useMemo(() => {
    const out: Record<string, (LayoutItem & { auto: boolean })[]> = {}
    for (const [bp, cols] of Object.entries(spec.cols)) out[bp] = mergeLayout(spec.defaults(bp, cols), saved[bp], measured, spec)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, saved, measured, spec])

  const bp = mounted ? currentBreakpoint(spec.breakpoints, width) : ssrBreakpoint

  const persist = (layout: Layout) => {
    const auto = new Map(layouts[bp]!.map((l) => [l.i, l.auto]))
    onSave(
      bp,
      layout.map((l) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: auto.get(l.i) && !resized.current.has(l.i) ? 0 : l.h })),
    )
    resized.current.clear()
  }

  const children = items.map((it) => (
    <div key={it.i} className={`grid-item ${itemClassName ?? ''} ${editing ? 'editing' : ''}`} data-testid={`grid-item-${it.i}`}>
      {editing && renderChrome?.(it.i)}
      {measureItems ? (
        <div className="grid-item-scroll">
          <div ref={measure(it.i)}>{it.node}</div>
        </div>
      ) : (
        it.node
      )}
    </div>
  ))

  if (!mounted) {
    // Server render / first paint: same geometry as a CSS grid (stacked on phones).
    const lay = layouts[ssrBreakpoint] ?? []
    const cols = spec.cols[ssrBreakpoint]!
    const style = { '--cols': cols, '--row': `${spec.rowHeight}px`, '--gap': `${spec.margin[1]}px` } as CSSProperties
    return (
      <div ref={containerRef} className={`ssr-grid ${className ?? ''}`} style={style}>
        {items.map((it) => {
          const l = lay.find((x) => x.i === it.i)
          return (
            <div key={it.i} className={`grid-item ${itemClassName ?? ''}`} style={l ? { gridColumn: `${l.x + 1} / span ${l.w}`, gridRow: `${l.y + 1} / span ${l.h}` } : undefined}>
              {it.node}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div ref={containerRef} className={className}>
      <Responsive
        width={width}
        breakpoints={spec.breakpoints}
        cols={spec.cols}
        layouts={layouts}
        rowHeight={spec.rowHeight}
        margin={spec.margin}
        containerPadding={[0, 0]}
        dragConfig={{ enabled: editing, handle, cancel: '.no-drag', threshold: 4 }}
        resizeConfig={{ enabled: editing, handles: ['se'] }}
        onResizeStop={(l: Layout, _old: LayoutItem | null, item: LayoutItem | null) => {
          // A resized item keeps its height from now on (no longer automatic).
          if (item) resized.current.add(item.i)
          lastGestureAt = Date.now()
          persist(l)
        }}
        onDragStop={(l: Layout) => {
          lastGestureAt = Date.now()
          persist(l)
        }}
      >
        {children}
      </Responsive>
    </div>
  )
}
