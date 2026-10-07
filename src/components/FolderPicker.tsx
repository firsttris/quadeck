import { useEffect, useState } from 'react'
import { api } from '~/lib/api'
import { bytes } from '~/lib/format'
import type { FolderListing } from '~/shared/backup'
import { m } from '~/paraglide/messages'
import { Glyph } from './Glyph'
import { Modal } from './Modal'

const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)
const parentOf = (p: string) => (p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/')))

/**
 * Browses the server's folders (names only, read by the root helper). The folder shown is the
 * choice: `onChange` gets it on every step. With `compare`, says whether the folder is on the same
 * disk as those paths (a backup target should not be).
 */
export function FolderPicker({ value, onChange, compare, target }: { value: string; onChange: (path: string) => void; compare?: string[]; target?: boolean }) {
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState('')
  const [hidden, setHidden] = useState(false)
  const path = value.trim() || '/'
  const compareKey = (compare ?? []).join('\n')

  useEffect(() => {
    let stale = false
    const t = setTimeout(() => {
      api<FolderListing>('/api/backup', { body: { dirs: { path, compare: compareKey ? compareKey.split('\n') : [] } } })
        .then((l) => !stale && (setListing(l), setError('')))
        .catch((e: Error) => !stale && setError(e.message))
    }, 150) // typing in the field next to it: not one request per key
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [path, compareKey])

  const shown = listing?.path ?? path
  const crumbs = shown === '/' ? [] : shown.slice(1).split('/')
  const dirs = (listing?.dirs ?? []).filter((d) => hidden || !d.startsWith('.'))
  const hiddenCount = (listing?.dirs ?? []).filter((d) => d.startsWith('.')).length

  return (
    <div className="flex flex-col gap-2" data-testid="folder-picker">
      <div className="overflow-hidden rounded-[10px] border border-rim bg-sunken">
        <nav className="flex flex-wrap items-center gap-0.5 border-b border-line px-2.5 py-1.5 font-mono text-[12.5px]" aria-label={m.folders_crumbs()}>
          <button type="button" className="rounded px-1 text-subtle hover:text-fg" onClick={() => onChange('/')}>
            /
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5">
              {i > 0 && <span className="text-faint">/</span>}
              <button type="button" className={`rounded px-1 ${i === crumbs.length - 1 ? 'text-accent' : 'text-subtle hover:text-fg'}`} onClick={() => onChange(`/${crumbs.slice(0, i + 1).join('/')}`)}>
                {c}
              </button>
            </span>
          ))}
          {hiddenCount > 0 && (
            <label className="ml-auto flex items-center gap-1.5 font-sans text-[12px] text-muted">
              <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
              {m.folders_hidden({ count: hiddenCount })}
            </label>
          )}
        </nav>
        <ul className="m-0 max-h-[220px] list-none overflow-y-auto p-0" aria-label={m.folders_list()}>
          {shown !== '/' && (
            <li>
              <button type="button" className="flex w-full items-center gap-2 border-b border-line px-3 py-[6px] text-left text-[13px] text-muted hover:bg-white/3" onClick={() => onChange(parentOf(shown))}>
                <span aria-hidden="true">↑</span> {m.folders_up()}
              </button>
            </li>
          )}
          {dirs.map((d) => (
            <li key={d}>
              <button type="button" className="flex w-full items-center gap-2 border-b border-line px-3 py-[6px] text-left font-mono text-[13px] last:border-0 hover:bg-accent/8" onClick={() => onChange(join(shown, d))}>
                <span className="text-accent">
                  <Glyph name="folder" size={14} />
                </span>
                {d}
              </button>
            </li>
          ))}
          {listing && dirs.length === 0 && <li className="px-3 py-2 text-[12px] text-muted">{m.folders_empty()}</li>}
        </ul>
      </div>
      {error && (
        <p role="alert" className="m-0 text-[12px] text-[#ff8a80]">
          {error}
        </p>
      )}
      {listing?.missing && (
        <p className="m-0 text-[12px] text-muted" data-testid="folder-missing">
          {target && parentOf(path) === listing.path ? m.folders_willCreate({ name: path.slice(path.lastIndexOf('/') + 1) }) : <span className="text-[#e3b341]">{m.folders_missing({ path: parentOf(path) })}</span>}
        </p>
      )}
      {listing?.disk && (
        <p className="m-0 text-[12px] text-muted" data-testid="folder-disk">
          {m.folders_disk({ mount: listing.disk.mount, free: bytes(listing.disk.free), size: bytes(listing.disk.size) })}
          {compare && compare.length > 0 && (listing.sameDisk.length > 0 ? <span className="text-[#e3b341]"> · {m.folders_sameDisk({ count: listing.sameDisk.length })}</span> : <span className="text-[#7ee2a8]"> · {m.folders_otherDisk()}</span>)}
        </p>
      )}
    </div>
  )
}

/** A folder browser in a dialog: pick a folder and add it. */
export function FolderPickerDialog({ title, start = '/', onPick, onClose }: { title: string; start?: string; onPick: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(start)
  return (
    <Modal open title={title} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <input className="field font-mono" value={path} aria-label={m.folders_path()} onChange={(e) => setPath(e.target.value)} />
        <FolderPicker value={path} onChange={setPath} />
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <button type="button" className="btn" onClick={onClose}>
            {m.common_cancel()}
          </button>
          <button type="button" className="btn primary" disabled={path.trim() === '/' || !path.trim().startsWith('/')} onClick={() => onPick(path.trim().replace(/\/+$/, ''))}>
            {m.folders_add()}
          </button>
        </div>
      </div>
    </Modal>
  )
}
