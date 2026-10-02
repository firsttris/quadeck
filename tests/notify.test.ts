import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MASK, buildRequest, currentAlerts, defaultSettings, maskSettings, parseSettings, problemNotice, recoveryNotice, type Channel } from '~/shared/notify'
import type { Snapshot } from '~/shared/types'

process.env.QUADECK_DATA_DIR = mkdtempSync(join(tmpdir(), 'quadeck-notify-'))
const { Notifier } = await import('~/server/notify')
const { setSetting } = await import('~/server/settings')

const ok = { ok: true }
function snap(o: Partial<Snapshot> = {}): Snapshot {
  return {
    host: { hostname: 'nas-01', os: '', kernel: '', uptimeSec: 0, cpuCores: 4 } as Snapshot['host'],
    system: null,
    disks: [],
    containers: [],
    units: [],
    services: [],
    hiddenServices: [],
    shares: [],
    smart: [],
    sources: { system: ok, disks: ok, podman: ok, systemd: ok, caddy: ok, shares: ok, smart: ok },
    readonly: false,
    ...o,
  }
}
const failedUnit = { name: 'backup.service', description: '', load: 'loaded', active: 'failed', sub: 'failed', kind: 'service' as const, result: 'exit-code', exitStatus: 2 }
const hook: Channel = { id: 'hook', kind: 'webhook', name: 'Hook', enabled: true, url: 'http://127.0.0.1:9/hook' }

describe('settings', () => {
  it('validates channels and keeps masked tokens', () => {
    const prev = { ...defaultSettings(), channels: [{ id: 'g', kind: 'gotify', name: 'Gotify', enabled: true, url: 'https://gotify.lan', token: 'secret' } as Channel] }
    const masked = maskSettings(prev)
    expect(masked.channels[0]!.token).toBe(MASK)
    expect(parseSettings(masked, prev).channels[0]!.token).toBe('secret')
    expect(() => parseSettings({ channels: [{ kind: 'ntfy', name: 'x', url: 'https://ntfy.sh', topic: 'a b' }] }, prev)).toThrow(/Thema/)
    expect(() => parseSettings({ channels: [{ kind: 'webhook', name: 'x', url: 'ftp://x' }] }, prev)).toThrow(/URL/)
    expect(() => parseSettings({ channels: [{ kind: 'telegram', name: 'x', token: 't', chatId: 'abc' }] }, prev)).toThrow(/Chat-ID/)
    const s = parseSettings({ channels: [{ kind: 'ntfy', name: 'Handy', url: 'https://ntfy.sh/', topic: 'nas-x1' }], rules: { updates: false }, diskThreshold: 120 }, prev)
    expect(s.channels[0]).toMatchObject({ url: 'https://ntfy.sh', topic: 'nas-x1', enabled: true })
    expect(s.rules.updates).toBe(false)
    expect(s.rules['unit-failed']).toBe(true)
    expect(s.diskThreshold).toBe(90)
  })
})

