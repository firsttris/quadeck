import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { bytes, dateTime, diskSize } from '~/lib/format'
import { baseName, fileKind, isSensitivePath, joinPath, parentOf, validateName, type DirListing, type FileEntry, type FileRoot } from '~/shared/files'
import { useActions } from './Actions'
import { BusyButton, useBusy } from './Busy'
import { Glyph } from './Glyph'
import { useJobs } from './Jobs'
import { ConfirmDialog, Modal } from './Modal'
import { useToast } from './Toast'
import { TextFileEditor } from './TextFileEditor'
import { PackDialog, UnpackDialog } from './ArchiveDialogs'
import { archiveFormat } from '~/shared/archives'
import { RowMenu } from './RowMenu'
import { useGuardedApi, useUnlock } from './Unlock'
import { localeOf } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

type Clip = { mode: 'copy' | 'cut'; paths: string[] }
type Sort = 'name' | 'size' | 'mtime'
export type Side = 'left' | 'right'
type Mode = 'copy' | 'move'

const TWO_KEY = 'quadeck.files.twoPanes'
const DRAG_TYPE = 'application/x-quadeck-files'
const other = (s: Side): Side => (s === 'left' ? 'right' : 'left')

/** The browser remembers whether two panes were open (a convenience: may be unavailable). */
const rememberTwo = (on: boolean) => {
  try {
    localStorage.setItem(TWO_KEY, on ? '1' : '0')
  } catch {
    // private window or blocked storage
  }
}
const rememberedTwo = () => {
  try {
    return localStorage.getItem(TWO_KEY) === '1'
  } catch {
    return false
  }
}

/** One folder view: its listing, selection and derived paths. Reloads when a job ends. */
function usePane(path: string | undefined, roots: FileRoot[] | null, hidden: boolean, sort: Sort, finished: number) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    if (!path) return
    try {
      const r = await fetch(`/api/files?path=${encodeURIComponent(path)}`)
      const d = (await r.json()) as DirListing & { error?: string }
      if (!r.ok) throw new Error(d.error ?? m.common_http({ status: r.status }))
      setListing(d)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [path])
  useEffect(() => {
    setSelected(new Set())
    void load()
  }, [load])
  // Copy/move/delete jobs change the folder.
  useEffect(() => {
    if (finished) void load()
  }, [finished, load])

  const entries = useMemo(() => {
    const list = (listing?.entries ?? []).filter((e) => hidden || !e.name.startsWith('.'))
    const dirFirst = (a: FileEntry, b: FileEntry) => Number(b.type === 'dir') - Number(a.type === 'dir')
    return list.sort((a, b) => dirFirst(a, b) || (sort === 'size' ? b.size - a.size : sort === 'mtime' ? b.mtime - a.mtime : a.name.localeCompare(b.name, localeOf(), { numeric: true })))
  }, [listing, hidden, sort])

  const cur = listing?.path ?? path ?? ''
  const rootInfo = roots?.find((r) => r.path === listing?.root) ?? roots?.find((r) => cur === r.path || cur.startsWith(r.path + '/'))
  const root = listing?.root ?? rootInfo?.path ?? ''
  const toggle = (name: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(name)) n.delete(name)
      else n.add(name)
      return n
    })
  return {
    listing,
    error,
    load,
    entries,
    cur,
    root,
    rootInfo,
    crumbs: cur.slice(root.length).split('/').filter(Boolean),
    selected,
    setSelected,
    toggle,
    selPaths: [...selected].map((n) => joinPath(cur, n)),
    names: new Set(listing?.entries.map((e) => e.name)),
  }
}
type Pane = ReturnType<typeof usePane>

/**
 * A small file manager for the data areas: browse, new folder, rename,
 * copy/cut/paste and delete; optionally two panes side by side (copy and move
 * from one to the other, like a two-panel commander). Copy, move and delete
 * run as jobs with live output (they can take long on big folders).
 */
