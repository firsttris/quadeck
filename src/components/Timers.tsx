// Timers ("Zeitpläne", the systemd replacement for cron): list with schedule,
// next/last run and result; create and edit Quadeck's own timers; change the
// schedule of any other timer via drop-in.

import { Link, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useActions } from './Actions'
import { ConfirmDialog, Modal } from './Modal'
import { RowMenu } from './RowMenu'
import { Pill, type Tone } from './Status'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'
import { relative } from '~/lib/format'
import {
  DAYS,
  DAY_LABEL,
  buildCalendar,
  cronToCalendar,
  describeCalendar,
  emptySpec,
  parseCalendar,
  renderService,
  renderTimer,
  specErrors,
  type CalendarPreview,
  type Day,
  type Schedule,
  type TimerAction,
  type TimerEntry,
  type TimerSpec,
  type TimersState,
} from '~/shared/timers'

const two = (n: number) => String(n).padStart(2, '0')

/** "Mo 05.10. 03:00" */
export function runLabel(ts: number) {
  const d = new Date(ts)
  return `${['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()]} ${two(d.getDate())}.${two(d.getMonth() + 1)}. ${two(d.getHours())}:${two(d.getMinutes())}`
}

function lastRun(t: TimerEntry): { tone: Tone; label: string } {
  if (t.serviceActive === 'active' || t.serviceActive === 'activating') return { tone: 'ok', label: 'läuft' }
  if (t.serviceActive === 'failed' || (t.result && t.result !== 'success'))
    return {
      tone: 'bad',
      label: t.result === 'exit-code' ? `Fehler (Exit ${t.exitStatus ?? '?'})` : `Fehler (${t.result ?? 'failed'})`,
    }
  if (!t.last) return { tone: 'idle', label: 'noch nie' }
  return { tone: 'ok', label: 'ok' }
}

const schedules = (t: TimerEntry) => [
  ...t.calendars.map(describeCalendar),
  ...t.monotonic.map((m) => m.replace(/^On(\w+?)Sec=/, (_, k: string) => `${{ Boot: 'nach Boot', Startup: 'nach Start', UnitActive: 'alle', UnitInactive: 'nach Ende +', Active: 'nach Aktivierung' }[k] ?? k} `)),
]

