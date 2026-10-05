// Notifications: settings, the problems worth a message (derived from the
// snapshot) and how a message is sent to ntfy, Gotify, Telegram, a webhook or by e-mail.
// Pure functions, shared by the server and the settings page.

import { localize, msg } from './i18n'
import { m } from '~/paraglide/messages'
import type { Snapshot } from './types'

export type ChannelKind = 'ntfy' | 'gotify' | 'telegram' | 'webhook' | 'email'

export type SmtpSecurity = 'tls' | 'starttls' | 'none'

export interface Channel {
  id: string
  kind: ChannelKind
  name: string
  enabled: boolean
  /** Server (ntfy, Gotify) or webhook URL; unused for Telegram and e-mail. */
  url: string
  /** ntfy topic. */
  topic?: string
  /** ntfy access token, Gotify app token, Telegram bot token, SMTP password. */
  token?: string
  /** Telegram chat id. */
  chatId?: string
  /** E-mail: SMTP server, port, encryption, login, sender and recipients (comma-separated). */
  host?: string
  port?: number
  security?: SmtpSecurity
  user?: string
  from?: string
  to?: string
}

export type RuleKey = 'unit-failed' | 'service-down' | 'container-unhealthy' | 'smart' | 'disk-full' | 'updates' | 'internet' | 'backup' | 'device-new'

export interface NotifySettings {
  channels: Channel[]
  rules: Record<RuleKey, boolean>
  /** Percent. */
  diskThreshold: number
  /** Also send "wieder in Ordnung". */
  recovery: boolean
  /** Hour of the day for the update summary. */
  updatesHour: number
  /** Internet too slow: below `speedPercent` % of the usual (relative) or below `speedMbit` Mbit/s download (fixed). */
  speedMode: 'relative' | 'fixed'
  speedPercent: number
  speedMbit: number
  /** Backup: report when none succeeded for this many days. */
  backupDays: number
}

export type Severity = 'critical' | 'warning' | 'info' | 'ok'

export interface Alert {
  key: string
  rule: RuleKey
  severity: 'critical' | 'warning'
  title: string
  /** What the alert is about (unit, service, container) – for the "running again" message. */
  subject?: string
  detail?: string
}

export interface Notice {
  title: string
  body: string
  severity: Severity
}

export interface SentNotice extends Notice {
  ts: number
  test?: boolean
  results: { channel: string; ok: boolean; error?: string }[]
}

export interface NotifyState {
  settings: NotifySettings
  /** Problems already reported (and not yet resolved). */
  active: (Alert & { since: number })[]
  log: SentNotice[]
}

export const MASK = '••••••••'

export const RULE_KEYS: RuleKey[] = ['unit-failed', 'service-down', 'container-unhealthy', 'smart', 'disk-full', 'updates', 'internet', 'backup', 'device-new']

export const rules = (): { key: RuleKey; label: string; help: string }[] => [
  {
    key: 'unit-failed',
    label: msg(m.notify_rule_unitFailed),
    help: msg(m.notify_rule_unitFailedHelp),
  },
  {
    key: 'service-down',
    label: msg(m.notify_rule_serviceDown),
    help: msg(m.notify_rule_serviceDownHelp),
  },
  {
    key: 'container-unhealthy',
    label: msg(m.notify_rule_containerUnhealthy),
    help: msg(m.notify_rule_containerUnhealthyHelp),
  },
  { key: 'smart', label: msg(m.notify_rule_smart), help: msg(m.notify_rule_smartHelp) },
  { key: 'disk-full', label: msg(m.notify_rule_diskFull), help: msg(m.notify_rule_diskFullHelp) },
  { key: 'internet', label: msg(m.notify_rule_internet), help: msg(m.notify_rule_internetHelp) },
  { key: 'backup', label: msg(m.notify_rule_backup), help: msg(m.notify_rule_backupHelp) },
  { key: 'device-new', label: msg(m.notify_rule_deviceNew), help: msg(m.notify_rule_deviceNewHelp) },
  {
    key: 'updates',
    label: msg(m.notify_rule_updates),
    help: msg(m.notify_rule_updatesHelp),
  },
]

export const CHANNEL_KIND_IDS: ChannelKind[] = ['ntfy', 'gotify', 'telegram', 'webhook', 'email']

