import { useEffect, useId, useState } from 'react'
import { api } from '~/lib/api'
import { localeOf } from '~/shared/i18n'
import { ENTRY_FILE, applyEntryForm, bootFileKinds, entryForm, explainParam, knownParams, parseEntryConf, splitOptions, type BootEntryFile, type BootState, type EntryForm, type EntryProblem } from '~/shared/boot'
import { Modal } from './Modal'
import { DiffView, TextView } from './QuadletEditor'
import { useGuardedApi } from './Unlock'
import { m } from '~/paraglide/messages'

const dateFmt = (ts: number) => new Date(ts).toLocaleString(localeOf(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export interface EntryEditorInit {
  /** create: a new file (also a copy); edit: the file in place. */
  kind: 'create' | 'edit'
  title: string
  name: string
  content: string
  /** loader/entries on the boot partition. */
  dir: string
  note?: string
  /** edit: the file as read (hash, history). */
  file?: BootEntryFile
}

/**
 * Editor for one systemd-boot entry: the text with a live check (files on the
 * boot partition, root=, typos), the changes as a diff before saving, and the
 * history of the file to load older versions from.
 */
export function BootEntryEditor({ init, onClose, onSaved }: { init: EntryEditorInit; onClose: () => void; onSaved: (id: string, state: BootState) => void }) {
  const guarded = useGuardedApi()
  const nameId = useId()
  const [name, setName] = useState(init.name)
  const [content, setContent] = useState(init.content)
  const [jump, setJump] = useState<number | null>(null)
  const [problems, setProblems] = useState<EntryProblem[] | null>(null)
  const [checkError, setCheckError] = useState('')
  const [note, setNote] = useState(init.note ?? '')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'form' | 'text'>('form')
  const [files, setFiles] = useState<string[] | null>(null)

  useEffect(() => {
    fetch('/api/boot?files')
      .then((r) => (r.ok ? (r.json() as Promise<{ files: string[] }>) : { files: [] }))
      .then((d) => setFiles(d.files))
      .catch(() => setFiles([]))
  }, [])

  useEffect(() => {
    setProblems(null)
    const t = setTimeout(async () => {
      try {
        const r = await api<{ problems: EntryProblem[] }>('/api/boot', { body: { check: content } })
        setProblems(r.problems)
        setCheckError('')
      } catch (e) {
        setCheckError((e as Error).message)
      }
    }, 350)
    return () => clearTimeout(t)
  }, [content])

  const nameOk = init.kind === 'edit' || ENTRY_FILE.test(name)
  const errors = problems?.filter((p) => p.level === 'error') ?? []
  const id = init.kind === 'edit' ? init.file!.id : name

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const entry = init.kind === 'create' ? { kind: 'create', name, content } : { kind: 'edit', id, content, expected: init.file!.hash }
      const s = await guarded<BootState>('/api/boot', { body: { entry } })
      if (s) onSaved(id, s)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const load = async (revision: string, date: number) => {
    try {
      const r = await fetch(`/api/boot?entry=${encodeURIComponent(init.file!.id)}&revision=${encodeURIComponent(revision)}`)
      const d = (await r.json()) as { content?: string; error?: string }
      if (!r.ok) throw new Error(d.error ?? m.common_http({ status: r.status }))
      setContent(d.content ?? '')
      setJump(null)
      setNote(m.boot_editor_loaded({ date: dateFmt(date) }))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (confirm)
    return (
      <Modal open wide title={init.kind === 'create' ? m.boot_editor_confirmNew({ id }) : m.boot_editor_confirmEdit({ id })} onClose={onClose}>
        <p className="m-0 font-mono text-[12px] text-muted">
          {init.dir}/{id}
        </p>
        <DiffView before={init.file?.content ?? ''} after={content.endsWith('\n') ? content : `${content}\n`} />
        <p className="m-0 text-[13px] text-muted">{m.boot_editor_confirmText()}</p>
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
            {init.kind === 'create' ? m.common_create() : m.common_save()}
          </button>
        </div>
      </Modal>
    )

  return (
    <Modal open wide title={init.title} onClose={onClose}>
      {note && <p className="m-0 text-[13px] text-[#e3b341]">{note}</p>}
      {init.kind === 'create' && (
        <label className="flex flex-col gap-1 text-[13px]" htmlFor={nameId}>
          <span className="text-muted">{m.boot_editor_fileName()}</span>
          <input id={nameId} className="field font-mono" value={name} spellCheck={false} onChange={(e) => setName(e.target.value.trim())} aria-invalid={!nameOk} />
          <span className={`text-[12px] ${nameOk ? 'text-muted' : 'text-[#ff8a80]'}`}>{nameOk ? m.boot_editor_fileHint({ dir: init.dir }) : m.boot_error_invalidFileName()}</span>
        </label>
      )}
      <div className="flex justify-end gap-1.5" role="group" aria-label={m.boot_form_view()}>
        <button type="button" className={`seg ${mode === 'form' ? 'on' : ''}`} aria-pressed={mode === 'form'} onClick={() => setMode('form')}>
          {m.quadlets_editor_form()}
        </button>
        <button type="button" className={`seg ${mode === 'text' ? 'on' : ''}`} aria-pressed={mode === 'text'} onClick={() => setMode('text')}>
          {m.quadlets_editor_text()}
        </button>
      </div>
      {mode === 'form' ? (
        <EntryFormView text={content} files={files} onChange={(v) => (setContent(v), setJump(null))} />
      ) : (
        <TextView text={content} onChange={(v) => (setContent(v), setJump(null))} jump={jump} label={m.boot_editor_content()} height={240} />
      )}
      <div className="flex flex-col gap-1 text-[13px]" aria-label={m.boot_editor_problems()} aria-live="polite">
        {checkError ? (
          <p className="m-0 text-[#ff8a80]">{checkError}</p>
        ) : problems === null ? (
          <p className="m-0 text-muted">{m.boot_editor_checking()}</p>
        ) : problems.length === 0 ? (
          <p className="m-0 text-[#7ee2a8]">{m.boot_editor_noProblems()}</p>
        ) : (
          problems.map((p, i) => (
            <p key={i} className={`m-0 ${p.level === 'error' ? 'text-[#ff8a80]' : 'text-[#e3b341]'}`} data-testid="entry-problem">
              {p.line ? (
                <button type="button" className="mr-1.5 border-0 bg-transparent p-0 font-mono text-inherit underline" onClick={() => (setMode('text'), setJump(p.line!))}>
                  {m.boot_check_line({ line: p.line })}
                </button>
              ) : null}
              {p.text}
            </p>
          ))
        )}
      </div>
      {init.file && init.file.history.length > 0 && (
        <details className="text-[12px] text-muted">
          <summary className="cursor-pointer">{m.boot_editor_history({ n: init.file.history.length })}</summary>
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
            {init.file.history.map((r) => (
              <li key={r.id} className="flex items-center gap-3">
                <span className="w-[140px] font-mono">{dateFmt(r.date)}</span>
                <span className="grow">{r.message}</span>
                <button type="button" className="border-0 bg-transparent p-0 text-accent hover:underline" onClick={() => void load(r.id, r.date)}>
                  {m.boot_editor_load()}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p role="alert" className="m-0 whitespace-pre-wrap text-[13px] text-[#ff8a80]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_cancel()}
        </button>
        <button type="button" className="btn primary" disabled={!nameOk || problems === null || errors.length > 0 || (init.kind === 'edit' && content === init.file!.content)} onClick={() => (setError(''), setConfirm(true))}>
          {m.boot_editor_next()}
        </button>
      </div>
    </Modal>
  )
}

/** New file name for an entry; bootctl follows a default or one-time entry. */
export function RenameEntry({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (to: string, state: BootState) => void }) {
  const guarded = useGuardedApi()
  const inputId = useId()
  const [name, setName] = useState(id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ok = ENTRY_FILE.test(name)
  return (
    <Modal open title={m.boot_editor_renameTitle({ id })} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!ok || name === id) return
          setBusy(true)
          setError('')
          try {
            const s = await guarded<BootState>('/api/boot', { body: { entry: { kind: 'rename', id, name } } })
            if (s) onDone(name, s)
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <label className="flex flex-col gap-1 text-[13px]" htmlFor={inputId}>
          <span className="text-muted">{m.boot_editor_fileName()}</span>
          <input id={inputId} className="field font-mono" value={name} spellCheck={false} autoFocus onChange={(e) => setName(e.target.value.trim())} aria-invalid={!ok} />
          {!ok && <span className="text-[12px] text-[#ff8a80]">{m.boot_error_invalidFileName()}</span>}
        </label>
        <p className="m-0 text-[13px] text-muted">{m.boot_editor_renameHint()}</p>
        {error && (
          <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {m.common_cancel()}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !ok || name === id}>
            {m.boot_editor_renameButton()}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Input that keeps what is typed (trailing spaces too) while the text it feeds is normalised. */
function DraftInput({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    if (value.trim() !== draft.trim()) setDraft(value)
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return <input {...rest} value={draft} onChange={(e) => (setDraft(e.target.value), onChange(e.target.value))} />
}

const fieldLabel = 'flex flex-col gap-1 text-[12px] font-medium text-muted'
const paramName = (token: string) => token.split('=')[0]!
const paramValue = (token: string) => (token.includes('=') ? token.slice(token.indexOf('=') + 1).replace(/^"|"$/g, '') : undefined)

/**
 * The entry as a form: title, kernel and initramfs from the files on the boot
 * partition, and every kernel parameter with what it does. It edits the same
 * text as the text view; lines it does not know stay untouched.
 */
function EntryFormView({ text, files, onChange }: { text: string; files: string[] | null; onChange: (t: string) => void }) {
  const f = entryForm(text)
  const set = (patch: Partial<EntryForm>) => onChange(applyEntryForm(text, { ...f, ...patch }))
  const kinds = bootFileKinds(files ?? [])
  const [newParam, setNewParam] = useState('')
  const listId = useId()

  const kernels = [...new Set([...kinds.kernels, ...(f.linux ? [f.linux] : [])])]
  const missing = (file: string) => files !== null && !files.includes(file)
  const pkgOf = (k: string) => /\/vmlinuz-(.+)$/.exec(k)?.[1]
  const changeKernel = (k: string) => {
    const from = pkgOf(f.linux)
    const to = pkgOf(k)
    const initrd = from && to ? f.initrd.map((i) => i.replace(new RegExp(`^/initramfs-${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-fallback)?\\.img$`), `/initramfs-${to}$1.img`)) : f.initrd
    set({ linux: k, initrd })
  }

  // Microcode first, then the rest in the order they are in now, then the ones not chosen yet.
  const initrdChoices = [...new Set([...f.initrd, ...kinds.microcode, ...kinds.initrds.filter((i) => !pkgOf(f.linux) || i.includes(`-${pkgOf(f.linux)}`))])]
  const isUcode = (i: string) => /ucode/.test(i)
  const toggleInitrd = (i: string, on: boolean) => {
    const chosen = initrdChoices.filter((x) => (x === i ? on : f.initrd.includes(x)))
    set({ initrd: [...chosen.filter(isUcode), ...chosen.filter((x) => !isUcode(x))] })
  }
  const initrdHelp = (i: string) => (isUcode(i) ? m.boot_form_microcode() : /fallback/.test(i) ? m.boot_form_fallback() : /initr/.test(i) ? m.boot_form_initramfs() : m.boot_form_otherInitrd())

  const others = [...new Set(parseEntryConf(text).map((l) => l.key))].filter((k) => !['title', 'linux', 'initrd', 'options'].includes(k))
  const addParam = () => {
    const t = newParam.trim()
    if (!t) return
    set({ options: [...f.options, ...splitOptions(t)] })
    setNewParam('')
  }
  const preview = newParam.trim() ? explainParam(paramName(newParam.trim()), paramValue(newParam.trim())) : undefined

  return (
    <div className="flex flex-col gap-4" data-testid="entry-form">
      <label className={fieldLabel}>
        {m.boot_form_title()}
        <DraftInput className="field" value={f.title} onChange={(v) => set({ title: v })} />
        <span className="font-normal">{m.boot_form_titleHelp()}</span>
      </label>

      <label className={fieldLabel}>
        {m.boot_form_kernel()}
        <select className="field font-mono" value={f.linux} onChange={(e) => changeKernel(e.target.value)}>
          {!f.linux && <option value="">–</option>}
          {kernels.map((k) => (
            <option key={k} value={k}>
              {missing(k) ? m.boot_form_missingFile({ file: k }) : k}
            </option>
          ))}
        </select>
        <span className="font-normal">{m.boot_form_kernelHelp()}</span>
      </label>

      <fieldset className="m-0 flex flex-col gap-2 rounded-[10px] border border-edge p-3">
        <legend className="px-1 text-[12px] font-medium text-muted">{m.boot_form_initrd()}</legend>
        <p className="m-0 text-[12px] text-muted">{m.boot_form_initrdHelp()}</p>
        {initrdChoices.map((i) => (
          <label key={i} className="flex items-start gap-2.5 text-[13px]">
            <input type="checkbox" className="mt-[3px]" checked={f.initrd.includes(i)} onChange={(e) => toggleInitrd(i, e.target.checked)} />
            <span className="flex flex-col">
              <span className="font-mono">{missing(i) ? m.boot_form_missingFile({ file: i }) : i}</span>
              <span className="text-[12px] text-muted">{initrdHelp(i)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-2 rounded-[10px] border border-edge p-3">
        <legend className="px-1 text-[12px] font-medium text-muted">{m.boot_form_params()}</legend>
        <p className="m-0 text-[12px] text-muted">{m.boot_form_paramsHelp()}</p>
        {f.options.map((o, i) => {
          const name = paramName(o)
          const text = explainParam(name, paramValue(o))
          return (
            <div key={`${i}-${name}`} className="flex items-start gap-2 border-t border-line pt-2 first-of-type:border-0" data-testid="entry-param">
              <div className="flex grow flex-col gap-1">
                <DraftInput
                  className="field !py-1 font-mono text-[13px]"
                  value={o}
                  spellCheck={false}
                  aria-label={m.boot_form_paramLabel({ param: name })}
                  onChange={(v) => set({ options: f.options.flatMap((x, j) => (j === i ? splitOptions(v) : [x])) })}
                />
                <span className={`text-[12px] ${text ? 'text-muted' : 'text-subtle'}`}>
                  {name === 'root' && <span className="chip q mr-1.5">{m.boot_form_required()}</span>}
                  {text ?? m.boot_form_paramUnknown()}
                </span>
              </div>
              <button type="button" className="btn sm" aria-label={m.boot_form_removeParam({ param: name })} onClick={() => set({ options: f.options.filter((_, j) => j !== i) })}>
                ✕
              </button>
            </div>
          )
        })}
        <div className="flex flex-col gap-1 border-t border-line pt-2">
          <div className="flex gap-2">
            <input
              className="field !py-1 grow font-mono text-[13px]"
              list={listId}
              value={newParam}
              spellCheck={false}
              placeholder={m.boot_form_addPlaceholder()}
              aria-label={m.boot_form_addParam()}
              onChange={(e) => setNewParam(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addParam()
                }
              }}
            />
            <button type="button" className="btn sm" disabled={!newParam.trim()} onClick={addParam}>
              {m.common_add()}
            </button>
          </div>
          {preview && <span className="text-[12px] text-muted">{preview}</span>}
          <datalist id={listId}>
            {knownParams().map((p) => (
              <option key={p} value={p}>
                {explainParam(p)}
              </option>
            ))}
          </datalist>
        </div>
      </fieldset>

      {others.length > 0 && <p className="m-0 text-[12px] text-muted">{m.boot_form_otherLines({ keys: others.join(', ') })}</p>}
    </div>
  )
}
