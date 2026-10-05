// File explorer: unpack an archive (with a checked preview) and pack a selection.

import { useCallback, useEffect, useRef, useState } from 'react'
import { bytes, diskSize } from '~/lib/format'
import { archiveStem, extractBlocked, packName, PACK_FORMATS, type ArchivePreview, type PackFormat } from '~/shared/archives'
import { baseName, joinPath, validateName } from '~/shared/files'
import { BusyButton, Spinner, useBusy } from './Busy'
import { InstallHint } from './InstallHint'
import { useJobs } from './Jobs'
import { Modal } from './Modal'
import { useUnlock } from './Unlock'
import { m } from '~/paraglide/messages'

type Target = 'new' | 'here' | 'other'

const reasonText = (r: ArchivePreview['problems'][number]) =>
  r.reason === 'absolute' ? m.files_unpack_why_absolute() : r.reason === 'parent' ? m.files_unpack_why_parent() : r.reason === 'linkOutside' ? m.files_unpack_why_link({ target: r.target ?? '?' }) : r.reason === 'special' ? m.files_unpack_why_special() : m.files_unpack_why_device()

/** Unpack `archive`: into a new folder (default), here, or the other pane's folder. */
export function UnpackDialog({ archive, here, other, onClose }: { archive: string; here: string; other?: string; onClose: () => void }) {
  const jobs = useJobs()
  // in a ref: the context object changes on every unlock render, the preview shouldn't reload then
  const u = useUnlock()
  const unlock = useRef(u)
  unlock.current = u
  const work = useBusy()
  const [target, setTarget] = useState<Target>('new')
  const [name, setName] = useState(archiveStem(baseName(archive)))
  const [overwrite, setOverwrite] = useState(false)
  const [preview, setPreview] = useState<ArchivePreview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const nameError = target === 'new' ? validateName(name) : undefined
  const toDir = target === 'new' ? joinPath(here, name) : target === 'other' && other ? other : here

  const load = useCallback(async () => {
    if (nameError) return
    setLoading(true)
    try {
      const url = `/api/files?archive=${encodeURIComponent(archive)}&toDir=${encodeURIComponent(toDir)}`
      let r = await fetch(url)
      // keys and secrets: only after the unlock
      if (r.status === 423 && (await unlock.current.ensure())) r = await fetch(url)
      const d = (await r.json()) as ArchivePreview & { error?: string }
      if (!r.ok) throw new Error(d.error ?? m.common_http({ status: r.status }))
      setPreview(d)
      setError('')
    } catch (e) {
      setPreview(null)
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [archive, toDir, nameError])
  useEffect(() => {
    const t = setTimeout(() => void load(), 250) // typing a folder name
    return () => clearTimeout(t)
  }, [load])

  const p = preview
  const blocked = !p || extractBlocked(p, overwrite) || !!nameError || loading
  const ok = (good: boolean, text: string) => (
    <li className="flex items-start gap-2">
      <span className={good ? 'text-[#3fb950]' : 'text-[#f85149]'} aria-hidden="true">
        {good ? '✓' : '✗'}
      </span>
      <span>{text}</span>
    </li>
  )
  const targetButton = (t: Target, label: string) => (
    <button type="button" className={`btn sm ${target === t ? 'primary' : ''}`} aria-pressed={target === t} onClick={() => setTarget(t)} disabled={work.busy !== null}>
      {label}
    </button>
  )

  return (
    <Modal open title={m.files_unpack_title({ name: baseName(archive) })} onClose={onClose} busy={work.busy !== null} wide>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={m.files_unpack_target()}>
        {targetButton('new', m.files_unpack_newFolder())}
        {targetButton('here', m.files_unpack_here())}
        {other && other !== here && targetButton('other', m.files_unpack_other())}
      </div>
      {target === 'new' && (
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {m.files_unpack_folderName()}
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} disabled={work.busy !== null} />
          {nameError && <span className="text-[13px] text-[#ff8a80]">{nameError}</span>}
        </label>
      )}
      <p className="m-0 font-mono text-[12px] text-subtle" data-testid="unpack-target">
        → {toDir}
        {p?.create ? ` ${m.files_unpack_created()}` : ''}
      </p>

      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!p && !error && (
        <p className="m-0 flex items-center gap-2 text-[13px] text-muted">
          <Spinner /> {m.files_unpack_reading()}
        </p>
      )}
      {p?.missing && <InstallHint feature="zip" what={m.files_archive_needsUnzip()} onInstalled={() => void load()} />}

      {p && !p.missing && (
        <>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                [m.files_unpack_files(), String(p.files)],
                [m.files_unpack_size(), bytes(p.size)],
                [m.files_unpack_free(), p.free !== undefined ? diskSize(p.free) : '–'],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex flex-col rounded-[10px] border border-edge p-2.5">
                <span className="label-caps">{label}</span>
                <span className="text-[17px] font-semibold">{value}</span>
              </div>
            ))}
          </div>
          {p.problems.length > 0 ? (
            <div className="flex flex-col gap-1.5 rounded-[10px] border border-[#5b2a2a] bg-[#f85149]/[0.06] p-3 text-[13px]" role="alert" data-testid="unpack-problems">
              <b className="text-[#f85149]">{m.files_unpack_refused()}</b>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {p.problems.map((x) => (
                  <li key={x.path}>
                    <code className="font-mono text-[12px]">{x.path}</code> – {reasonText(x)}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]" aria-label={m.files_unpack_checks()}>
              {ok(true, m.files_unpack_check_paths())}
              {ok(!p.linkInTarget, p.linkInTarget ? m.files_archive_linkInTarget({ path: p.linkInTarget }) : m.files_unpack_check_links())}
              {ok(p.free === undefined || p.size <= p.free, p.free !== undefined && p.size > p.free ? m.files_archive_noSpace() : m.files_unpack_check_space({ size: bytes(p.size), free: p.free !== undefined ? diskSize(p.free) : '?' }))}
              {ok(true, m.files_unpack_check_roots())}
            </ul>
          )}
          {p.sample.length > 0 && (
            <ul className="m-0 max-h-32 list-none overflow-y-auto rounded-[8px] border border-edge p-2 font-mono text-[12px] text-subtle" aria-label={m.files_unpack_content()}>
              {p.sample.map((s) => (
                <li key={s}>{s}</li>
              ))}
              {p.files + p.dirs > p.sample.length && <li>{m.files_unpack_more({ n: p.files + p.dirs - p.sample.length })}</li>}
            </ul>
          )}
          {p.conflicts.length > 0 && !p.problems.length && (
            <label className="flex items-start gap-2 text-[13px]">
              <input type="checkbox" className="mt-0.5" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} disabled={work.busy !== null} />
              <span>
                {m.files_unpack_overwrite()}
                <span className="block text-[12px] text-muted">{m.files_archive_conflicts({ names: p.conflicts.slice(0, 8).join(', ') })}</span>
              </span>
            </label>
          )}
        </>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn" disabled={work.busy !== null} onClick={onClose}>
          {m.common_cancel()}
        </button>
        <BusyButton
          className="btn primary"
          busy={work.is('run')}
          busyLabel={m.common_starting()}
          disabled={blocked || !!jobs.running || jobs.starting}
          onClick={() =>
            void work.run('run', async () => {
              if (await jobs.start({ kind: 'fs-extract', archive, toDir, overwrite })) onClose()
            })
          }
        >
          {m.files_unpack_run()}
        </BusyButton>
      </div>
    </Modal>
  )
}