export function TimersView() {
  const navigate = useNavigate()
  const [state, setState] = useState<TimersState | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<{
    spec: TimerSpec
    previous?: string
    enabled: boolean
  } | null>(null)
  const [scheduling, setScheduling] = useState<TimerEntry | null>(null)
  const [files, setFiles] = useState<{ timer: TimerEntry; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const { readonly } = useActions()
  const guarded = useGuardedApi()
  const say = useToast()

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/timers')
      const d = (await r.json()) as TimersState & { error?: string }
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setState(d)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  const act = async (t: TimerEntry, action: TimerAction) => {
    setBusy(t.name)
    try {
      const r = await guarded<TimersState>('/api/timers', {
        body: { action: { name: t.name, action } },
      })
      if (r) {
        setState(r)
        say(action === 'run' ? `${t.service ?? t.name} gestartet` : action === 'enable' ? `${t.name} aktiviert` : `${t.name} deaktiviert`)
      }
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setBusy(null)
    }
  }

  const showFiles = async (t: TimerEntry) => {
    const name = t.name
    try {
      const r = await fetch(`/api/timers?files=${encodeURIComponent(name)}`)
      const d = (await r.json()) as { text?: string; error?: string }
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setFiles({ timer: t, text: d.text ?? '' })
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }

  const timers = state?.timers ?? []
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 grow text-[13px] text-muted">Zeitpläne laufen über systemd-Timer – der Nachfolger von cron. Verpasste Läufe werden nachgeholt, die Ausgabe landet im Journal.</p>
        {!readonly && (
          <button type="button" className="btn primary sm" onClick={() => setEditing({ spec: emptySpec(), enabled: true })}>
            + Neuer Zeitplan
          </button>
        )}
      </div>
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {state?.error && <p className="m-0 text-[13px] text-[#e3b341]">{state.error}</p>}
      <div className="panel relative overflow-x-auto">
        <table className="tbl" aria-label="Zeitpläne">
          <thead>
            <tr>
              <th>Timer</th>
              <th>Zeitplan</th>
              <th className="hidden sm:table-cell">Nächster Lauf</th>
              <th>Letzter Lauf</th>
              <th className="hidden md:table-cell">Aktiv</th>
              <th>
                <span className="sr-only">Aktionen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {!state && !error && (
              <tr>
                <td colSpan={6} className="text-muted">
                  Wird geladen …
                </td>
              </tr>
            )}
            {state && timers.length === 0 && (
              <tr>
                <td colSpan={6} className="text-muted">
                  Keine Timer.
                </td>
              </tr>
            )}
            {timers.map((t) => {
              const last = lastRun(t)
              return (
                <tr key={t.name} data-testid="timer-row">
                  <td className="max-w-[380px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[13px] font-medium text-fg hover:underline"
                        title="Unit-Dateien anzeigen"
                        aria-label={`Dateien von ${t.name}`}
                        onClick={() => void showFiles(t)}
                      >
                        {t.name}
                      </button>
                      {t.managed && <span className="chip q">Quadeck</span>}
                      {t.modified && <span className="chip">von Hand geändert</span>}
                    </div>
                    {t.description && <div className="truncate text-[12px] text-muted">{t.description}</div>}
                    {t.command && (
                      <div className="truncate font-mono text-[11px] text-subtle" title={t.command}>
                        {t.command.split('\n')[0]}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="text-[13px]">{schedules(t).join(' · ') || '–'}</div>
                    {t.override && <div className="text-[11px] text-[#e3b341]">angepasst (Drop-in)</div>}
                  </td>
                  <td className="hidden font-mono text-[12px] sm:table-cell" suppressHydrationWarning>
                    {t.next ? <span title={runLabel(t.next)}>{relative(t.next)}</span> : <span className="text-muted">–</span>}
                  </td>
                  <td suppressHydrationWarning>
                    <div className="flex flex-col items-start gap-0.5">
                      <Pill tone={last.tone}>{last.label}</Pill>
                      {t.last && <span className="font-mono text-[11px] text-subtle">{relative(t.last)}</span>}
                    </div>
                  </td>
                  <td className="hidden md:table-cell">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`${t.name} aktiv`}
                      checked={t.enabled}
                      disabled={readonly || busy === t.name || t.unitFileState === 'static' || t.unitFileState === 'masked'}
                      title={t.unitFileState === 'static' ? 'statisch – wird von einer anderen Unit gestartet' : undefined}
                      onChange={(e) => void act(t, e.target.checked ? 'enable' : 'disable')}
                    />
                  </td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      {!readonly && t.service && (
                        <button type="button" className="btn sm" disabled={busy === t.name} onClick={() => void act(t, 'run')} aria-label={`${t.name} jetzt ausführen`}>
                          Jetzt ausführen
                        </button>
                      )}
                      <RowMenu
                        label={`Aktionen für ${t.name}`}
                        items={[
                          ...(readonly
                            ? []
                            : t.managed && !t.modified
                              ? [{ label: 'Bearbeiten …', onSelect: () => setEditing({ spec: t.managed!, previous: t.managed!.name, enabled: t.enabled }) }]
                              : [{ label: 'Zeitplan ändern …', onSelect: () => setScheduling(t) }]),
                          ...(t.service ? [{ label: 'Journal', onSelect: () => void navigate({ to: '/journal', search: { unit: t.service! } }) }] : []),
                          { label: 'Unit-Dateien anzeigen', onSelect: () => void showFiles(t) },
                          { label: 'Unit bearbeiten', onSelect: () => void navigate({ to: '/systemd', search: { unit: t.name } }), separator: true },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {editing && <TimerEditor key={editing.previous ?? 'new'} initial={editing.spec} previous={editing.previous} enabled={editing.enabled} existing={timers} onClose={() => setEditing(null)} onSaved={setState} />}
      {scheduling && <ScheduleDialog timer={scheduling} onClose={() => setScheduling(null)} onSaved={setState} />}
      <Modal open={files !== null} onClose={() => setFiles(null)} title="Unit-Dateien" wide>
        <pre className="m-0 max-h-[60vh] overflow-auto rounded-lg bg-[#0e1319] p-3 font-mono text-[12px] whitespace-pre-wrap">{files?.text}</pre>
        <div className="flex flex-wrap justify-end gap-2">
          {files && (
            <Link to="/systemd" search={{ unit: files.timer.name }} className="btn">
              {files.timer.name} im Editor
            </Link>
          )}
          {files?.timer.service && (
            <Link to="/systemd" search={{ unit: files.timer.service }} className="btn">
              {files.timer.service} im Editor
            </Link>
          )}
          <button type="button" className="btn" onClick={() => setFiles(null)}>
            Schließen
          </button>
        </div>
      </Modal>
    </>
  )
}

// ---------- schedule ----------

const KINDS: [Schedule['kind'], string][] = [
  ['minutes', 'Minuten'],
  ['hours', 'Stündlich'],
  ['daily', 'Täglich'],
  ['weekly', 'Wöchentlich'],
  ['monthly', 'Monatlich'],
  ['custom', 'Eigener'],
]

function defaults(kind: Schedule['kind'], from: Schedule): Schedule {
  const time = 'time' in from ? from.time : '03:00'
  switch (kind) {
    case 'minutes':
      return { kind, every: 15 }
    case 'hours':
      return { kind, every: 1, minute: 0 }
    case 'daily':
      return { kind, time }
    case 'weekly':
      return { kind, days: ['Mon'], time }
    case 'monthly':
      return { kind, day: 1, time }
    case 'custom':
      return { kind, expr: buildCalendar(from) }
  }
}

/** Live preview of the next runs (systemd-analyze calendar on the server). */
export function useCalendarPreview(expr: string) {
  const [preview, setPreview] = useState<CalendarPreview | null>(null)
  useEffect(() => {
    if (!expr.trim()) return setPreview(null)
    const ctl = new AbortController()
    const t = setTimeout(() => {
      fetch(`/api/timers?calendar=${encodeURIComponent(expr.trim())}`, {
        signal: ctl.signal,
      })
        .then((r) => r.json() as Promise<CalendarPreview>)
        .then(setPreview)
        .catch(() => {})
    }, 300)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [expr])
  return preview
}

/** Builder for OnCalendar= with presets, cron import and the next runs. */
export function ScheduleField({ value, onChange, readonly }: { value: string; onChange: (v: string) => void; readonly?: boolean }) {
  // The builder keeps its own mode so "Eigener" stays selected while typing.
  const [sched, setSched] = useState<Schedule>(() => parseCalendar(value))
  const [cron, setCron] = useState('')
  const preview = useCalendarPreview(value)
  const set = (s: Schedule) => {
    setSched(s)
    onChange(buildCalendar(s))
  }
  const cronResult = cron.trim() ? cronToCalendar(cron) : null
  return (
    <fieldset className="flex flex-col gap-2.5 rounded-lg border border-line p-3" disabled={readonly}>
      <legend className="px-1 text-[12px] font-medium text-muted">Zeitplan</legend>
      <div role="group" aria-label="Art des Zeitplans" className="flex flex-wrap gap-1.5">
        {KINDS.map(([k, label]) => (
          <button key={k} type="button" className={`seg ${sched.kind === k ? 'on' : ''}`} aria-pressed={sched.kind === k} onClick={() => set(defaults(k, sched))}>
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        {sched.kind === 'minutes' && (
          <>
            alle
            <select className="field w-[90px]" aria-label="Minuten" value={sched.every} onChange={(e) => set({ ...sched, every: Number(e.target.value) })}>
              {[1, 2, 5, 10, 15, 20, 30].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            Minuten
          </>
        )}
        {sched.kind === 'hours' && (
          <>
            alle
            <select className="field w-[80px]" aria-label="Stunden" value={sched.every} onChange={(e) => set({ ...sched, every: Number(e.target.value) })}>
              {[1, 2, 3, 4, 6, 8, 12].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            Stunde(n), Minute
            <input
              className="field w-[70px]"
              type="number"
              min={0}
              max={59}
              aria-label="Minute"
              value={sched.minute}
              onChange={(e) =>
                set({
                  ...sched,
                  minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)),
                })
              }
            />
          </>
        )}
        {sched.kind === 'weekly' && (
          <div role="group" aria-label="Wochentage" className="flex gap-1">
            {DAYS.map((d) => {
              const on = sched.days.includes(d)
              return (
                <button
                  key={d}
                  type="button"
                  className={`seg ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  onClick={() => {
                    const days: Day[] = on ? sched.days.filter((x) => x !== d) : [...sched.days, d]
                    if (days.length) set({ ...sched, days })
                  }}
                >
                  {DAY_LABEL[d]}
                </button>
              )
            })}
          </div>
        )}
        {sched.kind === 'monthly' && (
          <>
            am
            <input
              className="field w-[70px]"
              type="number"
              min={1}
              max={31}
              aria-label="Tag im Monat"
              value={sched.day}
              onChange={(e) =>
                set({
                  ...sched,
                  day: Math.min(31, Math.max(1, Number(e.target.value) || 1)),
                })
              }
            />
            .
          </>
        )}
        {(sched.kind === 'daily' || sched.kind === 'weekly' || sched.kind === 'monthly') && (
          <>
            um
            <input className="field w-[110px]" type="time" aria-label="Uhrzeit" value={sched.time} onChange={(e) => e.target.value && set({ ...sched, time: e.target.value })} />
          </>
        )}
        {sched.kind === 'custom' && (
          <input
            className="field min-w-[240px] grow font-mono"
            aria-label="OnCalendar-Ausdruck"
            value={sched.expr}
            placeholder="z. B. Mon..Fri *-*-* 07:30:00"
            onChange={(e) => {
              setSched({ kind: 'custom', expr: e.target.value })
              onChange(e.target.value)
            }}
          />
        )}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
        <span className="font-mono text-subtle" data-testid="calendar-expr">
          OnCalendar={value}
        </span>
        {preview && !preview.ok && (
          <span role="alert" className="text-[#ff8a80]">
            {preview.error}
          </span>
        )}
      </div>
      {preview?.ok && preview.next.length > 0 && (
        <div className="text-[12px] text-muted" data-testid="next-runs">
          Nächste Läufe: <span className="font-mono text-[#c9d1d9]">{preview.next.map(runLabel).join(' · ')}</span>
        </div>
      )}
      {sched.kind === 'custom' && (
        <details className="text-[12px] text-muted">
          <summary className="cursor-pointer">Von cron übernehmen</summary>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input className="field min-w-[220px] grow font-mono" aria-label="Cron-Ausdruck" placeholder="30 3 * * 1-5" value={cron} onChange={(e) => setCron(e.target.value)} />
            <button
              type="button"
              className="btn sm"
              disabled={!cronResult?.calendar}
              onClick={() => {
                setSched({ kind: 'custom', expr: cronResult!.calendar! })
                onChange(cronResult!.calendar!)
                setCron('')
              }}
            >
              Übernehmen
            </button>
          </div>
          {cronResult?.error && <p className="m-0 mt-1 text-[#ff8a80]">{cronResult.error}</p>}
          {cronResult?.calendar && <p className="m-0 mt-1 font-mono">→ {cronResult.calendar}</p>}
          {cronResult?.warning && <p className="m-0 mt-1 text-[#e3b341]">{cronResult.warning}</p>}
        </details>
      )}
    </fieldset>
  )
}

// ---------- own timers ----------

const TEMPLATES: { label: string; spec: Partial<TimerSpec> }[] = [
  {
    label: 'Skript ausführen',
    spec: {
      name: 'mein-skript',
      description: 'Eigenes Skript',
      command: '/usr/local/bin/mein-skript.sh',
      calendar: '*-*-* 03:00:00',
    },
  },
  {
    label: 'Ordner sichern (rsync)',
    spec: {
      name: 'backup-daten',
      description: 'Daten sichern',
      command: 'rsync -a --delete /srv/daten/ /mnt/backup/daten/',
      calendar: '*-*-* 02:30:00',
      lowPriority: true,
    },
  },
  {
    label: 'Podman aufräumen',
    spec: {
      name: 'podman-prune',
      description: 'Ungenutzte Podman-Images entfernen',
      command: 'podman image prune -af --filter until=168h',
      calendar: 'Sun *-*-* 05:00:00',
      lowPriority: true,
    },
  },
  {
    label: 'SnapRAID sync + scrub',
    spec: {
      name: 'snapraid-wartung',
      description: 'SnapRAID sync und scrub',
      command: 'snapraid sync\nsnapraid scrub -p 8 -o 10',
      calendar: '*-*-* 04:00:00',
      lowPriority: true,
    },
  },
  {
    label: 'Webseite anpingen',
    spec: {
      name: 'healthcheck-ping',
      description: 'Lebenszeichen senden',
      command: 'curl -fsS -m 10 https://hc-ping.com/DEINE-UUID',
      calendar: '*-*-* *:00/5:00',
      persistent: false,
      network: true,
    },
  },
]

function TimerEditor({ initial, previous, enabled: initialEnabled, existing, onClose, onSaved }: { initial: TimerSpec; previous?: string; enabled: boolean; existing: TimerEntry[]; onClose: () => void; onSaved: (s: TimersState) => void }) {
  const [spec, setSpec] = useState(initial)
  const [enabled, setEnabled] = useState(initialEnabled)
  const [tab, setTab] = useState<'form' | 'files'>('form')
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [scheduleKey, setScheduleKey] = useState(0)
  const guarded = useGuardedApi()
  const say = useToast()
  const set = <K extends keyof TimerSpec>(k: K, v: TimerSpec[K]) => setSpec((s) => ({ ...s, [k]: v }))
  const errors = specErrors(spec)
  const taken = spec.name !== previous && existing.some((t) => t.name === `${spec.name}.timer` || t.service === `${spec.name}.service`)
  const preview = useMemo(() => (errors.length ? '' : `# ${spec.name}.timer\n${renderTimer(spec)}\n# ${spec.name}.service\n${renderService(spec)}`), [spec, errors.length])

  const save = async () => {
    setBusy(true)
    try {
      const r = await guarded<TimersState>('/api/timers', {
        body: { save: { spec, previous, enable: enabled } },
      })
      if (r) {
        onSaved(r)
        say(`${spec.name}.timer gespeichert${enabled ? ' und aktiviert' : ''}`)
        onClose()
      }
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    setBusy(true)
    try {
      const r = await guarded<TimersState>('/api/timers', {
        body: { delete: `${previous}.timer` },
      })
      if (r) {
        onSaved(r)
        say(`${previous}.timer gelöscht`)
        onClose()
      }
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={previous ? `Zeitplan ${previous} bearbeiten` : 'Neuer Zeitplan'} wide>
      {!previous && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
          Vorlage:
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              type="button"
              className="seg"
              onClick={() => {
                setSpec({ ...emptySpec(), ...t.spec })
                setScheduleKey((k) => k + 1)
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div role="tablist" className="flex gap-1.5">
        <button type="button" role="tab" aria-selected={tab === 'form'} className={`seg ${tab === 'form' ? 'on' : ''}`} onClick={() => setTab('form')}>
          Einstellungen
        </button>
        <button type="button" role="tab" aria-selected={tab === 'files'} className={`seg ${tab === 'files' ? 'on' : ''}`} onClick={() => setTab('files')} disabled={!!errors.length}>
          Unit-Dateien
        </button>
      </div>
      {tab === 'files' ? (
        <pre className="m-0 max-h-[55vh] overflow-auto rounded-lg bg-[#0e1319] p-3 font-mono text-[12px] whitespace-pre-wrap" data-testid="timer-files">
          {preview}
        </pre>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
              Name
              <input className="field font-mono" value={spec.name} onChange={(e) => set('name', e.target.value.trim())} placeholder="backup-fotos" autoFocus={!previous} />
              {taken && <span className="font-normal text-[#ff8a80]">{spec.name}.timer gibt es schon</span>}
            </label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
              Beschreibung
              <input className="field" value={spec.description} onChange={(e) => set('description', e.target.value)} placeholder="Fotos auf die Backup-Platte kopieren" />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
            Befehl (läuft mit /bin/sh, mehrere Zeilen erlaubt)
            <textarea className="field h-[90px] font-mono text-[12px]" spellCheck={false} value={spec.command} onChange={(e) => set('command', e.target.value)} placeholder="/usr/local/bin/backup.sh" />
          </label>
          <ScheduleField key={scheduleKey} value={spec.calendar} onChange={(v) => set('calendar', v)} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
              Als Benutzer
              <input className="field font-mono" value={spec.user} onChange={(e) => set('user', e.target.value.trim())} placeholder="root" />
            </label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
              Arbeitsverzeichnis
              <input className="field font-mono" value={spec.workingDirectory} onChange={(e) => set('workingDirectory', e.target.value.trim())} placeholder="(keins)" />
            </label>
          </div>
          <div className="flex flex-col gap-1.5 text-[13px]">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={spec.persistent} onChange={(e) => set('persistent', e.target.checked)} />
              Verpasste Läufe nachholen (Server war aus)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={spec.network} onChange={(e) => set('network', e.target.checked)} />
              Auf Netzwerk warten
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={spec.lowPriority} onChange={(e) => set('lowPriority', e.target.checked)} />
              Niedrige Priorität (CPU und Festplatte)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={spec.randomDelay > 0} onChange={(e) => set('randomDelay', e.target.checked ? 15 : 0)} />
              Zufällig bis zu
              <input
                className="field w-[70px]"
                type="number"
                min={1}
                max={1440}
                aria-label="Verzögerung in Minuten"
                disabled={!spec.randomDelay}
                value={spec.randomDelay || 15}
                onChange={(e) => set('randomDelay', Math.max(1, Math.min(1440, Number(e.target.value) || 1)))}
              />
              Minuten später starten
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Timer aktiv
            </label>
          </div>
        </div>
      )}
      {errors.length > 0 && spec.name && <p className="m-0 text-[12px] text-[#e3b341]">{errors.join(' · ')}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {previous && (
          <button type="button" className="btn danger mr-auto" disabled={busy} onClick={() => setConfirmDelete(true)}>
            Löschen
          </button>
        )}
        <button type="button" className="btn" onClick={onClose}>
          Abbrechen
        </button>
        <button type="button" className="btn primary" disabled={busy || errors.length > 0 || taken} onClick={() => void save()}>
          {busy ? 'Speichert …' : 'Speichern'}
        </button>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={`${previous}.timer löschen?`}
        danger
        confirm="Löschen"
        body={<p className="m-0">Timer und Service werden gestoppt und die beiden Unit-Dateien entfernt.</p>}
        onConfirm={() => void remove()}
        onClose={() => setConfirmDelete(false)}
      />
    </Modal>
  )
}

// ---------- foreign timers ----------

function ScheduleDialog({ timer, onClose, onSaved }: { timer: TimerEntry; onClose: () => void; onSaved: (s: TimersState) => void }) {
  const [calendar, setCalendar] = useState(timer.override ?? timer.calendars[0] ?? '*-*-* 03:00:00')
  const [busy, setBusy] = useState(false)
  const guarded = useGuardedApi()
  const say = useToast()
  const apply = async (cal: string) => {
    setBusy(true)
    try {
      const r = await guarded<TimersState>('/api/timers', {
        body: { schedule: { name: timer.name, calendar: cal } },
      })
      if (r) {
        onSaved(r)
        say(cal ? `${timer.name}: ${describeCalendar(cal)}` : `${timer.name}: Standard-Zeitplan`)
        onClose()
      }
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={`Zeitplan von ${timer.name}`} wide>
      <p className="m-0 text-[13px] text-muted">
        {timer.vendor ? 'Der Timer kommt aus einem Paket – die Datei bleibt unangetastet. ' : ''}
        Quadeck legt den neuen Zeitplan als Drop-in <span className="font-mono">{timer.name}.d/50-quadeck.conf</span> ab; „Standard“ entfernt ihn wieder.
        {timer.modified ? ' (Die Dateien wurden von Hand geändert, darum lässt sich hier nur der Zeitplan anpassen.)' : ''}
      </p>
      {timer.monotonic.length > 0 && <p className="m-0 text-[12px] text-[#e3b341]">Zusätzliche Auslöser bleiben bestehen: {timer.monotonic.join(', ')}</p>}
      <ScheduleField value={calendar} onChange={setCalendar} />
      <div className="flex flex-wrap justify-end gap-2">
        {timer.override && (
          <button type="button" className="btn mr-auto" disabled={busy} onClick={() => void apply('')}>
            Standard wiederherstellen
          </button>
        )}
        <button type="button" className="btn" onClick={onClose}>
          Abbrechen
        </button>
        <button type="button" className="btn primary" disabled={busy || !calendar.trim()} onClick={() => void apply(calendar.trim())}>
          Übernehmen
        </button>
      </div>
    </Modal>
  )
}