export function FileExplorer({ path, right, onNavigate, onTwoPanes }: { path?: string; right?: string; onNavigate: (p: string, side?: Side) => void; onTwoPanes?: (right: string | null) => void }) {
  const say = useToast()
  const jobs = useJobs()
  const guarded = useGuardedApi()
  const { readonly } = useActions()
  const [roots, setRoots] = useState<FileRoot[] | null>(null)
  const [rootsError, setRootsError] = useState('')
  const [clip, setClip] = useState<Clip | null>(null)
  const [hidden, setHidden] = useState(false)
  const [sort, setSort] = useState<Sort>('name')
  const [open, setOpen] = useState<string | null>(null)
  const [active, setActive] = useState<Side>('left')
  const [hint, setHint] = useState<Mode | null>(null)
  const [dropOn, setDropOn] = useState<Side | null>(null)
  const [archive, setArchive] = useState<null | { kind: 'unpack'; archive: string; here: string; other?: string } | { kind: 'pack'; dir: string; paths: string[] }>(null)
  const unpack = (s: Side, path: string) => setArchive({ kind: 'unpack', archive: path, here: panes[s].cur, other: two ? panes[other(s)].cur : undefined })
  const unlock = useUnlock()
  const two = right !== undefined && !!onTwoPanes
  const panes: Record<Side, Pane> = {
    left: usePane(path, roots, hidden, sort, jobs.finished),
    right: usePane(two ? right || undefined : undefined, roots, hidden, sort, jobs.finished),
  }
  const side: Side = two ? active : 'left'
  const pane = panes[side]
  const target = panes[other(side)]
  const go = (p: string, s: Side = side) => onNavigate(p, s)

  /** In a new tab (what the browser can show) or as a download; keys and secrets ask for the unlock first. */
  const openRaw = async (p: string, download: boolean) => {
    if (isSensitivePath(p) && !(await unlock.ensure())) return
    const url = `/api/files?raw=${encodeURIComponent(p)}${download ? '&download=1' : ''}`
    if (!download) {
      window.open(url, '_blank', 'noopener')
      return
    }
    const a = document.createElement('a')
    a.href = url
    a.download = baseName(p)
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
  const [dialog, setDialog] = useState<null | { kind: 'mkdir' } | { kind: 'rename'; entry: FileEntry } | { kind: 'delete' } | { kind: 'overwrite'; names: string[]; toDir: string; run: () => Promise<unknown> }>(null)

  useEffect(() => {
    fetch('/api/files')
      .then((r) => r.json())
      .then((d: { roots?: FileRoot[]; error?: string }) => {
        if (!d.roots) throw new Error(d.error ?? m.common_error())
        setRoots(d.roots)
        if (!path && d.roots[0]) onNavigate(d.roots[0].path)
      })
      .catch((e: Error) => setRootsError(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Two panes stay open across visits when they were open last time.
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !path || !onTwoPanes) return
    restored.current = true
    if (right === undefined && rememberedTwo()) onTwoPanes(path)
  }, [path, right, onTwoPanes])
  // The right pane starts where the left one is.
  useEffect(() => {
    if (two && !right && path) onNavigate(path, 'right')
  }, [two, right, path, onNavigate])

  const setTwo = (on: boolean, from = pane.cur) => {
    rememberTwo(on)
    if (!on) setActive('left')
    onTwoPanes?.(on ? (right ?? from) : null)
  }

  /** Copy or move `paths` into `toDir`; asks first when names exist there. */
  const work = useBusy()
  const transfer = (mode: Mode, paths: string[], toDir: string, taken: Set<string>, done?: () => void) => {
    if (!paths.length || jobs.starting || jobs.running) return
    const run = (overwrite: boolean) =>
      jobs.start({ kind: mode === 'copy' ? 'fs-copy' : 'fs-move', paths, toDir, overwrite }).then((j) => {
        if (j) {
          setHint(null)
          done?.()
        }
        return j
      })
    const names = paths.map(baseName).filter((n) => taken.has(n))
    if (names.length) setDialog({ kind: 'overwrite', names, toDir, run: () => run(true) })
    else void work.run(mode, () => run(false))
  }
  /** Two panes: the active pane's selection into the other pane's folder. */
  const across = (mode: Mode) => transfer(mode, pane.selPaths, target.cur, target.names, () => pane.setSelected(new Set()))
  const sameFolder = two && pane.cur === target.cur

  /** "Copy to …"/"Move to …": with one pane, open the second one as the target. */
  const sendTo = (mode: Mode, s: Side, name: string) => {
    setActive(s)
    panes[s].setSelected(new Set([name]))
    if (two) {
      const t = panes[other(s)]
      if (t.cur !== panes[s].cur) transfer(mode, [joinPath(panes[s].cur, name)], t.cur, t.names, () => panes[s].setSelected(new Set()))
      else setHint(mode)
    } else {
      setTwo(true, panes[s].cur)
      setHint(mode)
    }
  }

  const paste = (overwrite: boolean) => {
    if (!clip) return Promise.resolve(null)
    return jobs.start({ kind: clip.mode === 'copy' ? 'fs-copy' : 'fs-move', paths: clip.paths, toDir: pane.cur, overwrite }).then((job) => {
      if (job && clip.mode === 'cut') setClip(null)
      return job
    })
  }
  const pasting = useBusy()
  const startPaste = () => {
    if (!clip || jobs.starting) return
    const names = clip.paths.map(baseName).filter((n) => pane.names.has(n))
    if (names.length) setDialog({ kind: 'overwrite', names, toDir: pane.cur, run: () => paste(true) })
    else void pasting.run('paste', () => paste(false))
  }

  const renameSelected = () => {
    const name = [...pane.selected][0]
    const entry = pane.listing?.entries.find((x) => x.name === name)
    if (entry) setDialog({ kind: 'rename', entry })
  }
  const onKey = (e: React.KeyboardEvent) => {
    // typing in a field is not a shortcut (a ticked checkbox keeps the focus: F5 still copies)
    const el = e.target as HTMLElement
    const typing = (el instanceof HTMLInputElement && el.type !== 'checkbox' && el.type !== 'radio') || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'
    if (readonly || typing) return
    const mod = e.ctrlKey || e.metaKey
    const sel = pane.selected.size
    if (mod && e.key === 'c' && sel) setClip({ mode: 'copy', paths: pane.selPaths })
    else if (mod && e.key === 'x' && sel) setClip({ mode: 'cut', paths: pane.selPaths })
    else if (mod && e.key === 'v' && clip) startPaste()
    else if ((e.key === 'F5' || e.key === 'F6') && sel) {
      // F5 is also the browser's reload: inside the explorer it copies
      const mode = e.key === 'F5' ? 'copy' : 'move'
      if (two) {
        if (!sameFolder) across(mode)
      } else {
        setTwo(true)
        setHint(mode)
      }
    } else if (e.key === 'F5' || e.key === 'F6') {
      // nothing selected: still not a page reload
    } else if (e.key === 'F7') setDialog({ kind: 'mkdir' })
    else if ((e.key === 'Delete' || e.key === 'F8') && sel) setDialog({ kind: 'delete' })
    else if (e.key === 'F2' && sel === 1) renameSelected()
    else return
    e.preventDefault()
  }

  const busyJobs = !!jobs.running || jobs.starting

  const paneView = (s: Side) => {
    const p = panes[s]
    const isActive = !two || s === side
    const from = other(s)
    return (
      <PaneView
        key={s}
        pane={p}
        two={two}
        side={s}
        active={isActive}
        roots={roots}
        readonly={readonly}
        clip={clip}
        dropTarget={dropOn === s}
        onActivate={() => setActive(s)}
        onNavigate={(to) => go(to, s)}
        onOpenText={setOpen}
        onOpenRaw={(to, download) => void openRaw(to, download)}
        onSendTo={(mode, name) => sendTo(mode, s, name)}
        onUnpack={(path) => unpack(s, path)}
        onDragStart={(e, name) => {
          const names = p.selected.has(name) ? [...p.selected] : [name]
          if (!p.selected.has(name)) p.setSelected(new Set([name]))
          e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ side: s, paths: names.map((n) => joinPath(p.cur, n)) }))
          e.dataTransfer.effectAllowed = 'copyMove'
        }}
        onDragOver={(e) => {
          if (!two || readonly || !e.dataTransfer.types.includes(DRAG_TYPE) || panes[from].cur === p.cur) return
          e.preventDefault()
          e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy'
          setDropOn(s)
        }}
        onDragLeave={() => setDropOn(null)}
        onDrop={(e) => {
          setDropOn(null)
          const raw = e.dataTransfer.getData(DRAG_TYPE)
          if (!raw) return
          e.preventDefault()
          const d = JSON.parse(raw) as { side: Side; paths: string[] }
          if (d.side === s) return
          // dropped: copy; with Shift held: move
          transfer(e.shiftKey ? 'move' : 'copy', d.paths, p.cur, p.names, () => panes[d.side].setSelected(new Set()))
        }}
      />
    )
  }

  const toRight = side === 'left'
  const crossButtons = (
    <>
      <BusyButton
        className="btn primary sm justify-center"
        busy={work.is('copy')}
        busyLabel={m.common_starting()}
        disabled={!pane.selected.size || sameFolder || busyJobs}
        title={sameFolder ? m.files_two_sameFolder() : undefined}
        aria-label={toRight ? m.files_two_copyToRight() : m.files_two_copyToLeft()}
        onClick={() => across('copy')}
      >
        <span className="hidden lg:inline">{toRight ? m.files_two_copyRight() : m.files_two_copyLeft()}</span>
        <span className="lg:hidden">{toRight ? m.files_two_copyToRight() : m.files_two_copyToLeft()}</span>
      </BusyButton>
      <BusyButton
        className="btn sm justify-center"
        busy={work.is('move')}
        busyLabel={m.common_starting()}
        disabled={!pane.selected.size || sameFolder || busyJobs}
        title={sameFolder ? m.files_two_sameFolder() : undefined}
        aria-label={toRight ? m.files_two_moveToRight() : m.files_two_moveToLeft()}
        onClick={() => across('move')}
      >
        <span className="hidden lg:inline">{toRight ? m.files_two_moveRight() : m.files_two_moveLeft()}</span>
        <span className="lg:hidden">{toRight ? m.files_two_moveToRight() : m.files_two_moveToLeft()}</span>
      </BusyButton>
    </>
  )

  return (
    <div className={two ? 'flex flex-col gap-[18px]' : 'grid grid-cols-1 gap-[18px] lg:grid-cols-[240px_minmax(0,1fr)]'}>
      {!two && (
        <section className="panel flex flex-col self-start" aria-label={m.files_explorer_roots()}>
          <h2 className="h2 px-[18px] pt-4 pb-2">{m.files_explorer_roots()}</h2>
          {roots?.length === 0 && <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{m.files_explorer_noRoots()}</p>}
          {roots?.map((r) => (
            <button
              key={r.path}
              type="button"
              onClick={() => go(r.path)}
              className={`flex flex-col border-t border-line px-[18px] py-[9px] text-left hover:bg-[rgba(255,255,255,.03)] ${r.path === pane.root ? 'bg-[rgba(124,196,184,.10)]' : ''}`}
            >
              <span className="flex items-center gap-2 font-mono text-[13px]">
                <Glyph name="disk" size={14} />
                {r.label}
              </span>
              {r.size ? <span className="pl-[22px] text-[11px] text-muted">{m.files_explorer_freeOf({ free: diskSize(r.free ?? 0), size: diskSize(r.size) })}</span> : null}
            </button>
          ))}
        </section>
      )}

      <section className="panel flex min-w-0 flex-col" aria-label={m.files_explorer_folderContent()} onKeyDown={onKey}>
        <div className="flex flex-wrap items-center gap-2 px-[18px] pt-4 pb-2">
          {two ? (
            <span className="grow text-[13px] text-subtle">{pane.selected.size ? m.files_two_selection({ n: pane.selected.size, side: side === 'left' ? m.files_two_leftShort() : m.files_two_rightShort() }) : m.files_two_intro()}</span>
          ) : (
            <Crumbs pane={pane} onNavigate={(to) => go(to)} className="grow" />
          )}
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> {m.files_explorer_hidden()}
          </label>
          <select className="field !w-auto !py-1 text-[12px]" aria-label={m.files_explorer_sort()} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="name">{m.common_name()}</option>
            <option value="mtime">{m.files_explorer_modified()}</option>
            <option value="size">{m.common_size()}</option>
          </select>
          {onTwoPanes && (
            <label className="flex items-center gap-1.5 text-[12px] text-muted">
              <input type="checkbox" role="switch" checked={two} onChange={(e) => setTwo(e.target.checked)} /> {m.files_two_toggle()}
            </label>
          )}
        </div>

        {!readonly && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-[18px] py-2" role="toolbar" aria-label={m.common_actions()}>
            <button type="button" className="btn sm" disabled={pane.cur === pane.root} onClick={() => go(parentOf(pane.cur))} aria-label={m.files_explorer_up()}>
              ↑
            </button>
            <button type="button" className="btn sm" onClick={() => setDialog({ kind: 'mkdir' })}>
              <Glyph name="plus" size={13} /> {m.files_explorer_newFolder()}
            </button>
            <span className="mx-1 h-5 w-px bg-line" />
            <button type="button" className="btn sm" disabled={!pane.selected.size} onClick={() => setClip({ mode: 'copy', paths: pane.selPaths })}>
              {m.common_copy()}
            </button>
            <button type="button" className="btn sm" disabled={!pane.selected.size} onClick={() => setClip({ mode: 'cut', paths: pane.selPaths })}>
              {m.files_explorer_cut()}
            </button>
            <BusyButton className="btn sm" busy={pasting.is('paste')} busyLabel={m.common_starting()} disabled={!clip || busyJobs} onClick={startPaste}>
              {m.files_explorer_paste()}
              {clip ? ` (${clip.paths.length})` : ''}
            </BusyButton>
            <button type="button" className="btn sm" disabled={pane.selected.size !== 1} onClick={renameSelected}>
              {m.files_explorer_rename()}
            </button>
            <button type="button" className="btn sm" disabled={!pane.selected.size || busyJobs} onClick={() => setArchive({ kind: 'pack', dir: pane.cur, paths: pane.selPaths })}>
              {m.files_pack_button()}
            </button>
            <button type="button" className="btn sm danger" disabled={!pane.selected.size || busyJobs} onClick={() => setDialog({ kind: 'delete' })}>
              <Glyph name="trash" size={13} /> {m.common_delete()}
            </button>
            {clip && (
              <span className="ml-auto truncate text-[12px] text-muted" data-testid="clipboard">
                {clip.mode === 'copy' ? m.common_copied() : m.files_explorer_cutDone()}: {clip.paths.map(baseName).join(', ')}{' '}
                <button type="button" className="underline" onClick={() => setClip(null)}>
                  {m.files_explorer_clear()}
                </button>
              </span>
            )}
          </div>
        )}

        {(rootsError || (!two && pane.error)) && <p className="m-0 border-t border-line px-[18px] py-2 text-[13px] text-[#e3b341]">{rootsError || pane.error}</p>}
        {two && hint && (
          <p className="m-0 flex items-center gap-2 border-t border-line bg-[rgba(124,196,184,.06)] px-[18px] py-2 text-[13px] text-[#c9d1d9]" data-testid="two-hint">
            {hint === 'copy' ? m.files_two_hintCopy({ side: (side === 'left' ? m.files_two_rightShort() : m.files_two_leftShort()).toLowerCase() }) : m.files_two_hintMove({ side: (side === 'left' ? m.files_two_rightShort() : m.files_two_leftShort()).toLowerCase() })}
            <button type="button" className="ml-auto underline" onClick={() => setHint(null)}>
              {m.common_close()}
            </button>
          </p>
        )}

        {two ? (
          <div className="flex flex-col gap-3 border-t border-line p-3">
            {/* narrow screens: one pane at a time, picked with these tabs */}
            <div role="tablist" aria-label={m.files_two_toggle()} className="flex gap-1.5 lg:hidden">
              {(['left', 'right'] as const).map((s) => (
                <button key={s} type="button" role="tab" aria-selected={side === s} className={`seg grow justify-center ${side === s ? 'on' : ''}`} onClick={() => setActive(s)}>
                  {s === 'left' ? m.files_two_leftShort() : m.files_two_rightShort()}
                  <span className="truncate font-mono text-[11px] opacity-70">{baseName(panes[s].cur) || panes[s].cur}</span>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
              {paneView('left')}
              {!readonly && <div className="order-first flex flex-row gap-2 lg:order-none lg:flex-col lg:justify-center">{crossButtons}</div>}
              {paneView('right')}
            </div>
          </div>
        ) : (
          <PaneTable
            pane={pane}
            compact={false}
            side="left"
            readonly={readonly}
            clip={clip}
            canSend={!!onTwoPanes}
            onNavigate={(to) => go(to)}
            onOpenText={setOpen}
            onOpenRaw={(to, download) => void openRaw(to, download)}
            onSendTo={(mode, name) => sendTo(mode, 'left', name)}
            onUnpack={(path) => unpack('left', path)}
          />
        )}
        <div className={`border-t border-line px-[18px] py-2 text-[12px] text-muted ${two ? 'hidden sm:block' : ''}`}>
          {!two && m.files_explorer_count({ n: pane.entries.length })}
          {!two && (pane.selected.size ? m.files_explorer_selected({ n: pane.selected.size }) : '')}
          {!two && (pane.listing?.truncated ? m.files_explorer_truncated() : '')}
          {/* phones have no F keys */}
          {!readonly && <span className="hidden sm:inline">{two ? m.files_two_keys().replace(/^ · /, '') : m.files_explorer_keys()}</span>}
        </div>
      </section>

      {open && <TextFileEditor path={open} onClose={() => setOpen(null)} onSaved={() => void pane.load()} />}
      {archive?.kind === 'unpack' && <UnpackDialog archive={archive.archive} here={archive.here} other={archive.other} onClose={() => setArchive(null)} />}
      {archive?.kind === 'pack' && <PackDialog dir={archive.dir} paths={archive.paths} onClose={() => setArchive(null)} />}
      <NameDialog
        open={dialog?.kind === 'mkdir' || dialog?.kind === 'rename'}
        title={dialog?.kind === 'rename' ? m.files_explorer_renameTitle({ name: dialog.entry.name }) : m.files_explorer_newFolder()}
        initial={dialog?.kind === 'rename' ? dialog.entry.name : ''}
        taken={pane.names}
        busyLabel={dialog?.kind === 'rename' ? m.common_saving() : m.common_creating()}
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          const body = dialog?.kind === 'rename' ? { rename: { path: joinPath(pane.cur, dialog.entry.name), name } } : { mkdir: joinPath(pane.cur, name) }
          try {
            const r = await guarded('/api/files', { body })
            if (!r) return
            setDialog(null)
            pane.setSelected(new Set())
            await Promise.all([pane.load(), two && target.cur === pane.cur ? target.load() : undefined])
            say(dialog?.kind === 'rename' ? m.files_explorer_renamed({ name }) : m.files_explorer_created({ name }))
          } catch (e) {
            say((e as Error).message, 'bad')
          }
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title={pane.selected.size === 1 ? m.files_explorer_deleteOne({ name: [...pane.selected][0]! }) : m.files_explorer_deleteMany({ n: pane.selected.size })}
        danger
        confirm={m.files_explorer_deleteConfirm()}
        body={
          <div className="flex flex-col gap-2">
            <p className="m-0">{m.files_explorer_deleteBody()}</p>
            <ul className="m-0 max-h-[160px] list-none overflow-y-auto p-0 font-mono text-[12px]">
              {pane.selPaths.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        }
        busyLabel={m.common_starting()}
        onConfirm={() => jobs.start({ kind: 'fs-delete', paths: pane.selPaths }).then((j) => j && pane.setSelected(new Set()))}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'overwrite'}
        title={m.files_explorer_existsTitle()}
        danger
        confirm={m.files_explorer_overwrite()}
        body={
          <p className="m-0">
            {m.files_explorer_existsBefore({ names: dialog?.kind === 'overwrite' ? dialog.names.join(', ') : '' })}
            <span className="font-mono">{dialog?.kind === 'overwrite' ? dialog.toDir : ''}</span>
            {m.files_explorer_existsAfter()}
          </p>
        }
        busyLabel={m.common_starting()}
        onConfirm={() => (dialog?.kind === 'overwrite' ? dialog.run() : undefined)}
        onClose={() => setDialog(null)}
      />
    </div>
  )
}

function Crumbs({ pane, onNavigate, className = '' }: { pane: Pane; onNavigate: (p: string) => void; className?: string }) {
  return (
    <nav aria-label={m.common_path()} className={`flex min-w-0 flex-wrap items-center gap-1 font-mono text-[13px] ${className}`}>
      <button type="button" className="hover:underline" onClick={() => onNavigate(pane.root)}>
        {pane.root || '…'}
      </button>
      {pane.crumbs.map((c, i) => (
        <span key={i} className="flex items-center gap-1">
          <span className="text-subtle">/</span>
          <button type="button" className="hover:underline" onClick={() => onNavigate(joinPath(pane.root, pane.crumbs.slice(0, i + 1).join('/')))}>
            {c}
          </button>
        </span>
      ))}
    </nav>
  )
}

/** One of the two panes: area picker, path, list, free space. Clicking or focusing it makes it the active one. */
function PaneView(props: {
  pane: Pane
  two: boolean
  side: Side
  active: boolean
  roots: FileRoot[] | null
  readonly: boolean
  clip: Clip | null
  dropTarget: boolean
  onActivate: () => void
  onNavigate: (p: string) => void
  onOpenText: (p: string) => void
  onOpenRaw: (p: string, download: boolean) => void
  onSendTo: (mode: Mode, name: string) => void
  onUnpack: (path: string) => void
  onDragStart: (e: React.DragEvent, name: string) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}) {
  const { pane, side, active } = props
  return (
    <section
      aria-label={side === 'left' ? m.files_two_left() : m.files_two_right()}
      data-active={active || undefined}
      data-testid="file-pane"
      className={`min-w-0 flex-col rounded-[10px] border transition-colors ${active ? 'flex border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]' : 'hidden border-edge lg:flex'} ${props.dropTarget ? 'bg-[rgba(124,196,184,.08)]' : ''}`}
      onMouseDown={props.onActivate}
      onFocusCapture={props.onActivate}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2.5 pb-1.5">
        <select className="field !w-auto !py-0.5 text-[12px]" aria-label={m.files_two_area()} value={pane.root} onChange={(e) => props.onNavigate(e.target.value)}>
          {props.roots?.map((r) => (
            <option key={r.path} value={r.path}>
              {r.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn sm !min-h-[24px] !px-2" disabled={pane.cur === pane.root} onClick={() => props.onNavigate(parentOf(pane.cur))} aria-label={m.files_explorer_up()}>
          ↑
        </button>
        <span className={`ml-auto rounded-[5px] px-1.5 py-0.5 font-mono text-[10px] ${active ? 'bg-[rgba(124,196,184,.18)] text-accent' : 'bg-[#1c2430] text-muted'}`}>{active ? m.files_two_source() : m.files_two_target()}</span>
      </div>
      <Crumbs pane={pane} onNavigate={props.onNavigate} className="px-3 pb-1.5 text-[12px]" />
      {pane.error && <p className="m-0 px-3 py-1 text-[12px] text-[#e3b341]">{pane.error}</p>}
      <PaneTable
        pane={pane}
        compact
        side={side}
        readonly={props.readonly}
        clip={props.clip}
        canSend
        onNavigate={props.onNavigate}
        onOpenText={props.onOpenText}
        onOpenRaw={props.onOpenRaw}
        onSendTo={props.onSendTo}
        onUnpack={props.onUnpack}
        onDragStart={props.onDragStart}
      />
      <div className="mt-auto flex justify-between gap-2 border-t border-line px-3 py-1.5 text-[11px] text-muted">
        <span>{pane.rootInfo?.size ? m.files_two_free({ free: diskSize(pane.rootInfo.free ?? 0) }) : ''}</span>
        <span>
          {m.files_explorer_count({ n: pane.entries.length })}
          {pane.selected.size ? m.files_explorer_selected({ n: pane.selected.size }) : ''}
          {pane.listing?.truncated ? m.files_explorer_truncated() : ''}
        </span>
      </div>
    </section>
  )
}

function PaneTable(props: {
  pane: Pane
  compact: boolean
  side: Side
  readonly: boolean
  clip: Clip | null
  canSend: boolean
  onNavigate: (p: string) => void
  onOpenText: (p: string) => void
  onOpenRaw: (p: string, download: boolean) => void
  onSendTo: (mode: Mode, name: string) => void
  onUnpack: (path: string) => void
  onDragStart?: (e: React.DragEvent, name: string) => void
}) {
  const { pane, compact, clip } = props
  const { entries, selected, cur } = pane
  const send = !props.readonly && props.canSend
  return (
    <div className="overflow-x-auto">
      <table className="tbl" aria-label={m.files_explorer_files()}>
        <thead>
          <tr>
            <th className="w-8">
              <input type="checkbox" aria-label={m.files_explorer_selectAll()} checked={!!entries.length && selected.size === entries.length} onChange={(e) => pane.setSelected(e.target.checked ? new Set(entries.map((x) => x.name)) : new Set())} />
            </th>
            <th>{m.common_name()}</th>
            <th className="hidden sm:table-cell">{m.common_size()}</th>
            {!compact && <th className="hidden md:table-cell">{m.files_explorer_modified()}</th>}
            {!compact && <th className="hidden lg:table-cell">{m.files_explorer_owner()}</th>}
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {pane.listing && entries.length === 0 && (
            <tr>
              <td colSpan={6} className="text-muted">
                {m.files_explorer_empty()}
              </td>
            </tr>
          )}
          {entries.map((e) => {
            const isDir = e.type === 'dir' || (e.type === 'link' && !!e.target && !e.target.startsWith('('))
            const path = joinPath(cur, e.name)
            const cut = clip?.mode === 'cut' && clip.paths.includes(path)
            const kind = fileKind(e.name)
            const items = [
              ...(e.type === 'file' && ['text', 'unknown'].includes(kind) ? [{ label: m.files_open_editor(), onSelect: () => props.onOpenText(path) }] : []),
              ...(e.type === 'file' && ['text', 'browser'].includes(kind) ? [{ label: m.files_open_tab(), onSelect: () => props.onOpenRaw(path, false) }] : []),
              ...(e.type === 'file' ? [{ label: m.files_open_download(), onSelect: () => props.onOpenRaw(path, true) }] : []),
              ...(e.type === 'file' && !props.readonly && archiveFormat(e.name) ? [{ label: m.files_menu_unpack(), onSelect: () => props.onUnpack(path), separator: true }] : []),
              ...(send ? [{ label: m.files_menu_copyTo(), onSelect: () => props.onSendTo('copy', e.name), separator: e.type === 'file' }, { label: m.files_menu_moveTo(), onSelect: () => props.onSendTo('move', e.name) }] : []),
            ]
            return (
              <tr
                key={e.name}
                data-testid="file-row"
                className={`${selected.has(e.name) ? 'bg-[rgba(124,196,184,.08)]' : ''} ${cut ? 'opacity-50' : ''}`}
                onDoubleClick={() => isDir && props.onNavigate(path)}
                draggable={!!props.onDragStart && !props.readonly}
                onDragStart={props.onDragStart ? (ev) => props.onDragStart!(ev, e.name) : undefined}
              >
                <td>
                  <input type="checkbox" aria-label={m.files_explorer_select({ name: e.name })} checked={selected.has(e.name)} onChange={() => pane.toggle(e.name)} />
                </td>
                <td className={compact ? 'max-w-[320px]' : 'max-w-[520px]'}>
                  <span className="flex items-center gap-2">
                    <span className={isDir ? 'text-accent' : 'text-muted'}>
                      <Glyph name={isDir ? 'folder' : 'file'} size={15} />
                    </span>
                    {isDir ? (
                      <button type="button" className="truncate text-left hover:underline" onClick={() => props.onNavigate(path)}>
                        {e.name}
                      </button>
                    ) : e.type === 'file' ? (
                      <button
                        type="button"
                        className="truncate text-left hover:underline"
                        onClick={() => {
                          if (kind === 'text' || kind === 'unknown') props.onOpenText(path)
                          else props.onOpenRaw(path, kind !== 'browser')
                        }}
                        aria-label={kind === 'browser' ? m.files_open_tabLabel({ name: e.name }) : kind === 'binary' ? m.files_open_downloadLabel({ name: e.name }) : m.files_editor_open({ name: e.name })}
                      >
                        {e.name}
                      </button>
                    ) : (
                      <span className="truncate">{e.name}</span>
                    )}
                    {e.type === 'link' && (
                      <span className="chip" title={e.target}>
                        → {e.target}
                      </span>
                    )}
                  </span>
                </td>
                <td className="hidden font-mono text-[12px] sm:table-cell">{e.type === 'file' ? bytes(e.size) : ''}</td>
                {!compact && (
                  <td className="hidden font-mono text-[12px] text-muted md:table-cell" suppressHydrationWarning>
                    {dateTime(e.mtime)}
                  </td>
                )}
                {!compact && (
                  <td className="hidden font-mono text-[12px] text-subtle lg:table-cell">
                    {e.owner}:{e.group} {e.mode}
                  </td>
                )}
                <td className="w-10 text-right">{items.length > 0 && <RowMenu label={m.files_open_actions({ name: e.name })} items={items} />}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function NameDialog({ open, title, initial, taken, busyLabel, onClose, onSubmit }: { open: boolean; title: string; initial: string; taken: Set<string>; busyLabel: string; onClose: () => void; onSubmit: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState(initial)
  const work = useBusy()
  const busy = work.busy !== null
  useEffect(() => setName(initial), [initial, open])
  const err = name && name !== initial ? (validateName(name) ?? (taken.has(name) ? m.files_explorer_exists({ name }) : undefined)) : undefined
  return (
    <Modal open={open} onClose={onClose} title={title} busy={busy}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (name && name !== initial && !err) void work.run('submit', () => onSubmit(name))
        }}
      >
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {m.common_name()}
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        {err && <p className="m-0 text-[13px] text-[#ff8a80]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {m.common_cancel()}
          </button>
          <BusyButton type="submit" className="btn primary" busy={busy} busyLabel={busyLabel} disabled={!name || name === initial || !!err}>
            {m.common_save()}
          </BusyButton>
        </div>
      </form>
    </Modal>
  )
}
