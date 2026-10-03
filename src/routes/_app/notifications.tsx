import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { ConfirmDialog, Modal } from '~/components/Modal'
import { PageHeader } from '~/components/PageHeader'
import { Pill, type Tone } from '~/components/Status'
import { useToast } from '~/components/Toast'
import { api } from '~/lib/api'
import { relative } from '~/lib/format'
import { msg } from '~/shared/i18n'
import { channelKinds, rules as ruleList, smtpPresets, channelErrors, channelTarget, type Channel, type ChannelKind, type NotifySettings, type NotifyState, type SentNotice, type Severity } from '~/shared/notify'
import { m } from '~/paraglide/messages'
import { pickMsg } from '~/i18n'

export const Route = createFileRoute('/_app/notifications')({
  head: () => ({ meta: [{ title: msg('page_title_notifications') }] }),
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
      if (res?.ok) say(m.notifications_testSent({ name: c.name }))
      else say(`${c.name}: ${res?.error ?? m.notifications_failed()}`, 'bad')
    } catch (e) {
      say((e as Error).message, 'bad')
    } finally {
      setBusy(null)
    }
  }

  const s = state?.settings
  return (
    <>
      <PageHeader title={m.notifications_title()} subtitle={m.notifications_subtitle()} />
      {error && <p className="m-0 text-[13px] text-[#e3b341]">{error}</p>}
      {!state && !error && <p className="m-0 text-muted">{m.notifications_loading()}</p>}
      {s && state && (
        <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
          <div className="flex flex-col gap-[18px]">
            <section className="panel flex flex-col gap-3 p-[18px]" aria-label={m.notifications_channels_title()}>
              <div className="flex items-center gap-2">
                <h2 className="h2 grow">{m.notifications_channels_title()}</h2>
                <button
                  type="button"
                  className="btn primary sm"
                  disabled={s.channels.length >= 10}
                  onClick={() => setEditing({ id: '', kind: 'ntfy', name: m.notifications_defaults_ntfy(), enabled: true, url: 'https://ntfy.sh', topic: '' })}
                >
                  {m.notifications_channels_add()}
                </button>
              </div>
              {s.channels.length === 0 && <p className="m-0 text-[13px] text-muted">{m.notifications_channels_none()}</p>}
              {s.channels.map((c) => (
                <div key={c.id} data-testid="channel" className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2.5">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={m.notifications_channels_enabledLabel({ name: c.name })}
                    checked={c.enabled}
                    onChange={(e) => void save({ ...s, channels: s.channels.map((x) => (x.id === c.id ? { ...x, enabled: e.target.checked } : x)) }, m.notifications_channels_toggled({ name: c.name, on: String(!!e.target.checked) }))}
                  />
                  <div className="min-w-0 grow">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      <span className="chip">{channelKinds().find((k) => k.kind === c.kind)?.label}</span>
                    </div>
                    <div className="truncate font-mono text-[12px] text-subtle">{channelTarget(c)}</div>
                  </div>
                  <button type="button" className="btn sm" disabled={busy === c.id} onClick={() => void test(c)} aria-label={m.notifications_channels_testLabel({ name: c.name })}>
                    {busy === c.id ? m.notifications_channels_sending() : m.notifications_channels_test()}
                  </button>
                  <button type="button" className="btn sm" onClick={() => setEditing(c)} aria-label={m.notifications_channels_editLabel({ name: c.name })}>
                    {m.notifications_channels_edit()}
                  </button>
                  <button type="button" className="btn sm danger" onClick={() => setRemoving(c)} aria-label={m.notifications_channels_removeLabel({ name: c.name })}>
                    {m.notifications_channels_remove()}
                  </button>
                </div>
              ))}
            </section>

            <Rules settings={s} onSave={(n) => save(n, m.notifications_saved())} />
          </div>

          <div className="flex flex-col gap-[18px]">
            <section className="panel flex flex-col gap-2 p-[18px]" aria-label={m.notifications_active_title()}>
              <h2 className="h2">{m.notifications_active_title()}</h2>
              {state.active.length === 0 && <p className="m-0 text-[13px] text-muted">{m.notifications_active_none()}</p>}
              {state.active.map((a) => (
                <div key={a.key} data-testid="active-alert" className="flex items-start gap-2 border-t border-line pt-2 text-[13px] first-of-type:border-0">
                  <Pill tone={a.severity === 'critical' ? 'bad' : 'warn'}>{a.severity === 'critical' ? m.notifications_severity_critical() : m.notifications_severity_warning()}</Pill>
                  <div className="min-w-0 grow">
                    <div>{a.title}</div>
                    {a.detail && <div className="text-[12px] text-muted">{a.detail}</div>}
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-subtle" suppressHydrationWarning>
                    {relative(a.since)}
                  </span>
                </div>
              ))}
              <p className="m-0 text-[11px] text-subtle">{m.notifications_active_footer({ recovery: String(!!s.recovery) })}</p>
            </section>

            <section className="panel flex flex-col gap-2 p-[18px]" aria-label={m.notifications_log_title()}>
              <h2 className="h2">{m.notifications_log_title()}</h2>
              {state.log.length === 0 && <p className="m-0 text-[13px] text-muted">{m.notifications_log_none()}</p>}
              {state.log.slice(0, 15).map((n, i) => (
                <div key={i} data-testid="sent" className="flex flex-col gap-1 border-t border-line pt-2 text-[13px] first-of-type:border-0">
                  <div className="flex items-center gap-2">
                    <Pill tone={TONE[n.severity]}>
                      {n.test
                        ? m.notifications_severity_test()
                        : pickMsg(
                            { critical: m.notifications_severity_critical, warning: m.notifications_severity_warning, ok: m.notifications_severity_ok, info: m.notifications_severity_info, test: m.notifications_severity_test },
                            n.severity,
                          )}
                    </Pill>
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
            if (await save({ ...s, channels }, m.notifications_channels_saved({ name: c.name }))) setEditing(null)
          }}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        title={m.notifications_channels_removeTitle({ name: `${removing?.name}` })}
        danger
        confirm={m.notifications_channels_remove()}
        body={<p className="m-0">{m.notifications_channels_removeBody()}</p>}
        onConfirm={() => s && removing && void save({ ...s, channels: s.channels.filter((c) => c.id !== removing.id) }, m.notifications_channels_removed({ name: removing.name }))}
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
    <section className="panel flex flex-col gap-3 p-[18px]" aria-label={m.notifications_rules_label()}>
      <h2 className="h2">{m.notifications_rules_title()}</h2>
      {ruleList().map((r) => (
        <label key={r.key} className="flex items-start gap-2.5 text-[13px]">
          <input type="checkbox" className="mt-0.5" checked={draft.rules[r.key]} onChange={(e) => setDraft({ ...draft, rules: { ...draft.rules, [r.key]: e.target.checked } })} />
          <span className="flex flex-col">
            <span className="font-medium">{r.label}</span>
            <span className="text-[12px] text-muted">{r.help}</span>
            {r.key === 'disk-full' && (
              <span className="mt-1 flex items-center gap-2 text-[12px] text-muted">
                {m.notifications_rules_from()}
                <input
                  className="field w-[70px]"
                  type="number"
                  min={50}
                  max={99}
                  aria-label={m.notifications_rules_threshold()}
                  value={draft.diskThreshold}
                  onChange={(e) => setDraft({ ...draft, diskThreshold: Math.min(99, Math.max(50, Number(e.target.value) || 90)) })}
                />
                {m.notifications_rules_usage()}
              </span>
            )}
            {r.key === 'updates' && (
              <span className="mt-1 flex items-center gap-2 text-[12px] text-muted">
                {m.notifications_rules_from()}
                <select className="field w-[90px]" aria-label={m.notifications_rules_hour()} value={draft.updatesHour} onChange={(e) => setDraft({ ...draft, updatesHour: Number(e.target.value) })}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
                {m.notifications_rules_oclock()}
              </span>
            )}
          </span>
        </label>
      ))}
      <label className="flex items-center gap-2.5 border-t border-line pt-3 text-[13px]">
        <input type="checkbox" checked={draft.recovery} onChange={(e) => setDraft({ ...draft, recovery: e.target.checked })} />
        {m.notifications_rules_recovery()}
      </label>
      <div className="flex justify-end gap-2">
        {dirty && (
          <button type="button" className="btn sm" onClick={() => setDraft(settings)}>
            {m.notifications_rules_discard()}
          </button>
        )}
        <button type="button" className="btn primary sm" disabled={!dirty} onClick={() => void onSave({ ...settings, rules: draft.rules, diskThreshold: draft.diskThreshold, recovery: draft.recovery, updatesHour: draft.updatesHour })}>
          {m.notifications_rules_save()}
        </button>
      </div>
    </section>
  )
}

const defaults = (): Record<ChannelKind, Partial<Channel>> => ({
  ntfy: { name: m.notifications_defaults_ntfy(), url: 'https://ntfy.sh', topic: '' },
  gotify: { name: 'Gotify', url: 'https://' },
  telegram: { name: 'Telegram', url: 'https://api.telegram.org', chatId: '' },
  webhook: { name: 'Webhook', url: 'https://' },
  email: { name: m.notifications_defaults_email(), url: '', host: '', port: 587, security: 'starttls', user: '', from: '', to: '' },
})

function EmailFields({ c, set }: { c: Channel; set: (p: Partial<Channel>) => void }) {
  const field = 'flex flex-col gap-1 text-[12px] font-medium text-muted'
  const presets = smtpPresets()
  const preset = presets.find((p) => p.host === c.host && p.host)
  return (
    <>
      <div role="group" aria-label={m.notifications_email_provider()} className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`seg ${(preset ? preset.label === p.label : !p.host) ? 'on' : ''}`}
            aria-pressed={preset ? preset.label === p.label : !p.host}
            onClick={() => set({ host: p.host, port: p.port, security: p.security })}
          >
            {p.label}
          </button>
        ))}
      </div>
      {preset?.note && <p className="m-0 text-[12px] text-muted">{preset.note}</p>}
      <div className="grid grid-cols-[1fr_96px] gap-3">
        <label className={field}>
          {m.notifications_email_server()}
          <input className="field font-mono" value={c.host ?? ''} onChange={(e) => set({ host: e.target.value.trim() })} placeholder="smtp.example.org" />
        </label>
        <label className={field}>
          {m.notifications_email_port()}
          <input className="field font-mono" inputMode="numeric" value={c.port ?? ''} onChange={(e) => set({ port: Number(e.target.value) || undefined })} />
        </label>
      </div>
      <label className={field}>
        {m.notifications_email_security()}
        <select className="field" value={c.security ?? 'starttls'} onChange={(e) => set({ security: e.target.value as Channel['security'] })}>
          {(['tls', 'starttls', 'none'] as const).map((s) => (
            <option key={s} value={s}>
              {pickMsg({ tls: m.notifications_security_tls, starttls: m.notifications_security_starttls, none: m.notifications_security_none }, s)}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className={field}>
          {m.notifications_email_user()}
          <input className="field font-mono" autoComplete="off" value={c.user ?? ''} onChange={(e) => set({ user: e.target.value.trim() })} onBlur={() => !c.from && c.user?.includes('@') && set({ from: c.user })} />
        </label>
        <label className={field}>
          {m.notifications_email_password()}
          <input className="field font-mono" type="password" autoComplete="new-password" value={c.token ?? ''} onChange={(e) => set({ token: e.target.value || undefined })} />
        </label>
      </div>
      <label className={field}>
        {m.notifications_email_from()}
        <input className="field font-mono" value={c.from ?? ''} onChange={(e) => set({ from: e.target.value.trim() })} placeholder="server@example.org" />
        <span className="font-normal">{m.notifications_email_fromHelp()}</span>
      </label>
      <label className={field}>
        {m.notifications_email_to()}
        <input className="field font-mono" value={c.to ?? ''} onChange={(e) => set({ to: e.target.value })} placeholder={m.notifications_email_toPlaceholder()} />
      </label>
    </>
  )
}

function ChannelDialog({ channel, onClose, onSave }: { channel: Channel; onClose: () => void; onSave: (c: Channel) => Promise<void> }) {
  const [c, setC] = useState(channel)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<Channel>) => setC((x) => ({ ...x, ...patch }))
  const errors = channelErrors({ ...c, url: c.kind === 'telegram' ? 'https://api.telegram.org' : c.url })
  const kinds = channelKinds()
  const kind = kinds.find((k) => k.kind === c.kind)!
  const tokenLabel = c.kind === 'ntfy' ? m.notifications_dialog_ntfyToken() : c.kind === 'gotify' ? m.notifications_dialog_appToken() : m.notifications_dialog_botToken()
  return (
    <Modal open onClose={onClose} title={channel.id ? m.notifications_dialog_editTitle({ name: channel.name }) : m.notifications_dialog_newTitle()}>
      {!channel.id && (
        <div role="group" aria-label={m.notifications_dialog_kind()} className="flex flex-wrap gap-1.5">
          {kinds.map((k) => (
            <button
              key={k.kind}
              type="button"
              className={`seg ${c.kind === k.kind ? 'on' : ''}`}
              aria-pressed={c.kind === k.kind}
              onClick={() => setC({ id: '', kind: k.kind, enabled: true, name: '', url: '', ...defaults()[k.kind] } as Channel)}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
      <p className="m-0 text-[13px] text-muted">{kind.help}</p>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
        {m.notifications_dialog_name()}
        <input className="field" value={c.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      {c.kind === 'email' && <EmailFields c={c} set={set} />}
      {c.kind !== 'telegram' && c.kind !== 'email' && (
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {c.kind === 'webhook' ? m.notifications_dialog_webhookUrl() : m.notifications_dialog_server()}
          <input className="field font-mono" value={c.url} onChange={(e) => set({ url: e.target.value.trim() })} placeholder={c.kind === 'ntfy' ? 'https://ntfy.sh' : 'https://…'} />
        </label>
      )}
      {c.kind === 'ntfy' && (
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {m.notifications_dialog_topic()}
          <input className="field font-mono" value={c.topic ?? ''} onChange={(e) => set({ topic: e.target.value.trim() })} placeholder={m.notifications_dialog_topicPlaceholder()} />
          <span className="font-normal">{m.notifications_dialog_topicHelp()}</span>
        </label>
      )}
      {c.kind !== 'webhook' && c.kind !== 'email' && (
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {tokenLabel}
          <input className="field font-mono" type="password" autoComplete="off" value={c.token ?? ''} onChange={(e) => set({ token: e.target.value.trim() || undefined })} />
        </label>
      )}
      {c.kind === 'telegram' && (
        <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
          {m.notifications_dialog_chatId()}
          <input className="field font-mono" value={c.chatId ?? ''} onChange={(e) => set({ chatId: e.target.value.trim() })} placeholder="123456789" />
        </label>
      )}
      {errors.length > 0 && c.name && <p className="m-0 text-[12px] text-[#e3b341]">{errors.join(' · ')}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          {m.common_cancel()}
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
          {m.notifications_dialog_save()}
        </button>
      </div>
    </Modal>
  )
}
