import { useEffect, useState } from 'react'
import { relative } from '~/lib/format'
import { getToml, setToml, type TomlValue } from '~/shared/toml-edit'
import type { PodmanConfigFile, PodmanSettings } from '~/shared/quadlets'
import { useActions } from './Actions'
import { DiffView } from './QuadletEditor'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'

const PRESETS: [string, string][] = [
  ['daily', 'täglich um Mitternacht (Standard)'],
  ['*-*-* 04:00', 'täglich 04:00'],
  ['Mon *-*-* 04:00', 'montags 04:00'],
  ['weekly', 'wöchentlich'],
]

/** Form fields per config file: [section, key, label, kind, options]. */
const FORMS: Record<string, { section: string; key: string; label: string; kind: 'text' | 'list' | 'select'; options?: string[]; help: string }[]> = {
  'registries.conf': [
    { section: '', key: 'unqualified-search-registries', label: 'Registries für Kurznamen', kind: 'list', help: 'Wo „nginx“ ohne Registry gesucht wird, z. B. docker.io, quay.io (kommagetrennt).' },
    { section: '', key: 'short-name-mode', label: 'Kurznamen-Modus', kind: 'select', options: ['', 'enforcing', 'permissive', 'disabled'], help: 'enforcing: bei mehreren Treffern abbrechen statt raten.' },
  ],
  'containers.conf': [
    { section: 'containers', key: 'log_driver', label: 'Log-Treiber', kind: 'select', options: ['', 'journald', 'k8s-file', 'none'], help: 'journald: Container-Logs im Journal (empfohlen).' },
    { section: 'containers', key: 'tz', label: 'Zeitzone der Container', kind: 'text', help: '„local“ übernimmt die Zeitzone des Hosts.' },
    { section: 'containers', key: 'log_size_max', label: 'Max. Loggröße (Bytes)', kind: 'text', help: 'Nur für k8s-file; -1 = unbegrenzt.' },
    { section: 'engine', key: 'events_logger', label: 'Event-Logger', kind: 'select', options: ['', 'journald', 'file', 'none'], help: 'Wohin Podman Events schreibt.' },
    { section: 'engine', key: 'image_parallel_copies', label: 'Parallele Layer-Downloads', kind: 'text', help: '0 = Standard.' },
  ],
}

function ConfigCard({ file, readonly, onSaved }: { file: PodmanConfigFile; readonly: boolean; onSaved: (s: PodmanSettings) => void }) {
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
      say(`${file.path} gespeichert (vorige Fassung: ${file.name}.quadeck-bak)`)
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
        {!file.exists && <span className="chip">noch nicht vorhanden – Podman nutzt die Vorgaben aus /usr/share/containers</span>}
        {!file.editable && <span className="chip">nur lesen</span>}
      </div>
      {file.editable && !readonly && form.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {form.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-[12px]">
              <span className="font-medium text-fg">
                {f.label} <span className="font-mono text-subtle">{f.section ? `[${f.section}] ` : ''}{f.key}</span>
              </span>
              {f.kind === 'select' ? (
                <select className="field" value={value(f)} onChange={(e) => setField(f, e.target.value)}>
                  {[...new Set([...(f.options ?? []), value(f)])].map((o) => (
                    <option key={o} value={o}>
                      {o || '– Standard –'}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="field font-mono" value={value(f)} onChange={(e) => setField(f, e.target.value)} />
              )}
              <span className="text-muted">{f.help}</span>
            </label>
          ))}
        </div>
      )}
      <textarea
        aria-label={`${file.name} als Text`}
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
              Verwerfen
            </button>
          )}
          <button type="button" className="btn primary sm" disabled={!dirty} onClick={() => setReview(true)}>
            Speichern …
          </button>
        </div>
      )}
      <Modal open={review} onClose={() => setReview(false)} title={`${file.name} speichern?`} wide>
        <DiffView before={file.content} after={text} />
        <p className="m-0 text-[12px] text-muted">Wird vor dem Schreiben als TOML geprüft. Wirkt für neu gestartete Container.</p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => setReview(false)}>
            Abbrechen
          </button>
          <button type="button" className="btn primary" onClick={save}>
            Speichern
          </button>
        </div>
      </Modal>
    </section>
  )
}

