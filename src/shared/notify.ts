// Notifications: settings, the problems worth a message (derived from the
// snapshot) and how a message is sent to ntfy, Gotify, Telegram, a webhook or by e-mail.
// Pure functions, shared by the server and the settings page.

import { localize, tr } from './i18n'
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

export type RuleKey = 'unit-failed' | 'service-down' | 'container-unhealthy' | 'smart' | 'disk-full' | 'updates'

export interface NotifySettings {
  channels: Channel[]
  rules: Record<RuleKey, boolean>
  /** Percent. */
  diskThreshold: number
  /** Also send "wieder in Ordnung". */
  recovery: boolean
  /** Hour of the day for the update summary. */
  updatesHour: number
}

export type Severity = 'critical' | 'warning' | 'info' | 'ok'

export interface Alert {
  key: string
  rule: RuleKey
  severity: 'critical' | 'warning'
  title: string
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

export const RULE_KEYS: RuleKey[] = ['unit-failed', 'service-down', 'container-unhealthy', 'smart', 'disk-full', 'updates']

export const rules = (): { key: RuleKey; label: string; help: string }[] => [
  { key: 'unit-failed', label: tr('Dienst oder Timer fehlgeschlagen', 'Service or timer failed'), help: tr('Eine systemd-Unit oder ein Container-Dienst ist im Zustand „failed“ – z. B. das nächtliche Backup.', 'A systemd unit or a container service is in the state “failed” – e.g. the nightly backup.') },
  { key: 'service-down', label: tr('Webdienst nicht erreichbar', 'Web service not reachable'), help: tr('Der HTTP-Check einer Kachel auf der Übersicht schlägt seit über 2 Minuten fehl.', 'The HTTP check of a tile on the overview has been failing for over 2 minutes.') },
  { key: 'container-unhealthy', label: tr('Container ungesund', 'Container unhealthy'), help: tr('Healthcheck meldet „unhealthy“ oder ein Container ohne Unit ist abgestürzt (über 2 Minuten).', 'Healthcheck reports “unhealthy” or a container without a unit has crashed (over 2 minutes).') },
  { key: 'smart', label: tr('Festplatte meldet Probleme (SMART)', 'Disk reports problems (SMART)'), help: tr('Warnung oder kritischer Zustand laut SMART-Auswertung.', 'Warning or critical state according to the SMART evaluation.') },
  { key: 'disk-full', label: tr('Platte fast voll', 'Disk almost full'), help: tr('Belegung über dem Schwellwert.', 'Usage above the threshold.') },
  { key: 'updates', label: tr('Updates verfügbar (täglich)', 'Updates available (daily)'), help: tr('Einmal am Tag: neue Pakete und Container-Images – nur wenn sich seit der letzten Meldung etwas geändert hat.', 'Once a day: new packages and container images – only if something changed since the last message.') },
]

export const CHANNEL_KIND_IDS: ChannelKind[] = ['ntfy', 'gotify', 'telegram', 'webhook', 'email']

export const channelKinds = (): { kind: ChannelKind; label: string; help: string }[] => [
  { kind: 'ntfy', label: 'ntfy', help: tr('Push aufs Handy über ntfy.sh oder einen eigenen ntfy-Server: Thema wählen und in der ntfy-App abonnieren.', 'Push to your phone via ntfy.sh or your own ntfy server: pick a topic and subscribe to it in the ntfy app.') },
  { kind: 'gotify', label: 'Gotify', help: tr('Eigener Gotify-Server: in Gotify eine App anlegen und deren Token eintragen.', 'Your own Gotify server: create an app in Gotify and enter its token.') },
  { kind: 'telegram', label: 'Telegram', help: tr('Bot bei @BotFather anlegen, Token eintragen, dem Bot schreiben und die Chat-ID (z. B. über @userinfobot) eintragen.', 'Create a bot with @BotFather, enter the token, write to the bot and enter the chat ID (e.g. via @userinfobot).') },
  { kind: 'webhook', label: 'Webhook', help: tr('POST mit JSON an eine URL – passt für Discord, Slack, Mattermost, Home Assistant oder eigene Skripte.', 'POST with JSON to a URL – works for Discord, Slack, Mattermost, Home Assistant or your own scripts.') },
  { kind: 'email', label: tr('E-Mail', 'E-mail'), help: tr('Über den SMTP-Server deines Mail-Anbieters. Bei Gmail, GMX, web.de und Co. ist dafür oft ein eigenes App-Passwort nötig, nicht das normale Passwort.', 'Via the SMTP server of your mail provider. Gmail, GMX, web.de and the like often need a separate app password for this, not the normal password.') },
]

/** Common mail providers: server and port to start from. */
export const smtpPresets = (): { label: string; host: string; port: number; security: SmtpSecurity; note?: string }[] => [
  { label: 'Gmail', host: 'smtp.gmail.com', port: 465, security: 'tls', note: tr('App-Passwort unter myaccount.google.com → Sicherheit (2-Faktor muss an sein)', 'App password at myaccount.google.com → Security (2-factor must be on)') },
  { label: 'GMX', host: 'mail.gmx.net', port: 587, security: 'starttls', note: tr('In den GMX-Einstellungen „POP3/IMAP/SMTP“ erlauben', 'Allow “POP3/IMAP/SMTP” in the GMX settings') },
  { label: 'web.de', host: 'smtp.web.de', port: 587, security: 'starttls', note: tr('In den WEB.DE-Einstellungen „POP3/IMAP/SMTP“ erlauben', 'Allow “POP3/IMAP/SMTP” in the WEB.DE settings') },
  { label: 'Posteo', host: 'posteo.de', port: 465, security: 'tls' },
  { label: 'mailbox.org', host: 'smtp.mailbox.org', port: 465, security: 'tls' },
  { label: 'iCloud', host: 'smtp.mail.me.com', port: 587, security: 'starttls', note: tr('App-spezifisches Passwort unter appleid.apple.com', 'App-specific password at appleid.apple.com') },
  { label: 'Outlook', host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
  { label: tr('Eigener Server', 'Own server'), host: '', port: 587, security: 'starttls' },
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
  rules: { 'unit-failed': true, 'service-down': true, 'container-unhealthy': true, smart: true, 'disk-full': true, updates: true },
  diskThreshold: 90,
  recovery: true,
  updatesHour: 9,
})

/** How long a problem must persist before it is reported. */
export const DELAY_MS: Record<RuleKey, number> = { 'unit-failed': 0, 'service-down': 120_000, 'container-unhealthy': 120_000, smart: 0, 'disk-full': 0, updates: 0 }

// ---------- validation ----------

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/
const HTTP_URL = /^https?:\/\/[^\s/?#]+(?::\d+)?(\/[^\s]*)?$/

export function channelErrors(c: Channel): string[] {
  const out: string[] = []
  if (!c.name.trim() || c.name.length > 60 || CONTROL.test(c.name)) out.push(tr('Name fehlt oder ist zu lang', 'Name missing or too long'))
  if (c.kind !== 'telegram' && c.kind !== 'email' && (!HTTP_URL.test(c.url) || c.url.length > 500)) out.push(tr('URL muss mit http:// oder https:// beginnen', 'URL must start with http:// or https://'))
  if (c.kind === 'email') {
    if (!HOSTNAME.test(c.host ?? '')) out.push(tr('SMTP-Server fehlt', 'SMTP server missing'))
    if (!Number.isInteger(c.port) || c.port! < 1 || c.port! > 65535) out.push('Port 1–65535')
    if (!['tls', 'starttls', 'none'].includes(c.security ?? '')) out.push(tr('Verschlüsselung wählen', 'Choose an encryption'))
    if (c.user && (c.user.length > 200 || CONTROL.test(c.user))) out.push(tr('Benutzername ungültig', 'Invalid user name'))
    if (c.user && !c.token) out.push(tr('Passwort fehlt', 'Password missing'))
    if (c.token && c.security === 'none') out.push(tr('Ein Passwort nur mit Verschlüsselung (SSL/TLS oder STARTTLS) senden', 'Only send a password with encryption (SSL/TLS or STARTTLS)'))
    if (!EMAIL.test(c.from ?? '')) out.push(tr('Absender: eine E-Mail-Adresse', 'Sender: an e-mail address'))
    const to = recipients(c.to)
    if (!to.length || to.length > 10 || !to.every((x) => EMAIL.test(x))) out.push(tr('Empfänger: eine oder mehrere E-Mail-Adressen (mit Komma getrennt)', 'Recipients: one or more e-mail addresses (comma-separated)'))
  }
  if (c.kind === 'ntfy' && !/^[A-Za-z0-9_-]{1,64}$/.test(c.topic ?? '')) out.push(tr('Thema: Buchstaben, Ziffern, - und _', 'Topic: letters, digits, - and _'))
  if ((c.kind === 'gotify' || c.kind === 'telegram') && !c.token) out.push(tr('Token fehlt', 'Token missing'))
  if (c.token && (c.token.length > 300 || (c.kind !== 'email' && /\s/.test(c.token)) || CONTROL.test(c.token))) out.push(c.kind === 'email' ? tr('Passwort ungültig', 'Invalid password') : tr('Token ungültig', 'Invalid token'))
  if (c.kind === 'telegram' && !/^(-?\d{1,20}|@[A-Za-z0-9_]{4,64})$/.test(c.chatId ?? '')) out.push(tr('Chat-ID: Zahl (z. B. 123456789) oder @kanalname', 'Chat ID: number (e.g. 123456789) or @channelname'))
  return out
}

/** Settings from untrusted JSON; tokens shown as MASK are taken from `previous`. */
export function parseSettings(v: unknown, previous: NotifySettings): NotifySettings {
  if (!v || typeof v !== 'object') throw new Error(tr('Einstellungen fehlen', 'Settings missing'))
  const o = v as Record<string, unknown>
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '')
  const rawChannels = Array.isArray(o.channels) ? o.channels : []
  if (rawChannels.length > 10) throw new Error(tr('Höchstens 10 Kanäle', 'At most 10 channels'))
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
  const rules = Object.fromEntries(RULE_KEYS.map((key) => [key, r[key] !== false])) as Record<RuleKey, boolean>
  const threshold = Number(o.diskThreshold)
  const hour = Number(o.updatesHour)
  return {
    channels,
    rules,
    diskThreshold: Number.isInteger(threshold) && threshold >= 50 && threshold <= 99 ? threshold : 90,
    recovery: o.recovery !== false,
    updatesHour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9,
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
          title: tr(`${u.name} ist fehlgeschlagen`, `${u.name} failed`),
          detail: u.result === 'exit-code' ? `Exit ${u.exitStatus ?? '?'}` : u.result === 'oom-kill' ? tr('vom Kernel wegen Speichermangel beendet', 'killed by the kernel for lack of memory') : u.result,
        })
  }
  if (on('service-down')) {
    for (const g of snap.services)
      for (const svc of g.items) if (svc.health === 'bad') alerts.push({ key: `http:${svc.key}`, rule: 'service-down', severity: 'warning', title: tr(`${svc.name} ist nicht erreichbar`, `${svc.name} is not reachable`), detail: svc.healthNote ?? svc.url })
  }
  if (on('container-unhealthy')) {
    if (!snap.sources.podman.ok) unknown.add('container-unhealthy')
    for (const c of snap.containers) {
      if (c.health === 'unhealthy') alerts.push({ key: `ct:${c.name}`, rule: 'container-unhealthy', severity: 'warning', title: tr(`Container ${c.name} ist ungesund`, `Container ${c.name} is unhealthy`), detail: tr('Healthcheck schlägt fehl', 'Healthcheck failing') })
      else if (!c.unit && c.state === 'exited' && /Exited \((?!0\))\d+\)/.test(c.status)) alerts.push({ key: `ct:${c.name}`, rule: 'container-unhealthy', severity: 'warning', title: tr(`Container ${c.name} ist abgestürzt`, `Container ${c.name} crashed`), detail: c.status })
    }
  }
  if (on('smart')) {
    if (!snap.sources.smart.ok) unknown.add('smart')
    for (const d of snap.smart ?? [])
      if (d.level !== 'ok')
        alerts.push({ key: `smart:${d.name}:${d.level}`, rule: 'smart', severity: d.level, title: tr(`Festplatte ${d.name}: SMART ${d.level === 'critical' ? 'kritisch' : 'Warnung'}`, `Disk ${d.name}: SMART ${d.level === 'critical' ? 'critical' : 'warning'}`), detail: tr('Details unter Festplatten → SMART', 'Details under Disks → SMART') })
  }
  if (on('disk-full')) {
    if (!snap.sources.disks.ok) unknown.add('disk-full')
    for (const d of snap.disks) {
      if (!d.size) continue
      const used = d.used / d.size
      const key = `disk:${d.mount}`
      const limit = (active.has(key) ? s.diskThreshold - 3 : s.diskThreshold) / 100
      if (used >= limit) alerts.push({ key, rule: 'disk-full', severity: used >= 0.97 ? 'critical' : 'warning', title: tr(`${d.mount} ist zu ${pct(used)} voll`, `${d.mount} is ${pct(used)} full`), detail: `${d.dev} · ${d.fstype}` })
    }
  }
  return { alerts, unknown }
}

