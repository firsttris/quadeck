import { useCallback, useEffect, useMemo, useState } from 'react'
import { bytes, diskSize } from '~/lib/format'
import { baseName, joinPath, parentOf, validateName, type DirListing, type FileEntry, type FileRoot } from '~/shared/files'
import { useActions } from './Actions'
import { Glyph } from './Glyph'
import { useJobs } from './Jobs'
import { ConfirmDialog, Modal } from './Modal'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'
import { useT } from '~/i18n'
import { localeOf } from '~/shared/i18n'

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
  const tt = useT()
  const t = tt.files.explorer
  const [roots, setRoots] = useState<FileRoot[] | null>(null)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [clip, setClip] = useState<Clip | null>(null)
  const [hidden, setHidden] = useState(false)
  const [sort, setSort] = useState<Sort>('name')
  const [dialog, setDialog] = useState<null | { kind: 'mkdir' } | { kind: 'rename'; entry: FileEntry } | { kind: 'delete' } | { kind: 'overwrite'; names: string[] }>(null)

  useEffect(() => {
    fetch('/api/files')
      .then((r) => r.json())
      .then((d: { roots?: FileRoot[]; error?: string }) => {
        if (!d.roots) throw new Error(d.error ?? tt.common.error)
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
      if (!r.ok) throw new Error(d.error ?? tt.common.http(r.status))
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

  const startPaste = () => {
    if (!clip) return
    const here = new Set(listing?.entries.map((e) => e.name))
    const names = clip.paths.map(baseName).filter((n) => here.has(n))
    if (names.length) setDialog({ kind: 'overwrite', names })
    else void paste(false)
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
      <section className="panel flex flex-col self-start" aria-label={t.roots}>
        <h2 className="h2 px-[18px] pt-4 pb-2">{t.roots}</h2>
        {roots?.length === 0 && <p className="m-0 border-t border-line px-[18px] py-3 text-[13px] text-muted">{t.noRoots}</p>}
        {roots?.map((r) => (
          <button key={r.path} type="button" onClick={() => onNavigate(r.path)} className={`flex flex-col border-t border-line px-[18px] py-[9px] text-left hover:bg-[rgba(255,255,255,.03)] ${r.path === root ? 'bg-[rgba(124,196,184,.10)]' : ''}`}>
            <span className="flex items-center gap-2 font-mono text-[13px]">
              <Glyph name="disk" size={14} />
              {r.label}
            </span>
            {r.size ? <span className="pl-[22px] text-[11px] text-muted">{t.freeOf(diskSize(r.free ?? 0), diskSize(r.size))}</span> : null}
          </button>
        ))}
      </section>

      <section className="panel flex min-w-0 flex-col" aria-label={t.folderContent} onKeyDown={onKey}>
        <div className="flex flex-wrap items-center gap-2 px-[18px] pt-4 pb-2">
          <nav aria-label={tt.common.path} className="flex min-w-0 grow flex-wrap items-center gap-1 font-mono text-[13px]">
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
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> {t.hidden}
          </label>
          <select className="field !w-auto !py-1 text-[12px]" aria-label={t.sort} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="name">{tt.common.name}</option>
            <option value="mtime">{t.modified}</option>
            <option value="size">{tt.common.size}</option>
          </select>
        </div>

        {!readonly && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-[18px] py-2" role="toolbar" aria-label={tt.common.actions}>
            <button type="button" className="btn sm" disabled={cur === root} onClick={() => onNavigate(parentOf(cur))} aria-label={t.up}>
              ↑
            </button>
            <button type="button" className="btn sm" onClick={() => setDialog({ kind: 'mkdir' })}>
              <Glyph name="plus" size={13} /> {t.newFolder}
            </button>
            <span className="mx-1 h-5 w-px bg-line" />
            <button type="button" className="btn sm" disabled={!selected.size} onClick={() => setClip({ mode: 'copy', paths: selPaths })}>
              {tt.common.copy}
            </button>
            <button type="button" className="btn sm" disabled={!selected.size} onClick={() => setClip({ mode: 'cut', paths: selPaths })}>
              {t.cut}
            </button>
            <button type="button" className="btn sm" disabled={!clip || !!jobs.running} onClick={startPaste}>
              {t.paste}
              {clip ? ` (${clip.paths.length})` : ''}
            </button>
            <button type="button" className="btn sm" disabled={selected.size !== 1} onClick={() => setDialog({ kind: 'rename', entry: listing!.entries.find((x) => x.name === [...selected][0])! })}>
              {t.rename}
            </button>
            <button type="button" className="btn sm danger" disabled={!selected.size || !!jobs.running} onClick={() => setDialog({ kind: 'delete' })}>
              <Glyph name="trash" size={13} /> {tt.common.delete}
            </button>
            {clip && (
              <span className="ml-auto truncate text-[12px] text-muted" data-testid="clipboard">
                {clip.mode === 'copy' ? tt.common.copied : t.cutDone}: {clip.paths.map(baseName).join(', ')}{' '}
                <button type="button" className="underline" onClick={() => setClip(null)}>
                  {t.clear}
                </button>
              </span>
            )}
          </div>
        )}

        {error && <p className="m-0 border-t border-line px-[18px] py-2 text-[13px] text-[#e3b341]">{error}</p>}
        <div className="overflow-x-auto">
          <table className="tbl" aria-label={t.files}>
            <thead>
              <tr>
                <th className="w-8">
                  <input
                    type="checkbox"
                    aria-label={t.selectAll}
                    checked={!!entries.length && selected.size === entries.length}
                    onChange={(e) => setSelected(e.target.checked ? new Set(entries.map((x) => x.name)) : new Set())}
                  />
                </th>
                <th>{tt.common.name}</th>
                <th className="hidden sm:table-cell">{tt.common.size}</th>
                <th className="hidden md:table-cell">{t.modified}</th>
                <th className="hidden lg:table-cell">{t.owner}</th>
              </tr>
            </thead>
            <tbody>
              {listing && entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-muted">
                    {t.empty}
                  </td>
                </tr>
              )}
              {entries.map((e) => {
                const isDir = e.type === 'dir' || (e.type === 'link' && !!e.target && !e.target.startsWith('('))
                const cut = clip?.mode === 'cut' && clip.paths.includes(joinPath(cur, e.name))
                return (
                  <tr key={e.name} data-testid="file-row" className={`${selected.has(e.name) ? 'bg-[rgba(124,196,184,.08)]' : ''} ${cut ? 'opacity-50' : ''}`} onDoubleClick={() => isDir && onNavigate(joinPath(cur, e.name))}>
                    <td>
                      <input type="checkbox" aria-label={t.select(e.name)} checked={selected.has(e.name)} onChange={() => toggle(e.name)} />
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
                        ) : (
                          <span className="truncate">{e.name}</span>
                        )}
                        {e.type === 'link' && <span className="chip" title={e.target}>→ {e.target}</span>}
                      </span>
                    </td>
                    <td className="hidden font-mono text-[12px] sm:table-cell">{e.type === 'file' ? bytes(e.size) : ''}</td>
                    <td className="hidden font-mono text-[12px] text-muted md:table-cell" suppressHydrationWarning>
                      {dateFmt(e.mtime)}
                    </td>
                    <td className="hidden font-mono text-[12px] text-subtle lg:table-cell">
                      {e.owner}:{e.group} {e.mode}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="border-t border-line px-[18px] py-2 text-[12px] text-muted">
          {t.count(entries.length)}
          {selected.size ? t.selected(selected.size) : ''}
          {listing?.truncated ? t.truncated : ''}
          {!readonly && t.keys}
        </div>
      </section>

      <NameDialog
        open={dialog?.kind === 'mkdir' || dialog?.kind === 'rename'}
        title={dialog?.kind === 'rename' ? t.renameTitle(dialog.entry.name) : t.newFolder}
        initial={dialog?.kind === 'rename' ? dialog.entry.name : ''}
        taken={new Set(listing?.entries.map((e) => e.name))}
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          const body = dialog?.kind === 'rename' ? { rename: { path: joinPath(cur, dialog.entry.name), name } } : { mkdir: joinPath(cur, name) }
          try {
            const r = await guarded('/api/files', { body })
            if (!r) return
            setDialog(null)
            setSelected(new Set())
            await load()
            say(dialog?.kind === 'rename' ? t.renamed(name) : t.created(name))
          } catch (e) {
            say((e as Error).message, 'bad')
          }
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title={selected.size === 1 ? t.deleteOne([...selected][0]!) : t.deleteMany(selected.size)}
        danger
        confirm={t.deleteConfirm}
        body={
          <div className="flex flex-col gap-2">
            <p className="m-0">{t.deleteBody}</p>
            <ul className="m-0 max-h-[160px] list-none overflow-y-auto p-0 font-mono text-[12px]">
              {[...selected].map((n) => (
                <li key={n}>{joinPath(cur, n)}</li>
              ))}
            </ul>
          </div>
        }
        onConfirm={() => {
          void jobs.start({ kind: 'fs-delete', paths: selPaths }).then((j) => j && setSelected(new Set()))
        }}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'overwrite'}
        title={t.existsTitle}
        danger
        confirm={t.overwrite}
        body={
          <p className="m-0">
            {t.existsBefore(dialog?.kind === 'overwrite' ? dialog.names.join(', ') : '')}
            <span className="font-mono">{cur}</span>
            {t.existsAfter}
          </p>
        }
        onConfirm={() => void paste(true)}
        onClose={() => setDialog(null)}
      />
    </div>
  )
}

function NameDialog({ open, title, initial, taken, onClose, onSubmit }: { open: boolean; title: string; initial: string; taken: Set<string>; onClose: () => void; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(initial)
  const tt = useT()
  useEffect(() => setName(initial), [initial, open])
  const err = name && name !== initial ? (validateName(name) ?? (taken.has(name) ? tt.files.explorer.exists(name) : undefined)) : undefined
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (name && name !== initial && !err) onSubmit(name)
        }}
      >
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {tt.common.name}
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        {err && <p className="m-0 text-[13px] text-[#ff8a80]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {tt.common.cancel}
          </button>
          <button type="submit" className="btn primary" disabled={!name || name === initial || !!err}>
            {tt.common.save}
          </button>
        </div>
      </form>
    </Modal>
  )
}
