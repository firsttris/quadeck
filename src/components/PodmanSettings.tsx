import { useEffect, useState } from 'react'
import { useT } from '~/i18n'
import { relative } from '~/lib/format'
import { getToml, setToml, type TomlValue } from '~/shared/toml-edit'
import type { PodmanConfigFile, PodmanSettings } from '~/shared/quadlets'
import { useActions } from './Actions'
import { DiffView } from './QuadletEditor'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'

/** OnCalendar presets: [value, label key]. */
const PRESETS: [string, 'daily' | 'daily4' | 'monday4' | 'weekly'][] = [
  ['daily', 'daily'],
  ['*-*-* 04:00', 'daily4'],
  ['Mon *-*-* 04:00', 'monday4'],
  ['weekly', 'weekly'],
]

/** Form fields per config file; label and help come from the podman texts (by key). */
const FORMS: Record<string, { section: string; key: string; kind: 'text' | 'list' | 'select'; options?: string[] }[]> = {
  'registries.conf': [
    { section: '', key: 'unqualified-search-registries', kind: 'list' },
    { section: '', key: 'short-name-mode', kind: 'select', options: ['', 'enforcing', 'permissive', 'disabled'] },
  ],
  'containers.conf': [
    { section: 'containers', key: 'log_driver', kind: 'select', options: ['', 'journald', 'k8s-file', 'none'] },
    { section: 'containers', key: 'tz', kind: 'text' },
    { section: 'containers', key: 'log_size_max', kind: 'text' },
    { section: 'engine', key: 'events_logger', kind: 'select', options: ['', 'journald', 'file', 'none'] },
    { section: 'engine', key: 'image_parallel_copies', kind: 'text' },
  ],
}

function ConfigCard({ file, readonly, onSaved }: { file: PodmanConfigFile; readonly: boolean; onSaved: (s: PodmanSettings) => void }) {
  const tx = useT()
  const t = tx.podman.config
  const say = useToast()
  const guarded = useGuardedApi()
  const [text, setText] = useState(file.content)
  const [review, setReview] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => setText(file.content), [file.content])
  const form = FORMS[file.name] ?? []
  const dirty = text !== file.content

  const value = (f: (typeof form)[number]) => {
    const v = getToml(text, f.section, f.key)
    return Array.isArray(v) ? v.join(', ') : v === undefined ? '' : String(v)
  }
  const setField = (f: (typeof form)[number], raw: string) => {
    let v: TomlValue | undefined = raw.trim() || undefined
    if (v !== undefined && f.kind === 'list') v = raw.split(',').map((s) => s.trim()).filter(Boolean)
    else if (v !== undefined && /^-?\d+$/.test(raw.trim())) v = Number(raw.trim())
    setText(setToml(text, f.section, f.key, v))
  }

  const save = async () => {
    setError('')
    try {
      const s = await guarded<PodmanSettings>('/api/podman/settings', { body: { config: { name: file.name, content: text } } })
      if (!s) return
      setReview(false)
      say(t.saved(file.path, file.name))
      onSaved(s)
    } catch (e) {
      setError((e as Error).message)
      setReview(false)
    }
  }

  return (
    <section className="panel flex flex-col gap-3 p-[18px]" aria-label={file.name}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="h2 font-mono">{file.name}</h2>
        <span className="text-[12px] text-muted">{file.path}</span>
        {!file.exists && <span className="chip">{t.missing}</span>}
        {!file.editable && <span className="chip">{t.readonly}</span>}
      </div>
      {file.editable && !readonly && form.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {form.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-[12px]">
              <span className="font-medium text-fg">
                {tx.podman.fields[f.key]?.label} <span className="font-mono text-subtle">{f.section ? `[${f.section}] ` : ''}{f.key}</span>
              </span>
              {f.kind === 'select' ? (
                <select className="field" value={value(f)} onChange={(e) => setField(f, e.target.value)}>
                  {[...new Set([...(f.options ?? []), value(f)])].map((o) => (
                    <option key={o} value={o}>
                      {o || t.default}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="field font-mono" value={value(f)} onChange={(e) => setField(f, e.target.value)} />
              )}
              <span className="text-muted">{tx.podman.fields[f.key]?.help}</span>
            </label>
          ))}
        </div>
      )}
      <textarea
        aria-label={t.asText(file.name)}
        spellCheck={false}
        readOnly={!file.editable || readonly}
        className="field h-[220px] font-mono text-[12px]"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error && (
        <p role="alert" className="m-0 text-[13px] text-[#ff8a80]">
          {error}
        </p>
      )}
      {file.editable && !readonly && (
        <div className="flex justify-end gap-2">
          {dirty && (
            <button type="button" className="btn sm" onClick={() => setText(file.content)}>
              {t.discard}
            </button>
          )}
          <button type="button" className="btn primary sm" disabled={!dirty} onClick={() => setReview(true)}>
            {t.saveDots}
          </button>
        </div>
      )}
      <Modal open={review} onClose={() => setReview(false)} title={t.saveTitle(file.name)} wide>
        <DiffView before={file.content} after={text} />
        <p className="m-0 text-[12px] text-muted">{t.saveNote}</p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => setReview(false)}>
            {tx.common.cancel}
          </button>
          <button type="button" className="btn primary" onClick={save}>
            {tx.common.save}
          </button>
        </div>
      </Modal>
    </section>
  )
}