describe('problems', () => {
  const s = defaultSettings()
  it('finds failed units, bad services, unhealthy containers, SMART and full disks', () => {
    const { alerts } = currentAlerts(
      snap({
        units: [failedUnit],
        containers: [
          { id: 'a', name: 'web', image: '', state: 'running', health: 'unhealthy', status: 'Up', labels: {}, ports: [], networks: [], aliases: [], ips: [], cpuHistory: [], unit: 'web.service' },
          { id: 'b', name: 'tool', image: '', state: 'exited', status: 'Exited (1) 2 hours ago', labels: {}, ports: [], networks: [], aliases: [], ips: [], cpuHistory: [] },
          { id: 'c', name: 'job', image: '', state: 'exited', status: 'Exited (0) 2 hours ago', labels: {}, ports: [], networks: [], aliases: [], ips: [], cpuHistory: [] },
        ],
        services: [
          { name: 'Medien', note: '', items: [{ key: 'jf', name: 'Jellyfin', url: 'https://jf', host: 'jf', group: 'Medien', icon: { kind: 'glyph', glyph: 'box' }, iconFallback: 'box', color: '', health: 'bad', source: 'caddy' }] },
        ],
        smart: [{ name: 'sdb', level: 'critical', supported: true }],
        disks: [{ dev: '/dev/sdb1', path: '', mount: '/srv', fstype: 'ext4', size: 100, used: 93, role: 'data' }],
      }),
      s,
    )
    expect(alerts.map((a) => a.key)).toEqual(['unit:backup.service', 'http:jf', 'ct:web', 'ct:tool', 'smart:sdb:critical', 'disk:/srv'])
    expect(alerts[0]).toMatchObject({ title: 'backup.service ist fehlgeschlagen', detail: 'Exit 2' })
  })

  it('keeps a full disk reported until it is clearly below the limit', () => {
    const disk = (used: number) => snap({ disks: [{ dev: 'd', path: '', mount: '/srv', fstype: 'ext4', size: 100, used, role: '' }] })
    expect(currentAlerts(disk(88), s).alerts).toHaveLength(0)
    expect(currentAlerts(disk(88), s, new Set(['disk:/srv'])).alerts).toHaveLength(1)
    expect(currentAlerts(disk(86), s, new Set(['disk:/srv'])).alerts).toHaveLength(0)
  })

  it('marks rules whose source is unreadable as unknown', () => {
    const r = currentAlerts(snap({ sources: { ...snap().sources, systemd: { ok: false, error: 'x' } } }), s)
    expect(r.unknown.has('unit-failed')).toBe(true)
  })

  it('formats one or several problems', () => {
    const a = currentAlerts(snap({ units: [failedUnit, { ...failedUnit, name: 'b.service' }] }), s).alerts
    expect(problemNotice('nas', a.slice(0, 1))).toEqual({ title: 'nas: backup.service ist fehlgeschlagen', body: 'Exit 2', severity: 'critical' })
    expect(problemNotice('nas', a).title).toBe('nas: 2 Probleme')
    expect(recoveryNotice('nas', a.slice(0, 1)).body).toBe('backup.service läuft wieder')
  })
})

describe('requests', () => {
  const n = { title: 'nas: Ärger', body: 'Details', severity: 'critical' as const }
  it('builds ntfy, Gotify, Telegram and webhook requests', () => {
    const ntfy = buildRequest({ id: '1', kind: 'ntfy', name: 'n', enabled: true, url: 'https://ntfy.sh', topic: 'nas', token: 'tk' }, n)
    expect(ntfy.url).toBe('https://ntfy.sh')
    expect(JSON.parse(ntfy.init.body as string)).toEqual({ topic: 'nas', title: 'nas: Ärger', message: 'Details', priority: 5, tags: ['rotating_light'] })
    expect((ntfy.init.headers as Record<string, string>).authorization).toBe('Bearer tk')
    const gotify = buildRequest({ id: '2', kind: 'gotify', name: 'g', enabled: true, url: 'https://g.lan', token: 'app' }, n)
    expect(gotify.url).toBe('https://g.lan/message')
    expect((gotify.init.headers as Record<string, string>)['x-gotify-key']).toBe('app')
    const tg = buildRequest({ id: '3', kind: 'telegram', name: 't', enabled: true, url: '', token: '123:abc', chatId: '42' }, n)
    expect(tg.url).toBe('https://api.telegram.org/bot123:abc/sendMessage')
    expect(JSON.parse(tg.init.body as string)).toMatchObject({ chat_id: '42', text: 'nas: Ärger\n\nDetails' })
    const wh = JSON.parse(buildRequest(hook, n).init.body as string)
    expect(wh).toMatchObject({ content: 'nas: Ärger\nDetails', text: 'nas: Ärger\nDetails', severity: 'critical' })
  })
})

