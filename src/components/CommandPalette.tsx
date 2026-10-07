import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLang } from '~/i18n'
import { useLiveState } from '~/lib/live'
import { filterPalette, paletteItems, sectionLabel, type PaletteItem } from '~/lib/palette'
import { useActions } from './Actions'
import { setMotion } from '~/lib/motion'
import { setTheme } from '~/lib/theme'
import { Glyph } from './Glyph'
import { m } from '~/paraglide/messages'

/** Strg+K / ⌘K: jump to services, pages and units, or run unit actions. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { snapshot } = useLiveState()
  const { run, readonly } = useActions()
  const navigate = useNavigate()
  const lang = useLang()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  useEffect(() => {
    const d = dialog.current
    if (!d) return
    if (open && !d.open) {
      setQuery('')
      setActive(0)
      d.showModal()
    }
    if (!open && d.open) d.close()
  }, [open])

  // only while open: the items change with every live update
  const all = useMemo(() => (open ? paletteItems(snapshot, readonly) : []), [open, snapshot, readonly, lang]) // eslint-disable-line react-hooks/exhaustive-deps
  const results = useMemo(() => filterPalette(all, query), [all, query])
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const execute = (item: PaletteItem) => {
    onOpenChange(false)
    const a = item.action
    if (a.kind === 'open') window.open(a.url, '_blank', 'noopener,noreferrer')
    if (a.kind === 'navigate') void navigate({ to: a.to, search: a.search as never })
    if (a.kind === 'unit') run(a.action, { kind: 'unit', name: a.name })
    if (a.kind === 'motion') setMotion(a.level)
    if (a.kind === 'theme') setTheme(a.theme)
  }

  let lastSection = ''
  return (
    <dialog ref={dialog} className="modal palette" onClose={() => onOpenChange(false)} aria-label={m.shell_palette_label()}>
      {open && (
        <div className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-line px-4">
            <Glyph name="search" size={16} />
            <input
              autoFocus
              className="w-full bg-transparent py-3.5 text-[15px] text-fg outline-none"
              placeholder={m.shell_palette_placeholder()}
              value={query}
              aria-label={m.shell_palette_search()}
              aria-controls="palette-list"
              aria-activedescendant={results[active] ? `pi-${active}` : undefined}
              role="combobox"
              aria-expanded="true"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setActive((i) => Math.min(results.length - 1, i + 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActive((i) => Math.max(0, i - 1))
                } else if (e.key === 'Enter' && results[active]) {
                  e.preventDefault()
                  execute(results[active])
                }
              }}
            />
            <kbd className="mono rounded border border-rim-strong px-1.5 py-0.5 text-[11px] text-muted">Esc</kbd>
          </div>
          <ul id="palette-list" ref={list} role="listbox" className="m-0 max-h-[60vh] list-none overflow-y-auto p-2">
            {results.length === 0 && <li className="px-3 py-4 text-[13px] text-muted">{m.shell_palette_empty()}</li>}
            {results.map((item, n) => {
              const header = item.section !== lastSection ? item.section : null
              lastSection = item.section
              return (
                <li key={item.id}>
                  {header && <div className="px-3 pt-2 pb-1 text-[11px] tracking-[.07em] text-faint uppercase">{sectionLabel(header)}</div>}
                  <div
                    id={`pi-${n}`}
                    data-index={n}
                    role="option"
                    aria-selected={n === active}
                    onMouseMove={() => setActive(n)}
                    onClick={() => execute(item)}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[14px] ${n === active ? 'bg-accent/14 text-accent-soft' : 'text-fg'}`}
                  >
                    <Glyph name={item.section === 'Services' ? 'globe' : item.section === 'Units' ? 'restart' : item.section === 'Journal' ? 'journal' : 'overview'} size={15} />
                    <span className="grow truncate">{item.label}</span>
                    {item.hint && <span className="truncate font-mono text-[11px] text-muted">{item.hint}</span>}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </dialog>
  )
}