export function PodmanSettingsView() {
  const tx = useT()
  const u = tx.podman.updates
  const all = tx.podman.all
  const say = useToast()
  const guarded = useGuardedApi()
  const { readonly } = useActions()
  const [s, setS] = useState<PodmanSettings | null>(null)
  const [error, setError] = useState('')
  const [calendar, setCalendar] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/podman/settings')
      .then(async (r) => {
        const d = (await r.json()) as PodmanSettings & { error?: string }
        if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
        setS(d)
        setCalendar(d.timer.custom ? d.timer.calendar : '')
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  const apply = async (body: unknown, done: string) => {
    setBusy(true)
    try {
      const r = await guarded<PodmanSettings>('/api/podman/settings', { body })
      if (r) {
        setS(r)
        say(done)
      }
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }

  if (error) return <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>
  if (!s) return <p className="m-0 text-muted">{u.loading}</p>
  const t = s.timer
  return (
    <>
      <section className="panel flex flex-col gap-3 p-[18px]" aria-label={u.aria}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="h2 grow">{u.title}</h2>
          {s.version && <span className="text-[12px] text-muted">{u.version(s.version)}</span>}
        </div>
        <p className="m-0 text-[13px] text-muted">
          <span className="font-mono">podman-auto-update.timer</span>
          {u.introMiddle}
          <span className="font-mono">AutoUpdate=registry</span>
          {u.introAfter}
          {t.enabled && t.next ? <span suppressHydrationWarning>{u.next(relative(t.next))}</span> : null}
        </p>
        {!t.exists ? (
          <p className="m-0 text-[13px] text-[#e3b341]">{u.noTimer}</p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                role="switch"
                aria-label={u.timerActive}
                checked={t.enabled}
                disabled={readonly || busy}
                onChange={(e) => void apply({ timer: { enabled: e.target.checked, calendar } }, e.target.checked ? u.timerOn : u.timerOff)}
              />
              {u.timerActive}
            </label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
              {u.schedule}
              <input className="field w-[220px] font-mono" value={calendar} placeholder={t.custom ? '' : u.defaultSuffix(t.calendar)} list="calendar-presets" disabled={readonly} onChange={(e) => setCalendar(e.target.value)} />
              <datalist id="calendar-presets">
                {PRESETS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {tx.podman.presets[l]}
                  </option>
                ))}
              </datalist>
            </label>
            {!readonly && (
              <button type="button" className="btn sm" disabled={busy || calendar === (t.custom ? t.calendar : '')} onClick={() => void apply({ timer: { enabled: t.enabled, calendar } }, calendar ? u.scheduleSet(calendar) : u.scheduleDefault)}>
                {u.applySchedule}
              </button>
            )}
          </div>
        )}
      </section>

      <section className="panel flex flex-col gap-3 p-[18px]" aria-label={all.title}>
        <h2 className="h2">{all.title}</h2>
        {s.autoUpdateDefault.supported ? (
          <>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                role="switch"
                aria-label={all.aria}
                checked={s.autoUpdateDefault.enabled}
                disabled={readonly || busy}
                onChange={(e) => void apply({ autoUpdateDefault: e.target.checked }, e.target.checked ? all.on : all.off)}
              />
              <span>
                <span className="font-mono">AutoUpdate=registry</span>
                {all.label}
              </span>
            </label>
            <p className="m-0 text-[12px] text-muted">
              {all.noteBefore}
              <span className="font-mono">{s.autoUpdateDefault.path}</span>
              {all.noteAfter}
            </p>
          </>
        ) : (
          <p className="m-0 text-[13px] text-muted">{all.unsupported(s.version)}</p>
        )}
      </section>

      {s.files.map((f) => (
        <ConfigCard key={f.name} file={f} readonly={readonly} onSaved={setS} />
      ))}
    </>
  )
}