/** Pack the selection of one folder as .zip or .tar.gz next to it. */
export function PackDialog({ dir, paths, onClose }: { dir: string; paths: string[]; onClose: () => void }) {
  const jobs = useJobs()
  const work = useBusy()
  const [format, setFormat] = useState<PackFormat>('zip')
  const [name, setName] = useState(paths.length === 1 ? baseName(paths[0]!) : baseName(dir) || m.files_archive_defaultName())
  const [zip, setZip] = useState<boolean | null>(null)
  const checkTools = useCallback(() => {
    fetch('/api/files?tools')
      .then((r) => r.json())
      .then((d: { zip?: boolean }) => setZip(d.zip !== false))
      .catch(() => setZip(true))
  }, [])
  useEffect(checkTools, [checkTools])
  const file = packName(name.trim(), format)
  const nameError = name.trim() ? validateName(file) : m.files_pack_nameMissing()
  const needsZip = format === 'zip' && zip === false
  return (
    <Modal open title={paths.length === 1 ? m.files_pack_titleOne({ name: baseName(paths[0]!) }) : m.files_pack_titleMany({ n: paths.length })} onClose={onClose} busy={work.busy !== null}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex grow flex-col gap-1 text-[12px] font-medium text-muted">
          {m.common_name()}
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} disabled={work.busy !== null} autoFocus />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {m.files_pack_format()}
          <select className="field" value={format} onChange={(e) => setFormat(e.target.value as PackFormat)} disabled={work.busy !== null}>
            {PACK_FORMATS.map((f) => (
              <option key={f} value={f}>
                .{f}
              </option>
            ))}
          </select>
        </label>
      </div>
      {nameError ? <p className="m-0 text-[13px] text-[#ff8a80]">{nameError}</p> : <p className="m-0 font-mono text-[12px] text-subtle">→ {joinPath(dir, file)}</p>}
      <ul className="m-0 max-h-32 list-none overflow-y-auto rounded-[8px] border border-edge p-2 font-mono text-[12px] text-subtle" aria-label={m.files_unpack_content()}>
        {paths.map((p) => (
          <li key={p}>{baseName(p)}</li>
        ))}
      </ul>
      {needsZip && <InstallHint feature="zip" what={m.files_archive_needsZip()} onInstalled={checkTools} />}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" disabled={work.busy !== null} onClick={onClose}>
          {m.common_cancel()}
        </button>
        <BusyButton
          className="btn primary"
          busy={work.is('run')}
          busyLabel={m.common_starting()}
          disabled={!!nameError || needsZip || !!jobs.running || jobs.starting}
          onClick={() =>
            void work.run('run', async () => {
              if (await jobs.start({ kind: 'fs-pack', paths, format, name: name.trim() })) onClose()
            })
          }
        >
          {m.files_pack_run()}
        </BusyButton>
      </div>
    </Modal>
  )
}
