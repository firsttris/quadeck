import { useCallback, useEffect, useMemo, useState } from 'react'
import { bytes, diskSize } from '~/lib/format'
import { baseName, fileKind, isSensitivePath, joinPath, parentOf, validateName, type DirListing, type FileEntry, type FileRoot } from '~/shared/files'
import { useActions } from './Actions'
import { BusyButton, useBusy } from './Busy'
import { Glyph } from './Glyph'
import { useJobs } from './Jobs'
import { ConfirmDialog, Modal } from './Modal'
import { useToast } from './Toast'
import { TextFileEditor } from './TextFileEditor'
import { RowMenu } from './RowMenu'
import { useGuardedApi, useUnlock } from './Unlock'
import { localeOf } from '~/shared/i18n'
import { m } from '~/paraglide/messages'

type Clip = { mode: 'copy' | 'cut'; paths: string[] }
type Sort = 'name' | 'size' | 'mtime'

const dateFmt = (ts: number) => new Date(ts).toLocaleString(localeOf(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * A small file manager for the data areas: browse, new folder, rename,
 * copy/cut/paste and delete. Copy, move and delete run as jobs with live
 * output (they can take long on big folders).
 */
export function FileExplorer({ path, onNavigate }: { path?: string; onNavigate: (p: string) => void }) {
  const say = useToast()
  const jobs = useJobs()
  const guarded = useGuardedApi()
  const { readonly } = useActions()
  const [roots, setRoots] = useState<FileRoot[] | null>(null)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [clip, setClip] = useState<Clip | null>(null)
  const [hidden, setHidden] = useState(false)
  const [sort, setSort] = useState<Sort>('name')
  const [open, setOpen] = useState<string | null>(null)
  const unlock = useUnlock()

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
  const [dialog, setDialog] = useState<null | { kind: 'mkdir' } | { kind: 'rename'; entry: FileEntry } | { kind: 'delete' } | { kind: 'overwrite'; names: string[] }>(null)

  useEffect(() => {
    fetch('/api/files')
      .then((r) => r.json())
      .then((d: { roots?: FileRoot[]; error?: string }) => {
        if (!d.roots) throw new Error(d.error ?? m.common_error())
        setRoots(d.roots)
        if (!path && d.roots[0]) onNavigate(d.roots[0].path)
      })
      .catch((e: Error) => setError(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    if (jobs.finished) void load()
  }, [jobs.finished, load])

  const entries = useMemo(() => {
    const list = (listing?.entries ?? []).filter((e) => hidden || !e.name.startsWith('.'))
    const dirFirst = (a: FileEntry, b: FileEntry) => Number(b.type === 'dir') - Number(a.type === 'dir')
    return list.sort((a, b) => dirFirst(a, b) || (sort === 'size' ? b.size - a.size : sort === 'mtime' ? b.mtime - a.mtime : a.name.localeCompare(b.name, localeOf(), { numeric: true })))
  }, [listing, hidden, sort])

  const cur = listing?.path ?? path ?? ''
  const root = listing?.root ?? roots?.find((r) => cur === r.path || cur.startsWith(r.path + '/'))?.path ?? ''
  const crumbs = cur.slice(root.length).split('/').filter(Boolean)
  const selPaths = [...selected].map((n) => joinPath(cur, n))

  const toggle = (name: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(name)) n.delete(name)
      else n.add(name)
      return n
    })

  const paste = async (overwrite: boolean) => {
    if (!clip) return
    const job = await jobs.start({ kind: clip.mode === 'copy' ? 'fs-copy' : 'fs-move', paths: clip.paths, toDir: cur, overwrite })
    if (job && clip.mode === 'cut') setClip(null)
  }

  const pasting = useBusy()
  const startPaste = () => {
    if (!clip || jobs.starting) return
    const here = new Set(listing?.entries.map((e) => e.name))
    const names = clip.paths.map(baseName).filter((n) => here.has(n))
    if (names.length) setDialog({ kind: 'overwrite', names })
    else void pasting.run('paste', () => paste(false))
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (readonly || (e.target as HTMLElement).tagName === 'INPUT') return
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key === 'c' && selected.size) setClip({ mode: 'copy', paths: selPaths })
    else if (mod && e.key === 'x' && selected.size) setClip({ mode: 'cut', paths: selPaths })
    else if (mod && e.key === 'v' && clip) startPaste()
    else if (e.key === 'Delete' && selected.size) setDialog({ kind: 'delete' })
    else if (e.key === 'F2' && selected.size === 1) setDialog({ kind: 'rename', entry: listing!.entries.find((x) => x.name === [...selected][0])! })
    else return
    e.preventDefault()
  }

  return (
    <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-[240px_minmax(0,1fr)]">
      <section className="panel flex flex-col self-start" aria-label={m.files_explorer_roots()}>
        <h2 className="h2 px-[18px] pt-4 pb-2">{m.files_explorer_roots()}</h2>
        {roots?.length === 0 && <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{m.files_explorer_noRoots()}</p>}
        {roots?.map((r) => (
          <button
            key={r.path}
            type="button"
            onClick={() => onNavigate(r.path)}
            className={`flex flex-col border-t border-line px-[18px] py-[9px] text-left hover:bg-[rgba(255,255,255,.03)] ${r.path === root ? 'bg-[rgba(124,196,184,.10)]' : ''}`}
          >
            <span className="flex items-center gap-2 font-mono text-[13px]">
              <Glyph name="disk" size={14} />
              {r.label}
            </span>
            {r.size ? <span className="pl-[22px] text-[11px] text-muted">{m.files_explorer_freeOf({ free: diskSize(r.free ?? 0), size: diskSize(r.size) })}</span> : null}
          </button>
        ))}
      </section>

      <section className="panel flex min-w-0 flex-col" aria-label={m.files_explorer_folderContent()} onKeyDown={onKey}>
        <div className="flex flex-wrap items-center gap-2 px-[18px] pt-4 pb-2">
          <nav aria-label={m.common_path()} className="flex min-w-0 grow flex-wrap items-center gap-1 font-mono text-[13px]">
            <button type="button" className="hover:underline" onClick={() => onNavigate(root)}>
              {root || '…'}
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-subtle">/</span>
                <button type="button" className="hover:underline" onClick={() => onNavigate(joinPath(root, crumbs.slice(0, i + 1).join('/')))}>
                  {c}
                </button>
              </span>
            ))}
          </nav>
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> {m.files_explorer_hidden()}
          </label>
          <select className="field !w-auto !py-1 text-[12px]" aria-label={m.files_explorer_sort()} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="name">{m.common_name()}</option>
            <option value="mtime">{m.files_explorer_modified()}</option>
            <option value="size">{m.common_size()}</option>
          </select>
        </div>

        {!readonly && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-[18px] py-2" role="toolbar" aria-label={m.common_actions()}>
            <button type="button" className="btn sm" disabled={cur === root} onClick={() => onNavigate(parentOf(cur))} aria-label={m.files_explorer_up()}>
              ↑
            </button>
            <button type="button" className="btn sm" onClick={() => setDialog({ kind: 'mkdir' })}>
              <Glyph name="plus" size={13} /> {m.files_explorer_newFolder()}
            </button>
            <span className="mx-1 h-5 w-px bg-line" />
            <button type="button" className="btn sm" disabled={!selected.size} onClick={() => setClip({ mode: 'copy', paths: selPaths })}>
              {m.common_copy()}
            </button>
            <button type="button" className="btn sm" disabled={!selected.size} onClick={() => setClip({ mode: 'cut', paths: selPaths })}>
              {m.files_explorer_cut()}
            </button>
            <BusyButton className="btn sm" busy={pasting.is('paste')} busyLabel={m.common_starting()} disabled={!clip || !!jobs.running || jobs.starting} onClick={startPaste}>
              {m.files_explorer_paste()}
              {clip ? ` (${clip.paths.length})` : ''}
            </BusyButton>
            <button type="button" className="btn sm" disabled={selected.size !== 1} onClick={() => setDialog({ kind: 'rename', entry: listing!.entries.find((x) => x.name === [...selected][0])! })}>
              {m.files_explorer_rename()}
            </button>
            <button type="button" className="btn sm danger" disabled={!selected.size || !!jobs.running || jobs.starting} onClick={() => setDialog({ kind: 'delete' })}>
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

        {error && <p className="m-0 border-t border-line px-[18px] py-2 text-[13px] text-[#e3b341]">{error}</p>}
        <div className="overflow-x-auto">
          <table className="tbl" aria-label={m.files_explorer_files()}>
            <thead>
              <tr>
                <th className="w-8">
                  <input type="checkbox" aria-label={m.files_explorer_selectAll()} checked={!!entries.length && selected.size === entries.length} onChange={(e) => setSelected(e.target.checked ? new Set(entries.map((x) => x.name)) : new Set())} />
                </th>
                <th>{m.common_name()}</th>
                <th className="hidden sm:table-cell">{m.common_size()}</th>
                <th className="hidden md:table-cell">{m.files_explorer_modified()}</th>
                <th className="hidden lg:table-cell">{m.files_explorer_owner()}</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {listing && entries.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-muted">
                    {m.files_explorer_empty()}
                  </td>
                </tr>
              )}
              {entries.map((e) => {
                const isDir = e.type === 'dir' || (e.type === 'link' && !!e.target && !e.target.startsWith('('))
                const cut = clip?.mode === 'cut' && clip.paths.includes(joinPath(cur, e.name))
                return (
                  <tr key={e.name} data-testid="file-row" className={`${selected.has(e.name) ? 'bg-[rgba(124,196,184,.08)]' : ''} ${cut ? 'opacity-50' : ''}`} onDoubleClick={() => isDir && onNavigate(joinPath(cur, e.name))}>
                    <td>
                      <input type="checkbox" aria-label={m.files_explorer_select({ name: e.name })} checked={selected.has(e.name)} onChange={() => toggle(e.name)} />
                    </td>
                    <td className="max-w-[520px]">
                      <span className="flex items-center gap-2">
                        <span className={isDir ? 'text-accent' : 'text-muted'}>
                          <Glyph name={isDir ? 'folder' : 'file'} size={15} />
                        </span>
                        {isDir ? (
                          <button type="button" className="truncate text-left hover:underline" onClick={() => onNavigate(joinPath(cur, e.name))}>
                            {e.name}
                          </button>
                        ) : e.type === 'file' ? (
                          <button
                            type="button"
                            className="truncate text-left hover:underline"
                            onClick={() => {
                              const p = joinPath(cur, e.name)
                              const k = fileKind(e.name)
                              if (k === 'text' || k === 'unknown') setOpen(p)
                              else void openRaw(p, k !== 'browser')
                            }}
                            aria-label={fileKind(e.name) === 'browser' ? m.files_open_tabLabel({ name: e.name }) : fileKind(e.name) === 'binary' ? m.files_open_downloadLabel({ name: e.name }) : m.files_editor_open({ name: e.name })}
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
                    <td className="hidden font-mono text-[12px] text-muted md:table-cell" suppressHydrationWarning>
                      {dateFmt(e.mtime)}
                    </td>
                    <td className="hidden font-mono text-[12px] text-subtle lg:table-cell">
                      {e.owner}:{e.group} {e.mode}
                    </td>
                    <td className="w-10 text-right">
                      {e.type === 'file' && (
                        <RowMenu
                          label={m.files_open_actions({ name: e.name })}
                          items={[
                            ...(['text', 'unknown'].includes(fileKind(e.name)) ? [{ label: m.files_open_editor(), onSelect: () => setOpen(joinPath(cur, e.name)) }] : []),
                            ...(['text', 'browser'].includes(fileKind(e.name)) ? [{ label: m.files_open_tab(), onSelect: () => void openRaw(joinPath(cur, e.name), false) }] : []),
                            { label: m.files_open_download(), onSelect: () => void openRaw(joinPath(cur, e.name), true) },
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
        <div className="border-t border-line px-[18px] py-2 text-[12px] text-muted">
          {m.files_explorer_count({ n: entries.length })}
          {selected.size ? m.files_explorer_selected({ n: selected.size }) : ''}
          {listing?.truncated ? m.files_explorer_truncated() : ''}
          {!readonly && m.files_explorer_keys()}
        </div>
      </section>

      {open && <TextFileEditor path={open} onClose={() => setOpen(null)} onSaved={() => void load()} />}
      <NameDialog
        open={dialog?.kind === 'mkdir' || dialog?.kind === 'rename'}
        title={dialog?.kind === 'rename' ? m.files_explorer_renameTitle({ name: dialog.entry.name }) : m.files_explorer_newFolder()}
        initial={dialog?.kind === 'rename' ? dialog.entry.name : ''}
        taken={new Set(listing?.entries.map((e) => e.name))}
        busyLabel={dialog?.kind === 'rename' ? m.common_saving() : m.common_creating()}
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          const body = dialog?.kind === 'rename' ? { rename: { path: joinPath(cur, dialog.entry.name), name } } : { mkdir: joinPath(cur, name) }
          try {
            const r = await guarded('/api/files', { body })
            if (!r) return
            setDialog(null)
            setSelected(new Set())
            await load()
            say(dialog?.kind === 'rename' ? m.files_explorer_renamed({ name }) : m.files_explorer_created({ name }))
          } catch (e) {
            say((e as Error).message, 'bad')
          }
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title={selected.size === 1 ? m.files_explorer_deleteOne({ name: ([...selected][0]!) }) : m.files_explorer_deleteMany({ n: selected.size })}
        danger
        confirm={m.files_explorer_deleteConfirm()}
        body={
          <div className="flex flex-col gap-2">
            <p className="m-0">{m.files_explorer_deleteBody()}</p>
            <ul className="m-0 max-h-[160px] list-none overflow-y-auto p-0 font-mono text-[12px]">
              {[...selected].map((n) => (
                <li key={n}>{joinPath(cur, n)}</li>
              ))}
            </ul>
          </div>
        }
        busyLabel={m.common_starting()}
        onConfirm={() => jobs.start({ kind: 'fs-delete', paths: selPaths }).then((j) => j && setSelected(new Set()))}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'overwrite'}
        title={m.files_explorer_existsTitle()}
        danger
        confirm={m.files_explorer_overwrite()}
        body={
          <p className="m-0">
            {m.files_explorer_existsBefore({ names: (dialog?.kind === 'overwrite' ? dialog.names.join(', ') : '') })}
            <span className="font-mono">{cur}</span>
            {m.files_explorer_existsAfter()}
          </p>
        }
        busyLabel={m.common_starting()}
        onConfirm={() => paste(true)}
        onClose={() => setDialog(null)}
      />
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
