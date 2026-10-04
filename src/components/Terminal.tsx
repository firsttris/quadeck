import '@xterm/xterm/css/xterm.css'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, csrfHeaders } from '~/lib/api'
import { IDLE_MINUTES, KEYS, ctrlKey, type IdleMinutes, type TerminalInfo, type TerminalSettings } from '~/shared/terminal'
import { useActions } from './Actions'
import { Modal } from './Modal'
import { PageHeader } from './PageHeader'
import { useToast } from './Toast'
import { useGuardedApi } from './Unlock'
import { m } from '~/paraglide/messages'

type State = { settings: TerminalSettings; sessions: TerminalInfo[] }
type XTerm = import('@xterm/xterm').Terminal

const post = (body: Record<string, unknown>) => api('/api/terminal', { body })

/** Terminal: shells on the server and in containers, in tabs. */
export function TerminalPage({ container }: { container?: string }) {
  const navigate = useNavigate()
  const guarded = useGuardedApi()
  const say = useToast()
  const { readonly } = useActions()
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState('')
  const [tabs, setTabs] = useState<TerminalInfo[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [font, setFont] = useState(13)
  const [full, setFull] = useState(false)
  const opened = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const s = await api<State>('/api/terminal', { method: 'GET' })
      setState(s)
      setTabs((t) => [...t, ...s.sessions.filter((x) => !t.some((y) => y.id === x.id))])
      setActive((a) => a ?? s.sessions[0]?.id ?? null)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const open = useCallback(
    async (target: { kind: 'shell' } | { kind: 'container'; name: string }) => {
      try {
        const info = await guarded<TerminalInfo>('/api/terminal', { body: { action: 'open', target, cols: 100, rows: 30 } })
        if (!info) return
        setTabs((t) => [...t, info])
        setActive(info.id)
      } catch (e) {
        say((e as Error).message, 'bad')
      }
    },
    [guarded, say],
  )

  // Units → "Shell in container" lands here with ?container=…
  useEffect(() => {
    if (!container || !state?.settings.enabled || opened.current === container) return
    opened.current = container
    void open({ kind: 'container', name: container }).then(() => navigate({ to: '/terminal', search: {}, replace: true }))
  }, [container, state, open, navigate])

  const closeTab = async (id: string) => {
    await post({ action: 'close', id }).catch(() => {})
    setTabs((t) => {
      const rest = t.filter((x) => x.id !== id)
      if (active === id) setActive(rest.at(-1)?.id ?? null)
      return rest
    })
  }

  if (error) return <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>
  if (!state) return <p className="m-0 text-muted">{m.terminal_loading()}</p>

  return (
    <>
      <PageHeader title={m.terminal_title()} subtitle={m.terminal_subtitle()}>
        {state.settings.enabled && (
          <button type="button" className="btn sm" onClick={() => setEditing(true)}>
            {m.terminal_settings()}
          </button>
        )}
      </PageHeader>
      {!state.settings.enabled ? (
        <SettingsCard settings={state.settings} readonly={readonly} onSaved={setState} />
      ) : (
        <section className={`flex min-h-0 flex-col ${full ? 'fixed inset-0 z-50 bg-bg p-3' : ''}`} aria-label={m.terminal_title()}>
          <div role="tablist" aria-label={m.terminal_sessions()} className="flex flex-wrap items-end gap-1 border-b border-line">
            {tabs.map((t) => (
              <div key={t.id} className={`-mb-px flex items-center gap-2 rounded-t-[8px] border px-3 py-1.5 text-[13px] ${active === t.id ? 'border-edge border-b-[#0d1117] bg-[#0d1117]' : 'border-line text-subtle'}`}>
                <button type="button" role="tab" aria-selected={active === t.id} className="flex items-center gap-2" onClick={() => setActive(t.id)}>
                  {t.kind === 'container' && <span className="rounded-[4px] bg-[#b4a0ff] px-1 text-[10px] font-semibold text-bg">CT</span>}
                  <span className="font-mono">{t.label}</span>
                </button>
                <button type="button" className="text-muted hover:text-fg" aria-label={m.terminal_closeTab({ label: t.label })} onClick={() => void closeTab(t.id)}>
                  ×
                </button>
              </div>
            ))}
            {!readonly && (
              <button type="button" className="px-2.5 py-1.5 text-[13px] text-accent" onClick={() => void open({ kind: 'shell' })}>
                {m.terminal_new()}
              </button>
            )}
            <span className="grow" />
            <div className="mb-1.5 flex gap-1.5">
              <button type="button" className="btn sm" onClick={() => setFont((f) => Math.max(10, f - 1))} aria-label={m.terminal_smaller()}>
                A−
              </button>
              <button type="button" className="btn sm" onClick={() => setFont((f) => Math.min(22, f + 1))} aria-label={m.terminal_larger()}>
                A+
              </button>
              <button type="button" className="btn sm" aria-pressed={full} onClick={() => setFull(!full)}>
                {full ? m.terminal_exitFull() : m.terminal_full()}
              </button>
            </div>
          </div>
          {tabs.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-b-[10px] border border-t-0 border-edge p-6">
              <p className="m-0 text-[13px] text-muted">{m.terminal_empty()}</p>
              {!readonly && (
                <button type="button" className="btn primary" onClick={() => void open({ kind: 'shell' })}>
                  {m.terminal_openShell()}
                </button>
              )}
            </div>
          ) : (
            tabs.map((t) => <TerminalView key={t.id} info={t} visible={active === t.id} font={font} full={full} />)
          )}
          <p className="m-0 mt-2 text-[12px] text-muted">{m.terminal_footer({ minutes: state.settings.idleMinutes })}</p>
        </section>
      )}
      {editing && <SettingsDialog settings={state.settings} onClose={() => setEditing(false)} onSaved={(s) => (setState(s), setEditing(false))} />}
    </>
  )
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const EVENT = /^event: (\w+)/m
const DATA = /^data: (.*)$/m

function TerminalView({ info, visible, font, full }: { info: TerminalInfo; visible: boolean; font: number; full: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm | null>(null)
  const fit = useRef<{ fit(): void } | null>(null)
  const [status, setStatus] = useState<'connecting' | 'live' | 'lost' | 'ended'>('connecting')
  const [ctrl, setCtrl] = useState(false)
  const ctrlRef = useRef(false)
  const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
  const queue = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abort = useRef<AbortController | null>(null)

  const send = useCallback(
    (data: string) => {
      queue.current += data
      if (timer.current) return
      // typing arrives in small batches, not one request per key
      timer.current = setTimeout(() => {
        const d = queue.current
        queue.current = ''
        timer.current = null
        void post({ action: 'input', id: info.id, data: d }).catch(() => setStatus('lost'))
      }, 8)
    },
    [info.id],
  )

  const connect = useCallback(async () => {
    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac
    setStatus('connecting')
    try {
      const res = await fetch(`/api/terminal/stream?id=${encodeURIComponent(info.id)}`, { signal: ac.signal, headers: csrfHeaders(), credentials: 'same-origin' })
      if (!res.ok || !res.body) throw new Error(String(res.status))
      term.current?.reset()
      setStatus('live')
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const ev = EVENT.exec(block)?.[1]
          const data = DATA.exec(block)?.[1] ?? ''
          if (ev === 'data') term.current?.write(b64(data))
          else if (ev === 'exit') {
            term.current?.write(`\r\n\x1b[2m${m.terminal_ended()}\x1b[0m\r\n`)
            setStatus('ended')
            return
          }
        }
      }
      setStatus('lost')
    } catch {
      if (!ac.signal.aborted) setStatus('lost')
    }
  }, [info.id])

  useEffect(() => {
    let disposed = false
    let ro: ResizeObserver | undefined
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      if (disposed || !box.current) return
      const t = new Terminal({ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: font, cursorBlink: true, scrollback: 5000, theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#c9d1d9', selectionBackground: '#264f78' } })
      const f = new FitAddon()
      t.loadAddon(f)
      t.open(box.current)
      term.current = t
      fit.current = f
      f.fit()
      t.onData((d) => {
        if (ctrlRef.current && d.length === 1) {
          ctrlRef.current = false
          setCtrl(false)
          send(ctrlKey(d) ?? d)
        } else send(d)
      })
      t.onResize(({ cols, rows }) => {
        clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => void post({ action: 'resize', id: info.id, cols, rows }).catch(() => {}), 150)
      })
      ro = new ResizeObserver(() => {
        if (box.current?.offsetParent) f.fit()
      })
      ro.observe(box.current)
      void post({ action: 'resize', id: info.id, cols: t.cols, rows: t.rows }).catch(() => {})
      void connect()
    })()
    return () => {
      disposed = true
      ro?.disconnect()
      abort.current?.abort()
      term.current?.dispose()
      term.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.id])

  useEffect(() => {
    if (!term.current) return
    term.current.options.fontSize = font
    fit.current?.fit()
  }, [font, full])
  useEffect(() => {
    if (visible) {
      fit.current?.fit()
      term.current?.focus()
    }
  }, [visible])

  const key = (k: keyof typeof KEYS) => {
    send(KEYS[k]!)
    term.current?.focus()
  }

  return (
    <div className={visible ? 'flex min-h-0 flex-col' : 'hidden'} data-testid="terminal-view">
      <div className="relative rounded-b-[10px] border border-t-0 border-edge bg-[#0d1117] p-2">
        <div ref={box} className={full ? 'h-[calc(100vh-150px)]' : 'h-[60vh] min-h-[320px]'} aria-label={m.terminal_screen({ label: info.label })} />
        {status === 'lost' && (
          <div className="absolute inset-x-0 bottom-3 flex justify-center">
            <button type="button" className="btn sm primary" onClick={() => void connect()}>
              {m.terminal_reconnect()}
            </button>
          </div>
        )}
      </div>
      {coarse && status === 'live' && (
        <div role="toolbar" aria-label={m.terminal_keys()} className="mt-1.5 grid grid-cols-7 gap-1">
          <button type="button" className="btn sm" onClick={() => key('Esc')}>
            Esc
          </button>
          <button
            type="button"
            className={`btn sm ${ctrl ? 'primary' : ''}`}
            aria-pressed={ctrl}
            onClick={() => {
              ctrlRef.current = !ctrl
              setCtrl(!ctrl)
              term.current?.focus()
            }}
          >
            Strg
          </button>
          <button type="button" className="btn sm" onClick={() => key('Tab')}>
            Tab
          </button>
          {(['Left', 'Up', 'Down', 'Right'] as const).map((k) => (
            <button key={k} type="button" className="btn sm" onClick={() => key(k)} aria-label={k}>
              {{ Left: '←', Up: '↑', Down: '↓', Right: '→' }[k]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SettingsFields({ s, set }: { s: TerminalSettings; set: (s: TerminalSettings) => void }) {
  return (
    <>
      <label className="flex items-start gap-2.5 text-[13px]">
        <input type="checkbox" className="mt-0.5" checked={s.enabled} onChange={(e) => set({ ...s, enabled: e.target.checked })} />
        <span>
          <span className="font-medium">{m.terminal_enable()}</span>
          <span className="block text-[12px] text-muted">{m.terminal_enableHelp()}</span>
        </span>
      </label>
      <label className="flex items-start gap-2.5 pl-6 text-[13px]">
        <input type="checkbox" className="mt-0.5" checked={s.localOnly} onChange={(e) => set({ ...s, localOnly: e.target.checked })} />
        <span>
          {m.terminal_localOnly()}
          <span className="block text-[12px] text-muted">{m.terminal_localOnlyHelp()}</span>
        </span>
      </label>
      <label className="flex flex-col gap-1.5 pl-6 text-[13px]">
        {m.terminal_idle()}
        <select className="field w-48" value={s.idleMinutes} onChange={(e) => set({ ...s, idleMinutes: Number(e.target.value) as IdleMinutes })}>
          {IDLE_MINUTES.map((n) => (
            <option key={n} value={n}>
              {n < 60 ? m.terminal_minutes({ n }) : m.terminal_hours({ n: n / 60 })}
            </option>
          ))}
        </select>
      </label>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-12 text-[12px] text-muted">
        <li>{m.terminal_rule_user()}</li>
        <li>{m.terminal_rule_container()}</li>
        <li>{m.terminal_rule_end()}</li>
        <li>{m.terminal_rule_journal()}</li>
      </ul>
    </>
  )
}

function useSave(onSaved: (s: State) => void) {
  const guarded = useGuardedApi()
  const say = useToast()
  return async (s: TerminalSettings) => {
    try {
      const r = await guarded<State>('/api/terminal', { body: { action: 'settings', ...s } })
      if (r) {
        say(r.settings.enabled ? m.terminal_savedOn() : m.terminal_savedOff())
        onSaved(r)
      }
    } catch (e) {
      say((e as Error).message, 'bad')
    }
  }
}

function SettingsCard({ settings, readonly, onSaved }: { settings: TerminalSettings; readonly: boolean; onSaved: (s: State) => void }) {
  const [s, set] = useState(settings)
  const save = useSave(onSaved)
  return (
    <section className="panel flex flex-col gap-3 p-[18px]" aria-label={m.terminal_settingsTitle()}>
      <h2 className="h2">{m.terminal_settingsTitle()}</h2>
      <p className="m-0 text-[13px] text-muted">{m.terminal_offText()}</p>
      <SettingsFields s={s} set={set} />
      {!readonly && (
        <div className="flex justify-end">
          <button type="button" className="btn primary" onClick={() => void save(s)}>
            {m.common_save()}
          </button>
        </div>
      )}
    </section>
  )
}

function SettingsDialog({ settings, onClose, onSaved }: { settings: TerminalSettings; onClose: () => void; onSaved: (s: State) => void }) {
  const [s, set] = useState(settings)
  const save = useSave(onSaved)
  return (
    <Modal open title={m.terminal_settingsTitle()} onClose={onClose}>
      <SettingsFields s={s} set={set} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_cancel()}
        </button>
        <button type="button" className="btn primary" onClick={() => void save(s)}>
          {m.common_save()}
        </button>
      </div>
    </Modal>
  )
}
