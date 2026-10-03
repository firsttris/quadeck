// Sends notifications when problems appear (and when they are gone again).
// Runs in the web app: the hub hands every new snapshot to evaluate(); what
// was already reported is kept in the settings table, so a restart does not
// repeat messages.

import { createHash } from 'node:crypto'
import { getSetting, setSetting } from './settings'
import type { ImageUpdatesReport, UpdatesReport } from '~/shared/packages'
import type { Snapshot } from '~/shared/types'
import { sendMail, type Mail } from './mail'
import { isLang, localizeDeep, msg, type Lang } from '~/shared/i18n'
import { DELAY_MS, buildMail, buildRequest, currentAlerts, defaultSettings, problemNotice, recoveryNotice, type Alert, type Channel, type Notice, type NotifySettings, type NotifyState, type SentNotice } from '~/shared/notify'
import { bilingual } from './lang'

const KEY = 'notifications'
const ACTIVE = 'notifications-active'
const LOG = 'notifications-log'
const UPDATES = 'notifications-updates'
const KEEP_LOG = 50

/** Set by the UI's language switch (/api/lang). */
export const LANG_SETTING = 'lang'
export const notifyLang = (): Lang => {
  const l = getSetting<string>(LANG_SETTING)
  return isLang(l) ? l : 'de'
}

type Active = Alert & { since: number }
type Send = (url: string, init: RequestInit) => Promise<Response>

export interface UpdateSource {
  updates(refresh: boolean): Promise<UpdatesReport>
  imageUpdates(refresh: boolean): Promise<ImageUpdatesReport>
}

export class Notifier {
  private pending = new Map<string, { alert: Alert; first: number }>()
  private active: Map<string, Active>
  private log: SentNotice[]
  private updatesRunning = false
  /** After a delivery that reached no channel: wait before the next attempt. */
  private retryAt = 0

  constructor(
    private send: Send = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
    private mail: Mail = sendMail,
  ) {
    this.active = new Map((getSetting<Active[]>(ACTIVE) ?? []).map((a) => [a.key, a]))
    this.log = getSetting<SentNotice[]>(LOG) ?? []
  }

  settings(): NotifySettings {
    return { ...defaultSettings(), ...(getSetting<NotifySettings>(KEY) ?? {}) }
  }

  save(s: NotifySettings) {
    setSetting(KEY, s)
    // Switched-off rules forget what they reported.
    for (const [k, a] of this.active) if (!s.rules[a.rule]) this.active.delete(k)
    this.persistActive()
  }

  state(): NotifyState {
    return { settings: this.settings(), active: [...this.active.values()].sort((a, b) => b.since - a.since), log: this.log }
  }

  private persistActive() {
    setSetting(ACTIVE, [...this.active.values()])
  }

  private record(n: SentNotice) {
    this.log = [n, ...this.log].slice(0, KEEP_LOG)
    setSetting(LOG, this.log)
  }

  /** Sends to every enabled channel (or the given one); errors end up in the log, not as exceptions. */
  async deliver(n: Notice, channels: Channel[], test = false): Promise<SentNotice> {
    // Messages go out in the language last picked in the UI; the log stays language-neutral.
    const lang = notifyLang()
    const out = localizeDeep(n, lang)
    const results = await Promise.all(
      channels.map(async (c) => {
        try {
          if (c.kind === 'email') {
            await this.mail(c, localizeDeep(buildMail(c, out), lang))
            return { channel: c.name, ok: true }
          }
          const { url, init } = buildRequest(c, out)
          const res = await this.send(url, init)
          if (!res.ok) return { channel: c.name, ok: false, error: `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim() }
          return { channel: c.name, ok: true }
        } catch (e) {
          return { channel: c.name, ok: false, error: (e as Error).message }
        }
      }),
    )
    const sent: SentNotice = { ...n, ts: Date.now(), test: test || undefined, results }
    this.record(sent)
    return sent
  }

  /** Compares the snapshot with what was reported and sends what is new or resolved. */
  async evaluate(snap: Snapshot, now = Date.now()) {
    const s = this.settings()
    const channels = s.channels.filter((c) => c.enabled)
    if (!channels.length || now < this.retryAt) return
    const { alerts, unknown } = currentAlerts(snap, s, new Set(this.active.keys()))
    const seen = new Set(alerts.map((a) => a.key))
    const fresh: Alert[] = []
    for (const a of alerts) {
      if (this.active.has(a.key)) continue
      const p = this.pending.get(a.key) ?? { alert: a, first: now }
      this.pending.set(a.key, p)
      if (now - p.first >= DELAY_MS[a.rule]) {
        this.pending.delete(a.key)
        this.active.set(a.key, { ...a, since: now })
        fresh.push(a)
      }
    }
    for (const k of this.pending.keys()) if (!seen.has(k)) this.pending.delete(k)
    const resolved: Alert[] = []
    for (const [k, a] of this.active) {
      if (seen.has(k) || unknown.has(a.rule) || a.rule === 'updates') continue
      this.active.delete(k)
      if (s.rules[a.rule]) resolved.push(a)
    }
    if (!fresh.length && !resolved.length) return
    this.persistActive()
    const host = snap.host.hostname
    if (fresh.length) {
      const sent = await this.deliver(problemNotice(host, fresh), channels)
      // Reached nobody: report these again in 5 minutes instead of forgetting them.
      if (!sent.results.some((r) => r.ok)) {
        for (const a of fresh) this.active.delete(a.key)
        this.persistActive()
        this.retryAt = now + 5 * 60_000
      }
    }
    if (resolved.length && s.recovery) await this.deliver(recoveryNotice(host, resolved), channels)
  }

  /**
   * Once a day from the configured hour: updates and new images, only when the
   * set differs from the last message.
   */
  async checkUpdates(host: string, source: UpdateSource, now = new Date()) {
    const s = this.settings()
    const channels = s.channels.filter((c) => c.enabled)
    if (!channels.length || !s.rules.updates || now.getHours() < s.updatesHour || this.updatesRunning) return
    const last = getSetting<{ day: string; hash: string }>(UPDATES)
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
    if (last?.day === day) return
    this.updatesRunning = true
    try {
      const [pk, img] = await Promise.allSettled([source.updates(false), source.imageUpdates(false)])
      const pkgs = pk.status === 'fulfilled' ? [...pk.value.repo, ...pk.value.aur].map((p) => `${p.name} ${p.to}`) : []
      const images = img.status === 'fulfilled' ? img.value.items.filter((i) => i.updated === 'pending').map((i) => i.container) : []
      const hash = createHash('sha256')
        .update([...pkgs, '|', ...images].join('\n'))
        .digest('hex')
        .slice(0, 16)
      setSetting(UPDATES, { day, hash })
      if ((!pkgs.length && !images.length) || hash === last?.hash) return
      const lines = [
        pkgs.length ? msg('notify_packageUpdate', { length: pkgs.length, value: pkgs.length === 1 ? '' : 's' }) : '',
        images.length ? msg('notify_newImages', { list: images.join(', ') }) : '',
        msg('notify_installUnderSystemUpdates'),
      ].filter(Boolean)
      await this.deliver({ title: msg('notify_updatesAvailable', { host }), body: lines.join('\n'), severity: 'info' }, channels)
    } finally {
      this.updatesRunning = false
    }
  }
}

let instance: Notifier | undefined
export function notifier() {
  if (!instance) instance = bilingual(new Notifier())
  return instance
}