export const channelKinds = (): { kind: ChannelKind; label: string; help: string }[] => [
  {
    kind: 'ntfy',
    label: 'ntfy',
    help: msg(m.notify_channel_ntfyHelp),
  },
  { kind: 'gotify', label: 'Gotify', help: msg(m.notify_channel_gotifyHelp) },
  {
    kind: 'telegram',
    label: 'Telegram',
    help: msg(m.notify_channel_telegramHelp),
  },
  {
    kind: 'webhook',
    label: 'Webhook',
    help: msg(m.notify_channel_webhookHelp),
  },
  {
    kind: 'email',
    label: msg(m.notifications_defaults_email),
    help: msg(m.notify_channel_emailHelp),
  },
]

/** Common mail providers: server and port to start from. */
export const smtpPresets = (): { label: string; host: string; port: number; security: SmtpSecurity; note?: string }[] => [
  { label: 'Gmail', host: 'smtp.gmail.com', port: 465, security: 'tls', note: msg(m.notify_provider_gmailNote) },
  { label: 'GMX', host: 'mail.gmx.net', port: 587, security: 'starttls', note: msg(m.notify_provider_gmxNote) },
  { label: 'web.de', host: 'smtp.web.de', port: 587, security: 'starttls', note: msg(m.notify_provider_webdeNote) },
  { label: 'Posteo', host: 'posteo.de', port: 465, security: 'tls' },
  { label: 'mailbox.org', host: 'smtp.mailbox.org', port: 465, security: 'tls' },
  { label: 'iCloud', host: 'smtp.mail.me.com', port: 587, security: 'starttls', note: msg(m.notify_provider_icloudNote) },
  { label: 'Outlook', host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
  { label: msg(m.notify_provider_ownServer), host: '', port: 587, security: 'starttls' },
]

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$|^\[?[0-9a-fA-F:.]+\]?$/
export const recipients = (to: string | undefined) =>
  (to ?? '')
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)

export const defaultSettings = (): NotifySettings => ({
  channels: [],
  rules: { 'unit-failed': true, 'service-down': true, 'container-unhealthy': true, smart: true, 'disk-full': true, updates: true, internet: false, backup: true, 'device-new': false },
  diskThreshold: 90,
  recovery: true,
  updatesHour: 9,
  speedMode: 'relative',
  speedPercent: 50,
  speedMbit: 100,
  backupDays: 2,
})

/** How long a problem must persist before it is reported. */
export const DELAY_MS: Record<RuleKey, number> = { 'unit-failed': 0, 'service-down': 120_000, 'container-unhealthy': 120_000, smart: 0, 'disk-full': 0, updates: 0, internet: 0, backup: 0, 'device-new': 0 }

