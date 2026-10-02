import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '~/lib/api'
import { diffLines, hunks } from '~/lib/diff'
import { relative } from '~/lib/format'
import { getValues, lintQuadlet, parseIni, setValues } from '~/shared/ini'
import { QUADLET_KEYS, QUADLET_SECTION, SYSTEMD_KEYS, type KeyDoc } from '~/shared/quadlet-keys'
import { quadletType, quadletUnit, type Diagnostic, type Revision, type ValidateResult } from '~/shared/quadlets'
import { Glyph } from './Glyph'
import { ConfirmDialog, Modal } from './Modal'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'

export function DiffView({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => hunks(diffLines(before, after)), [before, after])
  if (!lines.length) return <p className="m-0 text-[13px] text-muted">Keine Änderungen.</p>
  return (
    <pre className="joblog !min-h-0" aria-label="Änderungen">
      {lines.map((l, i) =>
        l === null ? (
          <div key={i} className="text-subtle">
            ⋯
          </div>
        ) : (
          <div key={i} className={l.op === '+' ? 'bg-[rgba(63,185,80,.12)] text-[#7ee2a8]' : l.op === '-' ? 'bg-[rgba(248,81,73,.12)] text-[#ff8a80]' : 'text-muted'}>
            {l.op} {l.text || ' '}
          </div>
        ),
      )}
    </pre>
  )
}

export function Diagnostics({ items, onLine }: { items: Diagnostic[]; onLine?: (line: number) => void }) {
  if (!items.length) return null
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]" aria-label="Hinweise">
      {items.map((d, i) => (
        <li key={i} className={`flex items-start gap-2 ${d.severity === 'error' ? 'text-[#ff8a80]' : 'text-[#e3b341]'}`}>
          <span className="font-mono text-[11px] uppercase">{d.severity === 'error' ? 'Fehler' : 'Hinweis'}</span>
          {d.line && onLine ? (
            <button type="button" className="font-mono underline" onClick={() => onLine(d.line!)}>
              Zeile {d.line}
            </button>
          ) : d.line ? (
            <span className="font-mono">Zeile {d.line}</span>
          ) : null}
          <span className="text-[#c9d1d9]">{d.message}</span>
        </li>
      ))}
    </ul>
  )
}

function Field({ section, k, doc, text, onChange }: { section: string; k: string; doc: KeyDoc; text: string; onChange: (t: string) => void }) {
  const values = getValues(text, section, k)
  const set = (vals: string[]) => onChange(setValues(text, section, k, vals))
  const id = `f-${section}-${k}`
  const input = (value: string, onValue: (v: string) => void, label: string) =>
    doc.options ? (
      <select id={label === k ? id : undefined} aria-label={label} className="field font-mono" value={value} onChange={(e) => onValue(e.target.value)}>
        {[...new Set([...doc.options, value])].map((o) => (
          <option key={o} value={o}>
            {o || '–'}
          </option>
        ))}
      </select>
    ) : (
      <input id={label === k ? id : undefined} aria-label={label} className="field font-mono" value={value} placeholder={doc.placeholder} onChange={(e) => onValue(e.target.value)} />
    )
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={doc.multi ? undefined : id} className="flex items-baseline gap-2 text-[12px]">
        <span className="font-mono font-medium text-fg">{k}</span>
        <span className="text-muted">{doc.help}</span>
      </label>
      {doc.multi ? (
        <div className="flex flex-col gap-1.5">
          {values.map((v, i) => (
            <div key={i} className="flex gap-1.5">
              {input(v, (nv) => set(values.map((x, j) => (j === i ? nv : x))), `${k} ${i + 1}`)}
              <button type="button" className="btn sm" aria-label={`${k} ${i + 1} entfernen`} onClick={() => set(values.filter((_, j) => j !== i))}>
                <Glyph name="trash" size={13} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn sm self-start"
            onClick={() => set([...values, ''])}
          >
            <Glyph name="plus" size={13} /> {k} hinzufügen
          </button>
        </div>
      ) : (
        input(values.at(-1) ?? '', (v) => set(v ? [v] : []), k)
      )}
    </div>
  )
}

/** Form over the same text: only form keys are shown; everything else stays as it is. */
function FormView({ name, text, onChange }: { name: string; text: string; onChange: (t: string) => void }) {
  const main = QUADLET_SECTION[quadletType(name)]
  const sections: [string, Record<string, KeyDoc>][] = [[main, QUADLET_KEYS[main]!], ...Object.entries(SYSTEMD_KEYS)]
  const shown = new Set(sections.flatMap(([s, keys]) => Object.entries(keys).filter(([, d]) => d.form).map(([k]) => `${s}.${k}`)))
  const other = parseIni(text).filter((e) => e.kind === 'kv' && !shown.has(`${e.section}.${e.key}`))
  return (
    <div className="flex flex-col gap-5">
      {sections.map(([section, keys]) => (
        <fieldset key={section} className="m-0 grid grid-cols-1 gap-3 rounded-[10px] border border-edge p-4 2xl:grid-cols-2">
          <legend className="px-1 font-mono text-[13px] text-accent">[{section}]</legend>
          {Object.entries(keys)
            .filter(([, d]) => d.form)
            .map(([k, d]) => (
              <Field key={k} section={section} k={k} doc={d} text={text} onChange={onChange} />
            ))}
        </fieldset>
      ))}
      {other.length > 0 && (
        <p className="m-0 text-[12px] text-muted">
          Weitere Einträge bleiben unverändert (im Text bearbeiten): <span className="font-mono">{other.map((e) => `${e.key}`).join(', ')}</span>
        </p>
      )}
    </div>
  )
}

function TextView({ text, onChange, jump }: { text: string; onChange: (t: string) => void; jump: number | null }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const count = text.split('\n').length
  useEffect(() => {
    const ta = ref.current
    if (!ta || !jump) return
    const lines = ta.value.split('\n')
    const start = lines.slice(0, jump - 1).join('\n').length + (jump > 1 ? 1 : 0)
    ta.focus()
    ta.setSelectionRange(start, start + (lines[jump - 1]?.length ?? 0))
    ta.scrollTop = (jump - 4) * 19.5
  }, [jump])
  return (
    <div className="flex overflow-hidden rounded-[10px] border border-edge bg-[#0b0f14] font-mono text-[13px] leading-[19.5px]">
      <div ref={gutter} aria-hidden className="select-none overflow-hidden border-r border-line px-2 py-2.5 text-right text-subtle" style={{ height: 520 }}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={ref}
        aria-label="Quadlet-Datei"
        spellCheck={false}
        className="h-[520px] grow resize-none bg-transparent px-3 py-2.5 text-[#c9d1d9] outline-none"
        style={{ whiteSpace: 'pre', overflowWrap: 'normal' }}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop
        }}
      />
    </div>
  )
}

