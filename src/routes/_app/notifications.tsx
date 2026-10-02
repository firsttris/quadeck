import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { ConfirmDialog, Modal } from '~/components/Modal'
import { PageHeader } from '~/components/PageHeader'
import { Pill, type Tone } from '~/components/Status'
import { useToast } from '~/components/Toast'
import { api } from '~/lib/api'
import { relative } from '~/lib/format'
import { CHANNEL_KINDS, RULES, channelErrors, channelTarget, type Channel, type ChannelKind, type NotifySettings, type NotifyState, type SentNotice, type Severity } from '~/shared/notify'

export const Route = createFileRoute('/_app/notifications')({
  head: () => ({ meta: [{ title: 'Benachrichtigungen · Quadeck' }] }),
  component: NotificationsPage,
})

const TONE: Record<Severity, Tone> = { critical: 'bad', warning: 'warn', info: 'idle', ok: 'ok' }

function NotificationsPage() {
  const [state, setState] = useState<NotifyState | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Channel | null>(null)
  const [removing, setRemoving] = useState<Channel | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const say = useToast()

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/notifications')
      const d = (await r.json()) as NotifyState & { error?: string }
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setState(d)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(load, 20_000)
    return () => clearInterval(t)
  }, [load])

  const save = async (settings: NotifySettings, done: string) => {
    try {
      setState(await api<NotifyState>('/api/notifications', { body: { settings } }))
      say(done)
      return true
    } catch (e) {
      say((e as Error).message, 'bad')
      return false
    }
  }

  const test = async (c: Channel) => {
    setBusy(c.id)
    try {
      const r = await api<NotifyState & { sent: SentNotice }>('/api/notifications', { body: { test: c } })
      setState(r)
      const res = r.sent.results[0]
      if (res?.ok) say(`Testnachricht an ${c.name} gesendet`)
      else say(`${c.name}: ${res?.error ?? 'fehlgeschlagen'}`, 'bad')
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setBusy(null)
    }
  }

  const s = state?.settings
  return (
    <>
      <PageHeader title="Benachrichtigungen" subtitle="Der Server meldet sich, wenn etwas nicht stimmt – aufs Handy oder in den Chat" />
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!state && !error && <p className="m-0 text-muted">Wird geladen …</p>}
      {s && state && (
        <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
          <div className="flex flex-col gap-[18px]">
            <section className="panel flex flex-col gap-3 p-[18px]" aria-label="Kanäle">
              <div className="flex items-center gap-2">
                <h2 className="h2 grow">Kanäle</h2>
                <button type="button" className="btn primary sm" disabled={s.channels.length >= 10} onClick={() => setEditing({ id: '', kind: 'ntfy', name: 'Handy (ntfy)', enabled: true, url: 'https://ntfy.sh', topic: '' })}>
                  + Kanal
                </button>
              </div>
              {s.channels.length === 0 && <p className="m-0 text-[13px] text-muted">Noch kein Kanal – ohne Kanal wird nichts verschickt. Am einfachsten: ntfy-App installieren, Thema ausdenken, hier eintragen.</p>}
              {s.channels.map((c) => (
                <div key={c.id} data-testid="channel" className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2.5">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`${c.name} aktiv`}
                    checked={c.enabled}
                    onChange={(e) => void save({ ...s, channels: s.channels.map((x) => (x.id === c.id ? { ...x, enabled: e.target.checked } : x)) }, `${c.name} ${e.target.checked ? 'aktiv' : 'pausiert'}`)}
                  />
                  <div className="min-w-0 grow">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      <span className="chip">{CHANNEL_KINDS.find((k) => k.kind === c.kind)?.label}</span>
                    </div>
                    <div className="truncate font-mono text-[12px] text-subtle">{channelTarget(c)}</div>
                  </div>
                  <button type="button" className="btn sm" disabled={busy === c.id} onClick={() => void test(c)} aria-label={`Testnachricht an ${c.name}`}>
                    {busy === c.id ? 'Sende …' : 'Test'}
                  </button>
                  <button type="button" className="btn sm" onClick={() => setEditing(c)} aria-label={`${c.name} bearbeiten`}>
                    Bearbeiten
                  </button>
                  <button type="button" className="btn sm danger" onClick={() => setRemoving(c)} aria-label={`${c.name} entfernen`}>
                    Entfernen
                  </button>
                </div>
              ))}
            </section>

            <Rules settings={s} onSave={(n) => save(n, 'Gespeichert')} />
          </div>

          <div className="flex flex-col gap-[18px]">
            <section className="panel flex flex-col gap-2 p-[18px]" aria-label="Gemeldete Probleme">
              <h2 className="h2">Gemeldete Probleme</h2>
              {state.active.length === 0 && <p className="m-0 text-[13px] text-muted">Nichts offen.</p>}
              {state.active.map((a) => (
                <div key={a.key} data-testid="active-alert" className="flex items-start gap-2 border-t border-line pt-2 text-[13px] first-of-type:border-0">
                  <Pill tone={a.severity === 'critical' ? 'bad' : 'warn'}>{a.severity === 'critical' ? 'kritisch' : 'Warnung'}</Pill>
                  <div className="min-w-0 grow">
                    <div>{a.title}</div>
                    {a.detail && <div className="text-[12px] text-muted">{a.detail}</div>}
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-subtle" suppressHydrationWarning>
                    {relative(a.since)}
                  </span>
                </div>
              ))}
              <p className="m-0 text-[11px] text-subtle">Jedes Problem wird einmal gemeldet; ist es behoben, kommt {s.recovery ? 'eine Entwarnung' : 'keine weitere Nachricht'}.</p>
            </section>

            <section className="panel flex flex-col gap-2 p-[18px]" aria-label="Zuletzt gesendet">
              <h2 className="h2">Zuletzt gesendet</h2>
              {state.log.length === 0 && <p className="m-0 text-[13px] text-muted">Noch nichts gesendet.</p>}
              {state.log.slice(0, 15).map((n, i) => (
                <div key={i} data-testid="sent" className="flex flex-col gap-1 border-t border-line pt-2 text-[13px] first-of-type:border-0">
                  <div className="flex items-center gap-2">
                    <Pill tone={TONE[n.severity]}>{n.test ? 'Test' : n.severity === 'ok' ? 'Entwarnung' : n.severity === 'info' ? 'Info' : n.severity === 'critical' ? 'kritisch' : 'Warnung'}</Pill>
                    <span className="min-w-0 grow truncate font-medium">{n.title}</span>
                    <span className="shrink-0 font-mono text-[11px] text-subtle" suppressHydrationWarning>
                      {relative(n.ts)}
                    </span>
                  </div>
                  {n.body && <div className="text-[12px] whitespace-pre-line text-muted">{n.body}</div>}
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    {n.results.map((r, j) => (
                      <span key={j} className={r.ok ? 'text-[#7ee2a8]' : 'text-[#ff8a80]'} title={r.error}>
                        {r.ok ? '✓' : '✗'} {r.channel}
                        {r.error ? `: ${r.error}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          </div>
        </div>
      )}
      {editing && s && (
        <ChannelDialog
          channel={editing}
          onClose={() => setEditing(null)}
          onSave={async (c) => {
            const channels = c.id ? s.channels.map((x) => (x.id === c.id ? c : x)) : [...s.channels, c]
            if (await save({ ...s, channels }, `${c.name} gespeichert`)) setEditing(null)
          }}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        title={`${removing?.name} entfernen?`}
        danger
        confirm="Entfernen"
        body={<p className="m-0">An diesen Kanal wird nichts mehr gesendet.</p>}
        onConfirm={() => s && removing && void save({ ...s, channels: s.channels.filter((c) => c.id !== removing.id) }, `${removing.name} entfernt`)}
        onClose={() => setRemoving(null)}
      />
    </>
  )
}

function Rules({ settings, onSave }: { settings: NotifySettings; onSave: (s: NotifySettings) => Promise<boolean> }) {
  const [draft, setDraft] = useState(settings)
  useEffect(() => setDraft(settings), [settings])
  const dirty = JSON.stringify({ ...draft, channels: [] }) !== JSON.stringify({ ...settings, channels: [] })
  return (
    <section className="panel flex flex-col gap-3 p-[18px]" aria-label="Wann benachrichtigen">
      <h2 className="h2">Wann benachrichtigen?</h2>
      {RULES.map((r) => (
        <label key={r.key} className="flex items-start gap-2.5 text-[13px]">
          <input type="checkbox" className="mt-0.5" checked={draft.rules[r.key]} onChange={(e) => setDraft({ ...draft, rules: { ...draft.rules, [r.key]: e.target.checked } })} />
          <span className="flex flex-col">
            <span className="font-medium">{r.label}</span>
            <span className="text-[12px] text-muted">{r.help}</span>
            {r.key === 'disk-full' && (
              <span className="mt-1 flex items-center gap-2 text-[12px] text-muted">
                ab
                <input
                  className="field w-[70px]"
                  type="number"
                  min={50}
                  max={99}
                  aria-label="Schwellwert in Prozent"
                  value={draft.diskThreshold}
                  onChange={(e) => setDraft({ ...draft, diskThreshold: Math.min(99, Math.max(50, Number(e.target.value) || 90)) })}
                />
                % Belegung
              </span>
            )}
            {r.key === 'updates' && (
              <span className="mt-1 flex items-center gap-2 text-[12px] text-muted">
                ab
                <select className="field w-[90px]" aria-label="Uhrzeit für Updates" value={draft.updatesHour} onChange={(e) => setDraft({ ...draft, updatesHour: Number(e.target.value) })}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
                Uhr
              </span>
            )}
          </span>
        </label>
      ))}
      <label className="flex items-center gap-2.5 border-t border-line pt-3 text-[13px]">
        <input type="checkbox" checked={draft.recovery} onChange={(e) => setDraft({ ...draft, recovery: e.target.checked })} />
        Entwarnung schicken, wenn ein Problem behoben ist
      </label>
      <div className="flex justify-end gap-2">
        {dirty && (
          <button type="button" className="btn sm" onClick={() => setDraft(settings)}>
            Verwerfen
          </button>
        )}
        <button type="button" className="btn primary sm" disabled={!dirty} onClick={() => void onSave({ ...settings, rules: draft.rules, diskThreshold: draft.diskThreshold, recovery: draft.recovery, updatesHour: draft.updatesHour })}>
          Speichern
        </button>
      </div>
    </section>
  )
}

const DEFAULTS: Record<ChannelKind, Partial<Channel>> = {
  ntfy: { name: 'Handy (ntfy)', url: 'https://ntfy.sh', topic: '' },
  gotify: { name: 'Gotify', url: 'https://' },
  telegram: { name: 'Telegram', url: 'https://api.telegram.org', chatId: '' },
  webhook: { name: 'Webhook', url: 'https://' },
}

function ChannelDialog({ channel, onClose, onSave }: { channel: Channel; onClose: () => void; onSave: (c: Channel) => Promise<void> }) {
  const [c, setC] = useState(channel)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<Channel>) => setC((x) => ({ ...x, ...patch }))
  const errors = channelErrors({ ...c, url: c.kind === 'telegram' ? 'https://api.telegram.org' : c.url })
  const kind = CHANNEL_KINDS.find((k) => k.kind === c.kind)!
  const tokenLabel = c.kind === 'ntfy' ? 'Zugangstoken (optional, für geschützte Themen)' : c.kind === 'gotify' ? 'App-Token' : 'Bot-Token'
  return (
    <Modal open onClose={onClose} title={channel.id ? `${channel.name} bearbeiten` : 'Neuer Kanal'}>
      {!channel.id && (
        <div role="group" aria-label="Art" className="flex flex-wrap gap-1.5">
          {CHANNEL_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              className={`seg ${c.kind === k.kind ? 'on' : ''}`}
              aria-pressed={c.kind === k.kind}
              onClick={() => setC({ id: '', kind: k.kind, enabled: true, name: '', url: '', ...DEFAULTS[k.kind] } as Channel)}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
      <p className="m-0 text-[13px] text-muted">{kind.help}</p>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
        Name
        <input className="field" value={c.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      {c.kind !== 'telegram' && (
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {c.kind === 'webhook' ? 'Webhook-URL' : 'Server'}
          <input className="field font-mono" value={c.url} onChange={(e) => set({ url: e.target.value.trim() })} placeholder={c.kind === 'ntfy' ? 'https://ntfy.sh' : 'https://…'} />
        </label>
      )}
      {c.kind === 'ntfy' && (
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          Thema
          <input className="field font-mono" value={c.topic ?? ''} onChange={(e) => set({ topic: e.target.value.trim() })} placeholder="mein-server-a8f3k2" />
          <span className="font-normal">Auf ntfy.sh kann jeder ein Thema abonnieren, der den Namen kennt – also einen schwer zu ratenden Namen wählen.</span>
        </label>
      )}
      {c.kind !== 'webhook' && (
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {tokenLabel}
          <input className="field font-mono" type="password" autoComplete="off" value={c.token ?? ''} onChange={(e) => set({ token: e.target.value.trim() || undefined })} />
        </label>
      )}
      {c.kind === 'telegram' && (
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          Chat-ID
          <input className="field font-mono" value={c.chatId ?? ''} onChange={(e) => set({ chatId: e.target.value.trim() })} placeholder="123456789" />
        </label>
      )}
      {errors.length > 0 && c.name && <p className="m-0 text-[12px] text-[#e3b341]">{errors.join(' · ')}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          Abbrechen
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || errors.length > 0}
          onClick={async () => {
            setBusy(true)
            await onSave(c)
            setBusy(false)
          }}
        >
          Speichern
        </button>
      </div>
    </Modal>
  )
}
