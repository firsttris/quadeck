import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** Checkbox item (e.g. "start at boot"). */
  checked?: boolean
  /** Line above this item. */
  separator?: boolean
}

/**
 * "⋯" menu for a table row. Rendered into <body> with fixed coordinates, so a
 * scrolling table does not cut it off. Arrow keys, Home/End, Escape, click outside.
 */
export function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number; up: boolean } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  const place = () => {
    const r = button.current?.getBoundingClientRect()
    if (!r) return
    const up = r.bottom + 260 > window.innerHeight && r.top > 260
    setPos({ top: up ? r.top - 4 : r.bottom + 4, right: window.innerWidth - r.right, up })
  }

  useLayoutEffect(() => {
    if (open) place()
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (menu.current?.contains(e.target as Node) || button.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    // Scrolling moves the menu along with its button instead of closing it.
    const follow = () => place()
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [open])

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus({ preventScroll: true })
  }, [open, pos === null])

  const keys = (e: React.KeyboardEvent) => {
    const list = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [])]
    const i = list.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => {
      e.preventDefault()
      list[(n + list.length) % list.length]?.focus()
    }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(list.length - 1)
    else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false)
      button.current?.focus()
    }
  }

  return (
    <>
      <button ref={button} type="button" className="btn sm !px-2" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={label}
            onKeyDown={keys}
            className="fixed z-50 flex min-w-[210px] flex-col rounded-[10px] border border-edge bg-surface py-1 shadow-[0_12px_32px_rgba(0,0,0,.45)]"
            style={{ right: pos.right, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
          >
            {items.map((it) => (
              <div key={it.label} className={it.separator ? 'mt-1 border-t border-line pt-1' : ''}>
                <button
                  type="button"
                  role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                  aria-checked={it.checked}
                  disabled={it.disabled}
                  className={`flex w-full items-center gap-2 px-3 py-[7px] text-left text-[13px] outline-none hover:bg-[rgba(255,255,255,.05)] focus-visible:bg-accent/12 disabled:opacity-40 ${it.danger ? 'text-[#ff8a80]' : 'text-fg'}`}
                  onClick={() => {
                    setOpen(false)
                    it.onSelect()
                  }}
                >
                  {it.checked !== undefined && <span className="w-3.5 text-accent">{it.checked ? '✓' : ''}</span>}
                  {it.label}
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