// ---------- validation ----------

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/
const HTTP_URL = /^https?:\/\/[^\s/?#]+(?::\d+)?(\/[^\s]*)?$/

export function channelErrors(c: Channel): string[] {
  const out: string[] = []
  if (!c.name.trim() || c.name.length > 60 || CONTROL.test(c.name)) out.push(msg(m.notify_error_name))
  if (c.kind !== 'telegram' && c.kind !== 'email' && (!HTTP_URL.test(c.url) || c.url.length > 500)) out.push(msg(m.notify_error_urlScheme))
  if (c.kind === 'email') {
    if (!HOSTNAME.test(c.host ?? '')) out.push(msg(m.notify_error_smtpServer))
    if (!Number.isInteger(c.port) || c.port! < 1 || c.port! > 65535) out.push('Port 1–65535')
    if (!['tls', 'starttls', 'none'].includes(c.security ?? '')) out.push(msg(m.notify_error_encryption))
    if (c.user && (c.user.length > 200 || CONTROL.test(c.user))) out.push(msg(m.notify_error_userName))
    if (c.user && !c.token) out.push(msg(m.notify_error_passwordMissing))
    if (c.token && c.security === 'none') out.push(msg(m.notify_error_passwordUnencrypted))
    if (!EMAIL.test(c.from ?? '')) out.push(msg(m.notify_error_sender))
    const to = recipients(c.to)
    if (!to.length || to.length > 10 || !to.every((x) => EMAIL.test(x))) out.push(msg(m.notify_error_recipients))
  }
  if (c.kind === 'ntfy' && !/^[A-Za-z0-9_-]{1,64}$/.test(c.topic ?? '')) out.push(msg(m.notify_error_topic))
  if ((c.kind === 'gotify' || c.kind === 'telegram') && !c.token) out.push(msg(m.notify_error_tokenMissing))
  if (c.token && (c.token.length > 300 || (c.kind !== 'email' && /\s/.test(c.token)) || CONTROL.test(c.token))) out.push(c.kind === 'email' ? msg(m.notify_error_password) : msg(m.notify_error_token))
  if (c.kind === 'telegram' && !/^(-?\d{1,20}|@[A-Za-z0-9_]{4,64})$/.test(c.chatId ?? '')) out.push(msg(m.notify_error_chatId))
  return out
}

/** Settings from untrusted JSON; tokens shown as MASK are taken from `previous`. */
export function parseSettings(v: unknown, previous: NotifySettings): NotifySettings {
  if (!v || typeof v !== 'object') throw new Error(msg(m.notify_error_settingsMissing))
  const o = v as Record<string, unknown>
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '')
  const rawChannels = Array.isArray(o.channels) ? o.channels : []
  if (rawChannels.length > 10) throw new Error(msg(m.notify_error_tooManyChannels))
  const channels = rawChannels.map((raw, i): Channel => {
    const c = (raw ?? {}) as Record<string, unknown>
    const kind = CHANNEL_KIND_IDS.includes(c.kind as ChannelKind) ? (c.kind as ChannelKind) : 'webhook'
    const id = /^[a-z0-9-]{1,40}$/.test(str(c.id)) ? str(c.id) : `c${Date.now().toString(36)}${i}`
    const old = previous.channels.find((p) => p.id === id)
    const token = str(c.token) === MASK ? old?.token : str(c.token) || undefined
    const ch: Channel = {
      id,
      kind,
      name: str(c.name) || channelKinds().find((k) => k.kind === kind)!.label,
      enabled: c.enabled !== false,
      url: kind === 'telegram' ? 'https://api.telegram.org' : kind === 'email' ? '' : str(c.url).replace(/\/+$/, ''),
      topic: kind === 'ntfy' ? str(c.topic) : undefined,
      token,
      chatId: kind === 'telegram' ? str(c.chatId) : undefined,
      ...(kind === 'email'
        ? {
            host: str(c.host),
            port: Number(c.port),
            security: (['tls', 'starttls', 'none'].includes(str(c.security)) ? str(c.security) : 'starttls') as SmtpSecurity,
            user: str(c.user) || undefined,
            from: str(c.from),
            to: recipients(str(c.to)).join(', '),
          }
        : {}),
    }
    const errors = channelErrors(ch)
    if (errors.length) throw new Error(`${ch.name}: ${errors.join(' · ')}`)
    return ch
  })
  const r = (o.rules ?? {}) as Record<string, unknown>
  // New rules that cost something (the internet one measures) or are chatty (new devices) start switched off.
  const rules = Object.fromEntries(RULE_KEYS.map((key) => [key, key === 'internet' || key === 'device-new' ? r[key] === true : r[key] !== false])) as Record<RuleKey, boolean>
  const threshold = Number(o.diskThreshold)
  const hour = Number(o.updatesHour)
  const percent = Number(o.speedPercent)
  const mbit = Number(o.speedMbit)
  const days = Number(o.backupDays)
  return {
    channels,
    rules,
    diskThreshold: Number.isInteger(threshold) && threshold >= 50 && threshold <= 99 ? threshold : 90,
    recovery: o.recovery !== false,
    updatesHour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9,
    speedMode: o.speedMode === 'fixed' ? 'fixed' : 'relative',
    speedPercent: Number.isInteger(percent) && percent >= 10 && percent <= 90 ? percent : 50,
    speedMbit: Number.isFinite(mbit) && mbit >= 1 && mbit <= 100_000 ? Math.round(mbit) : 100,
    backupDays: Number.isInteger(days) && days >= 1 && days <= 60 ? days : 2,
  }
}

export function maskSettings(s: NotifySettings): NotifySettings {
  return { ...s, channels: s.channels.map((c) => ({ ...c, token: c.token ? MASK : undefined })) }
}

// ---------- problems ----------

const pct = (n: number) => `${Math.round(n * 100)} %`

/**
 * Current problems per rule. Rules whose source is not readable right now are
 * returned in `unknown`: their reported problems stay as they are.
 * `active` lets a full disk stay reported until it is clearly below the
 * threshold again (no ping-pong around the limit).
 */
