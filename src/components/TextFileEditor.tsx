import { useEffect, useState } from 'react'
import { api, ApiError } from '~/lib/api'
import { bytes } from '~/lib/format'
import { baseName, type TextFile } from '~/shared/files'
import { localeOf } from '~/shared/i18n'
import { useActions } from './Actions'
import { ConfirmDialog, Modal } from './Modal'
import { DiffView, TextView } from './QuadletEditor'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'
import { m } from '~/paraglide/messages'

const dateFmt = (ts: number) => new Date(ts).toLocaleString(localeOf(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * A text file from the explorer in the editor: read as root, saved after the
 * unlock with a diff first. Keys and secrets are only shown after unlocking;
 * binary files and files over 2 MB are not opened.
 */
export function TextFileEditor({ path, onClose, onSaved }: { path: string; onClose: () => void; onSaved: () => void }) {
  const { readonly } = useActions()
  const guarded = useGuardedApi()
  const say = useToast()
  const [file, setFile] = useState<TextFile | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [busy, setBusy] = useState(false)
  const name = baseName(path)
  const url = `/api/files?read=${encodeURIComponent(path)}`

  useEffect(() => {
    let gone = false
    const show = (f: TextFile | undefined) => {
      if (gone) return
      if (!f) return onClose() // unlock cancelled
      setFile(f)
      setText(f.content)
    }
    api<TextFile>(url, { method: 'GET' })
      .then(show)
      .catch(async (e: Error) => {
        // Keys and secrets: ask for the unlock, then read again.
        if (e instanceof ApiError && e.status === 423) return show(await guarded<TextFile>(url, { method: 'GET' }))
        throw e
      })
      .catch((e: Error) => !gone && setError(e.message))
    return () => {
      gone = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  const dirty = !!file && text !== file.content
  const close = () => (dirty ? setDiscard(true) : onClose())

  const save = async () => {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const f = await guarded<TextFile>('/api/files', { body: { write: { path, content: text, expected: file.hash } } })
      if (!f) return
      setFile(f)
      setText(f.content)
      setConfirm(false)
      say(m.files_editor_saved({ name }))
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (confirm && file)
    return (
      <Modal open wide title={m.files_editor_confirmTitle({ name })} onClose={() => setConfirm(false)}>
        <p className="m-0 font-mono text-[12px] text-muted">{path}</p>
        <DiffView before={file.content} after={text} />
        <p className="m-0 text-[13px] text-muted">{m.files_editor_confirmText()}</p>
        {error && (
          <p role="alert" className="m-0 whitespace-pre-wrap text-[13px] text-[#ff8a80]">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => setConfirm(false)}>
            {m.common_back()}
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
            {m.common_save()}
          </button>
        </div>
      </Modal>
    )

  const canEdit = !readonly && !!file && !file.refused
  return (
    <>
      <Modal open wide title={name} onClose={close}>
        <p className="m-0 font-mono text-[12px] text-muted">{path}</p>
        {file && (
          <p className="m-0 flex flex-wrap items-center gap-2 text-[12px] text-muted">
            {m.files_editor_meta({ size: bytes(file.size), owner: file.owner, mode: file.mode, date: dateFmt(file.mtime) })}
            {file.crlf && <span className="chip">{m.files_editor_crlf()}</span>}
            {readonly && <span className="chip">{m.files_editor_readonly()}</span>}
          </p>
        )}
        {!file && !error && <p className="m-0 text-muted">{m.files_editor_loading()}</p>}
        {file?.refused && <p className="m-0 text-[13px] text-[#e3b341]">{file.refused === 'binary' ? m.files_editor_binary() : m.files_editor_tooLarge()}</p>}
        {file && !file.refused && <TextView text={text} onChange={setText} jump={null} readOnly={!canEdit} label={m.files_editor_content({ name })} height={460} />}
        {error && (
          <p role="alert" className="m-0 whitespace-pre-wrap text-[13px] text-[#ff8a80]">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={close}>
            {canEdit ? m.common_cancel() : m.common_close()}
          </button>
          {canEdit && (
            <button type="button" className="btn primary" disabled={!dirty} onClick={() => (setError(''), setConfirm(true))}>
              {m.files_editor_next()}
            </button>
          )}
        </div>
      </Modal>
      <ConfirmDialog open={discard} title={m.files_editor_unsaved()} body={<p className="m-0 font-mono text-[12px]">{path}</p>} confirm={m.common_close()} danger onConfirm={onClose} onClose={() => setDiscard(false)} />
    </>
  )
}