export interface EditorProps {
  name: string
  initial: string
  isNew: boolean
  history: Revision[]
  readonly: boolean
  onSaved: () => void
  onDeleted: () => void
}

export function QuadletEditor({ name, initial, isNew, history, readonly, onSaved, onDeleted }: EditorProps) {
  const say = useToast()
  const guarded = useGuardedApi()
  const [text, setText] = useState(initial)
  const [mode, setMode] = useState<'form' | 'text'>('form')
  const [server, setServer] = useState<ValidateResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [review, setReview] = useState(false)
  const [restart, setRestart] = useState(true)
  const [saving, setSaving] = useState(false)
  const [jump, setJump] = useState<number | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showGenerated, setShowGenerated] = useState(false)

  useEffect(() => {
    setText(initial)
    setServer(null)
  }, [initial, name])

  const type = quadletType(name)
  const local = useMemo(() => lintQuadlet(text, type), [text, type])
  const dirty = text !== initial || isNew
  const diags = server ? server.diagnostics : local

  const validate = async () => {
    setChecking(true)
    try {
      const r = await api<ValidateResult>('/api/quadlets/validate', { body: { name, content: text } })
      setServer(r)
      return r
    } catch (e) {
      say((e as Error).message, 'bad')
      return null
    } finally {
      setChecking(false)
    }
  }

  const startSave = async () => {
    const r = await validate()
    if (r?.ok) setReview(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      const r = await guarded<{ unit: string; restarted: boolean; warning?: string }>('/api/quadlets/file', { method: 'PUT', body: { name, content: text, restart } })
      if (!r) return
      setReview(false)
      if (r.warning) say(r.warning, 'bad')
      else say(`${name} gespeichert${r.restarted ? ` · ${r.unit} neu gestartet` : ' · daemon-reload'}`)
      onSaved()
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    try {
      const r = await guarded('/api/quadlets/file', { method: 'DELETE', body: { name } })
      if (!r) return
      say(`${name} gelöscht, ${quadletUnit(name)} gestoppt`)
      onDeleted()
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }

  return (
    <section className="panel flex min-w-0 flex-col gap-4 p-[18px]" aria-label={`Editor ${name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 grow">
          <h2 className="h2 truncate font-mono">{name}</h2>
          <div className="text-[12px] text-muted">
            {isNew ? 'neu – noch nicht gespeichert' : `erzeugt ${quadletUnit(name)}`}
            {dirty && !isNew && ' · ungespeicherte Änderungen'}
          </div>
        </div>
        <div role="group" aria-label="Ansicht" className="flex gap-1.5">
          <button type="button" className={`seg ${mode === 'form' ? 'on' : ''}`} aria-pressed={mode === 'form'} onClick={() => setMode('form')}>
            Formular
          </button>
          <button type="button" className={`seg ${mode === 'text' ? 'on' : ''}`} aria-pressed={mode === 'text'} onClick={() => setMode('text')}>
            Text
          </button>
        </div>
      </div>

      {mode === 'form' ? (
        <FormView name={name} text={text} onChange={(t) => (setText(t), setServer(null))} />
      ) : (
        <TextView text={text} jump={jump} onChange={(t) => (setText(t), setServer(null))} />
      )}

      <Diagnostics
        items={diags}
        onLine={(l) => {
          setMode('text')
          setJump(null)
          setTimeout(() => setJump(l), 0)
        }}
      />
      {server?.ok && <p className="m-0 text-[13px] text-[#7ee2a8]">Geprüft: der Quadlet-Generator erzeugt {quadletUnit(name)}.</p>}
      {server?.generated && (
        <div>
          <button type="button" className="btn sm" aria-expanded={showGenerated} onClick={() => setShowGenerated((s) => !s)}>
            Erzeugte Unit {showGenerated ? 'ausblenden' : 'anzeigen'}
          </button>
          {showGenerated && <pre className="joblog mt-2 !min-h-0">{server.generated}</pre>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {!readonly && !isNew && (
          <button type="button" className="btn danger sm" onClick={() => setConfirmDelete(true)}>
            <Glyph name="trash" size={14} /> Löschen
          </button>
        )}
        {history.length > 0 && (
          <button type="button" className="btn sm" onClick={() => setShowHistory(true)}>
            Verlauf ({history.length})
          </button>
        )}
        <span className="grow" />
        {dirty && !isNew && (
          <button type="button" className="btn sm" onClick={() => (setText(initial), setServer(null))}>
            Verwerfen
          </button>
        )}
        <button type="button" className="btn sm" onClick={validate} disabled={checking}>
          {checking ? 'Prüfe …' : 'Prüfen'}
        </button>
        {!readonly && (
          <button type="button" className="btn primary sm" disabled={!dirty || checking || local.some((d) => d.severity === 'error')} onClick={startSave}>
            Speichern …
          </button>
        )}
      </div>

      <Modal open={review} onClose={() => setReview(false)} title={`${name} speichern?`} wide>
        <DiffView before={isNew ? '' : initial} after={text} />
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
          Danach <span className="font-mono">{quadletUnit(name)}</span> {isNew ? 'starten' : 'neu starten'}
        </label>
        <p className="m-0 text-[12px] text-muted">Gespeichert wird über den Root-Helfer, danach systemctl daemon-reload. Die vorige Fassung bleibt im Verlauf.</p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => setReview(false)}>
            Abbrechen
          </button>
          <button type="button" className="btn primary" disabled={saving} onClick={save}>
            {saving ? 'Speichere …' : restart ? (isNew ? 'Speichern & starten' : 'Speichern & neu starten') : 'Speichern'}
          </button>
        </div>
      </Modal>

      <HistoryDialog
        open={showHistory}
        name={name}
        history={history}
        current={text}
        onClose={() => setShowHistory(false)}
        onLoad={(content) => {
          setText(content)
          setServer(null)
          setShowHistory(false)
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={`${name} löschen?`}
        danger
        confirm="Löschen"
        body={<p className="m-0">{quadletUnit(name)} wird gestoppt und die Datei gelöscht. Im Verlauf bleibt sie erhalten.</p>}
        onConfirm={() => void remove()}
        onClose={() => setConfirmDelete(false)}
      />
    </section>
  )
}

function HistoryDialog({ open, name, history, current, onClose, onLoad }: { open: boolean; name: string; history: Revision[]; current: string; onClose: () => void; onLoad: (c: string) => void }) {
  const [sel, setSel] = useState<Revision | null>(null)
  const [content, setContent] = useState<string | null>(null)
  useEffect(() => {
    setSel(open ? (history[1] ?? history[0] ?? null) : null)
  }, [open, history])
  useEffect(() => {
    setContent(null)
    if (!sel) return
    fetch(`/api/quadlets/revision?name=${encodeURIComponent(name)}&id=${sel.id}`)
      .then((r) => r.json())
      .then((d: { content?: string }) => setContent(d.content ?? ''))
      .catch(() => setContent(''))
  }, [sel, name])
  return (
    <Modal open={open} onClose={onClose} title={`Verlauf: ${name}`} wide>
      <div className="flex flex-wrap gap-1.5" role="listbox" aria-label="Versionen">
        {history.map((h) => (
          <button key={h.id} type="button" role="option" aria-selected={sel?.id === h.id} className={`seg ${sel?.id === h.id ? 'on' : ''}`} onClick={() => setSel(h)} title={h.message}>
            <span suppressHydrationWarning>{relative(h.date)}</span>
            <span className="opacity-60">{h.message}</span>
          </button>
        ))}
      </div>
      {sel && content !== null && (
        <>
          <p className="m-0 text-[12px] text-muted">Unterschied dieser Version zum aktuellen Stand im Editor:</p>
          <DiffView before={content} after={current} />
        </>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          Schließen
        </button>
        <button type="button" className="btn primary" disabled={content === null} onClick={() => content !== null && onLoad(content)}>
          Diese Version in den Editor laden
        </button>
      </div>
    </Modal>
  )
}