describe('Notifier', () => {
  it('reports once, waits for flapping checks, sends recoveries and survives a restart', async () => {
    setSetting('notifications', { ...defaultSettings(), channels: [hook] })
    const sent: { title: string; content: string }[] = []
    const send = async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string))
      return new Response('ok')
    }
    const n = new Notifier(send)
    const t0 = 1_000_000
    await n.evaluate(snap({ units: [failedUnit] }), t0)
    await n.evaluate(snap({ units: [failedUnit] }), t0 + 5000)
    expect(sent.map((s) => s.title)).toEqual(['nas-01: backup.service ist fehlgeschlagen'])

    // A web service must be down for 2 minutes.
    const down = snap({
      units: [failedUnit],
      services: [{ name: 'g', note: '', items: [{ key: 'jf', name: 'Jellyfin', url: 'https://jf', host: 'jf', group: 'g', icon: { kind: 'glyph', glyph: 'box' }, iconFallback: 'box', color: '', health: 'bad', source: 'caddy' }] }],
    })
    await n.evaluate(down, t0 + 10_000)
    expect(sent).toHaveLength(1)
    await n.evaluate(down, t0 + 140_000)
    expect(sent.at(-1)!.title).toBe('nas-01: Jellyfin ist nicht erreichbar')

    // Restart: nothing repeated.
    const again = new Notifier(send)
    await again.evaluate(down, t0 + 150_000)
    expect(sent).toHaveLength(2)

    // systemd unreadable: no false recovery.
    await again.evaluate(snap({ services: down.services, sources: { ...snap().sources, systemd: { ok: false, error: 'bus' } } }), t0 + 160_000)
    expect(sent).toHaveLength(2)

    await again.evaluate(snap(), t0 + 170_000)
    expect(sent.at(-1)!.title).toBe('nas-01: 2 Probleme behoben')
    expect(again.state().active).toEqual([])
    expect(again.state().log[0]!.results).toEqual([{ channel: 'Hook', ok: true }])
  })

  it('logs delivery errors instead of throwing', async () => {
    const n = new Notifier(async () => new Response('nope', { status: 403 }))
    const r = await n.deliver({ title: 't', body: '', severity: 'info' }, [hook], true)
    expect(r.results[0]).toMatchObject({ ok: false, error: 'HTTP 403 nope' })
  })

  it('sends the update summary once a day and only when it changed', async () => {
    setSetting('notifications', { ...defaultSettings(), channels: [hook], updatesHour: 8 })
    const sent: string[] = []
    const n = new Notifier(async (_u, init) => {
      sent.push(JSON.parse(init.body as string).message)
      return new Response('ok')
    })
    let pkgs = [{ name: 'linux', from: '6.1', to: '6.2' }]
    const source = { updates: async () => ({ checkedAt: 0, repo: pkgs, aur: [] }), imageUpdates: async () => ({ checkedAt: 0, items: [{ unit: 'a', container: 'jellyfin', image: '', policy: 'registry', updated: 'pending' }] }) }
    await n.checkUpdates('nas', source, new Date(2026, 9, 2, 7))
    expect(sent).toHaveLength(0) // before 08:00
    await n.checkUpdates('nas', source, new Date(2026, 9, 2, 9))
    await n.checkUpdates('nas', source, new Date(2026, 9, 2, 15))
    expect(sent).toEqual(['• 1 Paket-Update\n• neue Images für jellyfin\nInstallieren unter System → Updates'])
    await n.checkUpdates('nas', source, new Date(2026, 9, 3, 9)) // same set
    expect(sent).toHaveLength(1)
    pkgs = [...pkgs, { name: 'podman', from: '5.5', to: '5.6' }]
    await n.checkUpdates('nas', source, new Date(2026, 9, 4, 9))
    expect(sent).toHaveLength(2)
  })
})

describe('Notifier retries', () => {
  it('reports again later when no channel was reached', async () => {
    setSetting('notifications', { ...defaultSettings(), channels: [hook] })
    setSetting('notifications-active', [])
    let fail = true
    const titles: string[] = []
    const n = new Notifier(async (_u, init) => {
      titles.push(JSON.parse(init.body as string).title)
      return fail ? new Response('down', { status: 502 }) : new Response('ok')
    })
    const s = snap({ units: [failedUnit] })
    await n.evaluate(s, 0)
    await n.evaluate(s, 60_000)
    expect(titles).toHaveLength(1)
    expect(n.state().active).toEqual([])
    fail = false
    await n.evaluate(s, 301_000)
    expect(titles).toHaveLength(2)
    await n.evaluate(s, 400_000)
    expect(titles).toHaveLength(2)
  })
})