export function currentAlerts(snap: Snapshot, s: NotifySettings, active: Set<string> = new Set()): { alerts: Alert[]; unknown: Set<RuleKey> } {
  const alerts: Alert[] = []
  const unknown = new Set<RuleKey>()
  const on = (r: RuleKey) => s.rules[r]
  if (on('unit-failed')) {
    if (!snap.sources.systemd.ok) unknown.add('unit-failed')
    for (const u of snap.units)
      if (u.active === 'failed')
        alerts.push({
          key: `unit:${u.name}`,
          rule: 'unit-failed',
          severity: 'critical',
          title: msg(m.notify_alert_unitFailed, { name: u.name }),
          subject: u.name,
          detail: u.result === 'exit-code' ? `Exit ${u.exitStatus ?? '?'}` : u.result === 'oom-kill' ? msg(m.notify_alert_oomKilled) : u.result,
        })
  }
  if (on('service-down')) {
    for (const g of snap.services)
      for (const svc of g.items)
        if (svc.health === 'bad') alerts.push({ key: `http:${svc.key}`, rule: 'service-down', severity: 'warning', title: msg(m.notify_alert_serviceDown, { name: svc.name }), subject: svc.name, detail: svc.healthNote ?? svc.url })
  }
  if (on('container-unhealthy')) {
    if (!snap.sources.podman.ok) unknown.add('container-unhealthy')
    for (const c of snap.containers) {
      if (c.health === 'unhealthy')
        alerts.push({ key: `ct:${c.name}`, rule: 'container-unhealthy', severity: 'warning', title: msg(m.notify_alert_containerUnhealthy, { name: c.name }), subject: c.name, detail: msg(m.services_health_checkFailing) })
      else if (!c.unit && c.state === 'exited' && /Exited \((?!0\))\d+\)/.test(c.status))
        alerts.push({ key: `ct:${c.name}`, rule: 'container-unhealthy', severity: 'warning', title: msg(m.notify_alert_containerCrashed, { name: c.name }), subject: c.name, detail: c.status })
    }
  }
  if (on('smart')) {
    if (!snap.sources.smart.ok) unknown.add('smart')
    for (const d of snap.smart ?? [])
      if (d.level !== 'ok')
        alerts.push({
          key: `smart:${d.name}:${d.level}`,
          rule: 'smart',
          severity: d.level,
          title: msg(m.notify_alert_smart, { name: d.name, critical: String(d.level === 'critical') }),
          detail: msg(m.notify_alert_smartDetails),
        })
  }
  if (on('disk-full')) {
    if (!snap.sources.disks.ok) unknown.add('disk-full')
    for (const d of snap.disks) {
      if (!d.size) continue
      const used = d.used / d.size
      const key = `disk:${d.mount}`
      const limit = (active.has(key) ? s.diskThreshold - 3 : s.diskThreshold) / 100
      if (used >= limit) alerts.push({ key, rule: 'disk-full', severity: used >= 0.97 ? 'critical' : 'warning', title: msg(m.notify_alert_diskFull, { mount: d.mount, percent: pct(used) }), detail: `${d.dev} · ${d.fstype}` })
    }
  }
  if (on('internet') && snap.speed?.alert)
    alerts.push({
      key: 'internet',
      rule: 'internet',
      severity: 'warning',
      title: snap.speed.alert === 'down' ? msg(m.notify_alert_internetDown) : msg(m.notify_alert_internetSlow, { down: Math.round(snap.speed.down ?? 0), expected: Math.round(snap.speed.expected ?? 0) }),
      subject: msg(m.notify_subject_internet),
      detail: snap.speed.detail,
    })
  if (on('backup') && snap.backup) {
    const b = snap.backup
    for (const c of b.stale ?? [])
      alerts.push({ key: `backup:client:${c.name}`, rule: 'backup', severity: 'warning', title: c.never ? msg(m.backup_alert_clientNever, { name: c.name }) : msg(m.backup_alert_client, { name: c.name, days: c.days }), subject: c.name })
  }
  if (on('backup') && snap.backup?.server) {
    const b = snap.backup
    const age = (Date.now() - (b.lastOkAt ?? b.since)) / 86_400_000
    if (b.lastStatus === 'failed') alerts.push({ key: 'backup', rule: 'backup', severity: 'warning', title: msg(m.backup_alert_failed, { message: b.lastMessage ?? '' }), subject: msg(m.notify_subject_backup) })
    else if (age >= s.backupDays) alerts.push({ key: 'backup', rule: 'backup', severity: 'warning', title: b.lastOkAt ? msg(m.backup_alert_old, { days: Math.floor(age) }) : msg(m.backup_alert_never), subject: msg(m.notify_subject_backup) })
  }
  if (on('device-new'))
    for (const d of snap.devices?.fresh ?? [])
      alerts.push({
        key: `device:${d.key}`,
        rule: 'device-new',
        severity: 'warning',
        title: msg(m.devices_alert_new, { name: d.name ?? d.ip }),
        subject: d.name ?? d.ip,
        detail: [d.ip, d.mac, d.vendor].filter(Boolean).join(' · '),
      })
  return { alerts, unknown }
}