/** One message for several new problems, highest severity wins. */
export function problemNotice(host: string, alerts: Alert[]): Notice {
  const severity: Severity = alerts.some((a) => a.severity === 'critical') ? 'critical' : 'warning'
  if (alerts.length === 1) return { title: `${host}: ${alerts[0]!.title}`, body: alerts[0]!.detail ?? '', severity }
  return { title: tr(`${host}: ${alerts.length} Probleme`, `${host}: ${alerts.length} problems`), body: alerts.map((a) => `• ${a.title}${a.detail ? ` – ${a.detail}` : ''}`).join('\n'), severity }
}

export function recoveryNotice(host: string, alerts: Alert[]): Notice {
  if (alerts.length === 1) {
    // The title may hold both languages (background job): rephrase each one on its own.
    const t = alerts[0]!.title
    const body = tr(localize(t, 'de').replace(/ ist (fehlgeschlagen|nicht erreichbar|ungesund|abgestürzt)$/, ' läuft wieder'), localize(t, 'en').replace(/ (failed|is not reachable|is unhealthy|crashed)$/, ' is running again'))
    return { title: tr(`${host}: wieder in Ordnung`, `${host}: back to normal`), body, severity: 'ok' }
  }
  return { title: tr(`${host}: ${alerts.length} Probleme behoben`, `${host}: ${alerts.length} problems resolved`), body: alerts.map((a) => `• ${a.title}`).join('\n'), severity: 'ok' }
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
      throw new Error(tr('E-Mail geht über SMTP, nicht über HTTP', 'E-mail goes via SMTP, not HTTP'))
  }
}

const SUBJECT_MARK: Record<Severity, string> = { critical: '🔴 ', warning: '🟠 ', info: '', ok: '✅ ' }

/** The e-mail for a notice: subject and plain-text body. */
export function buildMail(c: Channel, n: Notice): { from: string; to: string[]; subject: string; text: string } {
  return {
    from: c.from ?? '',
    to: recipients(c.to),
    subject: `${SUBJECT_MARK[n.severity]}${n.title}`.replace(/[\r\n]+/g, ' '),
    text: `${n.body || n.title}\n\n-- \n${tr('Gesendet von Quadeck. Benachrichtigungen ändern: Quadeck → Benachrichtigungen.', 'Sent by Quadeck. Change notifications: Quadeck → Notifications.')}\n`,
  }
}

/** Short target description for the list (no secrets). */
export function channelTarget(c: Channel): string {
  if (c.kind === 'ntfy') return `${c.url}/${c.topic}`
  if (c.kind === 'telegram') return `Chat ${c.chatId}`
  if (c.kind === 'email') return tr(`${c.to} über ${c.host}`, `${c.to} via ${c.host}`)
  return c.url.replace(/^(https?:\/\/[^/]+)\/.{12,}$/, '$1/…')
}