describe('e-mail', () => {
  const mail: Channel = { id: 'mail', kind: 'email', name: 'Mail', enabled: true, url: '', host: 'smtp.gmail.com', port: 465, security: 'tls', user: 'ich@gmail.com', token: 'abcd efgh ijkl mnop', from: 'ich@gmail.com', to: 'ich@gmail.com; partner@example.org' }

  it('validates the SMTP settings and keeps the password masked', async () => {
    const { channelErrors, recipients } = await import('~/shared/notify')
    const s = parseSettings({ ...defaultSettings(), channels: [mail] }, defaultSettings())
    expect(s.channels[0]).toMatchObject({ kind: 'email', url: '', host: 'smtp.gmail.com', port: 465, security: 'tls', to: 'ich@gmail.com, partner@example.org', token: 'abcd efgh ijkl mnop' })
    expect(maskSettings(s).channels[0]!.token).toBe(MASK)
    expect(parseSettings({ ...defaultSettings(), channels: [{ ...mail, token: MASK }] }, s).channels[0]!.token).toBe('abcd efgh ijkl mnop')
    expect(recipients('a@b.de, c@d.de;e@f.de')).toEqual(['a@b.de', 'c@d.de', 'e@f.de'])
    const err = (c: Partial<Channel>) => channelErrors({ ...mail, ...c }).join(' · ')
    expect(err({})).toBe('')
    expect(err({ security: 'none' })).toMatch(/nur mit Verschlüsselung/)
    expect(err({ security: 'none', user: undefined, token: undefined })).toBe('') // relay in the own network
    expect(err({ token: undefined })).toMatch(/Passwort fehlt/)
    expect(err({ host: 'smtp example' })).toMatch(/SMTP-Server/)
    expect(err({ port: 70000 })).toMatch(/Port/)
    expect(err({ to: 'kein-mail' })).toMatch(/Empfänger/)
    expect(err({ from: 'Server <a@b.de>' })).toMatch(/Absender/)
  })

  it('builds subject and body and is sent through the mailer, not HTTP', async () => {
    const { buildMail } = await import('~/shared/notify')
    const m = buildMail(mail, { title: 'nas-01: 1 Problem', body: '• backup.service ist fehlgeschlagen', severity: 'critical' })
    expect(m).toMatchObject({ from: 'ich@gmail.com', to: ['ich@gmail.com', 'partner@example.org'], subject: '🔴 nas-01: 1 Problem' })
    expect(m.text).toMatch(/^• backup.service ist fehlgeschlagen\n\n-- \nGesendet von Quadeck/)
    const sent: string[] = []
    const n = new Notifier(
      async () => new Response('', { status: 500 }),
      async (_c, msg) => void sent.push(msg.subject),
    )
    const r = await n.deliver({ title: 'Test', body: '', severity: 'info' }, [mail], true)
    expect(r.results).toEqual([{ channel: 'Mail', ok: true }])
    expect(sent).toEqual(['Test'])
    const failing = new Notifier(undefined, async () => {
      throw new Error('Anmeldung abgelehnt')
    })
    expect((await failing.deliver({ title: 'x', body: '', severity: 'info' }, [mail])).results[0]).toEqual({ channel: 'Mail', ok: false, error: 'Anmeldung abgelehnt' })
  })

  it('talks SMTP to a real server (local test server, no TLS)', async () => {
    const { createServer } = await import('node:net')
    const { sendMail, smtpError } = await import('~/server/mail')
    let data = ''
    const rcpt: string[] = []
    const server = createServer((sock) => {
      let inData = false
      sock.write('220 test ESMTP\r\n')
      sock.on('data', (buf) => {
        for (const line of buf.toString().split('\r\n')) {
          if (inData) {
            if (line === '.') {
              inData = false
              sock.write('250 queued\r\n')
            } else data += line + '\n'
            continue
          }
          if (/^(EHLO|HELO)/i.test(line)) sock.write('250-test\r\n250 8BITMIME\r\n')
          else if (/^MAIL FROM/i.test(line)) sock.write('250 ok\r\n')
          else if (/^RCPT TO:<(.*)>/i.test(line)) rcpt.push(line.match(/<(.*)>/)![1]!), sock.write('250 ok\r\n')
          else if (/^DATA/i.test(line)) (inData = true), sock.write('354 go\r\n')
          else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n')
        }
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      await sendMail({ ...mail, host: '127.0.0.1', port, security: 'none', user: undefined, token: undefined }, { from: 'nas@example.org', to: ['ich@example.org', 'du@example.org'], subject: '🔴 nas-01: Probleme', text: 'backup.service ist fehlgeschlagen\n' })
    } finally {
      server.close()
    }
    expect(rcpt).toEqual(['ich@example.org', 'du@example.org'])
    expect(data).toMatch(/Subject: =\?UTF-8\?/)
    expect(data).toMatch(/backup.service ist fehlgeschlagen/)
    expect(smtpError({ message: 'Invalid login', code: 'EAUTH', response: '535 5.7.8 Username and Password not accepted' })).toMatch(/App-Passwort/)
    expect(smtpError({ message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' })).toMatch(/Server und Port/)
    expect(smtpError({ message: 'routines:ssl3_get_record:wrong version number', code: 'ESOCKET' })).toMatch(/465.*SSL\/TLS.*587.*STARTTLS/)
  })
})