/** One message for several new problems, highest severity wins. */
export function problemNotice(host: string, alerts: Alert[]): Notice {
  const severity: Severity = alerts.some((a) => a.severity === 'critical') ? 'critical' : 'warning'
  if (alerts.length === 1) return { title: `${host}: ${alerts[0]!.title}`, body: alerts[0]!.detail ?? '', severity }
  return { title: msg(m.notify_summary_problems, { host, count: alerts.length }), body: alerts.map((a) => `• ${a.title}${a.detail ? ` – ${a.detail}` : ''}`).join('\n'), severity }
}

export function recoveryNotice(host: string, alerts: Alert[]): Notice {
  if (alerts.length === 1) {
    const a = alerts[0]!
    const body = a.subject ? msg(m.notify_summary_runningAgain, { name: a.subject }) : a.title
    return { title: msg(m.notify_summary_backNormal, { host }), body, severity: 'ok' }
  }
  return { title: msg(m.notify_summary_resolved, { host, count: alerts.length }), body: alerts.map((a) => `• ${a.title}`).join('\n'), severity: 'ok' }
}

// ---------- sending ----------

const NTFY_PRIORITY: Record<Severity, number> = { critical: 5, warning: 4, info: 3, ok: 2 }
const NTFY_TAGS: Record<Severity, string[]> = { critical: ['rotating_light'], warning: ['warning'], info: ['information_source'], ok: ['white_check_mark'] }
const GOTIFY_PRIORITY: Record<Severity, number> = { critical: 8, warning: 5, info: 3, ok: 2 }

/** The HTTP request for one channel (pure, so it can be tested). */
export function buildRequest(c: Channel, n: Notice): { url: string; init: RequestInit } {
  const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  switch (c.kind) {
    case 'ntfy':
      // JSON publishing: titles with umlauts would not survive as HTTP headers.
      return {
        url: c.url,
        init: json({ topic: c.topic, title: n.title, message: n.body || n.title, priority: NTFY_PRIORITY[n.severity], tags: NTFY_TAGS[n.severity] }, c.token ? { authorization: `Bearer ${c.token}` } : {}),
      }
    case 'gotify':
      return { url: `${c.url}/message`, init: json({ title: n.title, message: n.body || n.title, priority: GOTIFY_PRIORITY[n.severity] }, { 'x-gotify-key': c.token ?? '' }) }
    case 'telegram':
      return { url: `https://api.telegram.org/bot${c.token}/sendMessage`, init: json({ chat_id: c.chatId, text: n.body ? `${n.title}\n\n${n.body}` : n.title, disable_web_page_preview: true }) }
    case 'webhook': {
      const text = n.body ? `${n.title}\n${n.body}` : n.title
      // "content" for Discord, "text" for Slack/Mattermost, the rest for scripts.
      return { url: c.url, init: json({ title: n.title, message: n.body, severity: n.severity, text, content: text }) }
    }
    case 'email':
      throw new Error(msg(m.notify_error_emailNotHttp))
  }
}

const SUBJECT_MARK: Record<Severity, string> = { critical: '🔴 ', warning: '🟠 ', info: '', ok: '✅ ' }

/** The e-mail for a notice: subject and plain-text body. */
export function buildMail(c: Channel, n: Notice): { from: string; to: string[]; subject: string; text: string } {
  return {
    from: c.from ?? '',
    to: recipients(c.to),
    subject: `${SUBJECT_MARK[n.severity]}${n.title}`.replace(/[\r\n]+/g, ' '),
    text: `${n.body || n.title}\n\n-- \n${msg(m.notify_email_footer)}\n`,
  }
}

/** Short target description for the list (no secrets). */
export function channelTarget(c: Channel): string {
  if (c.kind === 'ntfy') return `${c.url}/${c.topic}`
  if (c.kind === 'telegram') return `Chat ${c.chatId}`
  if (c.kind === 'email') return msg(m.notify_channel_emailTarget, { to: c.to ?? '', host: c.host ?? '' })
  return c.url.replace(/^(https?:\/\/[^/]+)\/.{12,}$/, '$1/…')
}