export function PodmanSettingsView() {
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
  if (!s) return <p className="m-0 text-muted">Wird geladen …</p>
  const t = s.timer
  return (
    <>
      <section className="panel flex flex-col gap-3 p-[18px]" aria-label="Automatische Updates">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="h2 grow">Automatische Image-Updates</h2>
          {s.version && <span className="text-[12px] text-muted">Podman {s.version}</span>}
        </div>
        <p className="m-0 text-[13px] text-muted">
          <span className="font-mono">podman-auto-update.timer</span> zieht neue Images für Container mit <span className="font-mono">AutoUpdate=registry</span> und startet sie neu (mit Rollback).
          {t.enabled && t.next ? <span suppressHydrationWarning> Nächster Lauf {relative(t.next)}.</span> : null}
        </p>
        {!t.exists ? (
          <p className="m-0 text-[13px] text-[#e3b341]">podman-auto-update.timer ist auf diesem System nicht vorhanden.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                role="switch"
                aria-label="Timer aktiv"
                checked={t.enabled}
                disabled={readonly || busy}
                onChange={(e) => void apply({ timer: { enabled: e.target.checked, calendar } }, e.target.checked ? 'Auto-Update-Timer aktiviert' : 'Auto-Update-Timer deaktiviert')}
              />
              Timer aktiv
            </label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
              Zeitplan (OnCalendar)
              <input className="field w-[220px] font-mono" value={calendar} placeholder={t.custom ? '' : `${t.calendar} (Standard)`} list="calendar-presets" disabled={readonly} onChange={(e) => setCalendar(e.target.value)} />
              <datalist id="calendar-presets">
                {PRESETS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </datalist>
            </label>
            {!readonly && (
              <button type="button" className="btn sm" disabled={busy || calendar === (t.custom ? t.calendar : '')} onClick={() => void apply({ timer: { enabled: t.enabled, calendar } }, calendar ? `Zeitplan: ${calendar}` : 'Standard-Zeitplan')}>
                Zeitplan übernehmen
              </button>
            )}
          </div>
        )}
      </section>

      <section className="panel flex flex-col gap-3 p-[18px]" aria-label="Auto-Update für alle Container">
        <h2 className="h2">Auto-Update für alle Container</h2>
        {s.autoUpdateDefault.supported ? (
          <>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                role="switch"
                aria-label="AutoUpdate=registry für alle"
                checked={s.autoUpdateDefault.enabled}
                disabled={readonly || busy}
                onChange={(e) => void apply({ autoUpdateDefault: e.target.checked }, e.target.checked ? 'AutoUpdate=registry gilt jetzt für alle Container' : 'Globales AutoUpdate entfernt')}
              />
              <span>
                <span className="font-mono">AutoUpdate=registry</span> für alle .container-Dateien
              </span>
            </label>
            <p className="m-0 text-[12px] text-muted">
              Als Quadlet-Drop-in <span className="font-mono">{s.autoUpdateDefault.path}</span> (Podman 5). Gilt nach daemon-reload für alle Container und überschreibt AutoUpdate= in einzelnen Dateien. Images müssen voll qualifiziert sein (docker.io/…).
            </p>
          </>
        ) : (
          <p className="m-0 text-[13px] text-muted">Braucht Podman 5 oder neuer (installiert: {s.version ?? 'unbekannt'}). Bis dahin AutoUpdate=registry pro Datei setzen.</p>
        )}
      </section>

      {s.files.map((f) => (
        <ConfigCard key={f.name} file={f} readonly={readonly} onSaved={setS} />
      ))}
    </>
  )
}
