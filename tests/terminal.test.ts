import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { demoSpawner } from '~/server/terminal/demo'
import { SCROLLBACK, TerminalManager, clampSize, type OpenSpec } from '~/server/terminal/sessions'
import { Gate } from '~/server/privileged/gate'
import { ctrlKey, isLocalAddress, parseTerminalSettings } from '~/shared/terminal'

process.env.QUADECK_DATA_DIR = mkdtempSync(join(tmpdir(), 'quadeck-term-'))
const web = await import('~/server/terminal/web')
const { PEER_HEADER } = await import('~/server/auth')

const spec = (over: Partial<OpenSpec> = {}): OpenSpec => ({ argv: ['bash', '--noprofile', '--norc', '-i'], env: { PS1: '$ ', PATH: process.env.PATH! }, cols: 80, rows: 24, owner: 'tok', label: 'me@test', kind: 'shell', user: 'me', idleMs: 60_000, ...over })

/** Reads a terminal stream into text (decoded output) until `until` shows up or the time is over. */
async function read(res: Response, until: (text: string, raw: string) => boolean, ms = 4000) {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let raw = ''
  const text = () => [...raw.matchAll(/event: data\ndata: (.*)\n/g)].map((x) => Buffer.from(x[1]!, 'base64').toString()).join('')
  const end = Date.now() + ms
  while (Date.now() < end && !until(text(), raw)) {
    const r = await Promise.race([reader.read(), Bun.sleep(100).then(() => null)])
    if (r?.done) break
    if (r?.value) raw += dec.decode(r.value)
  }
  void reader.cancel()
  return { text: text(), raw }
}

describe('terminal sessions (real pseudo terminal)', () => {
  it('runs a shell: input, output, window size, exit', { timeout: 20_000 }, async () => {
    const m = new TerminalManager(() => {})
    const info = m.open(spec({ cols: 90, rows: 20 }))
    expect(info).toMatchObject({ kind: 'shell', label: 'me@test', user: 'me' })
    const res = m.stream(info.id)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    m.input(info.id, 'stty size; echo out-$((40+2))\r')
    const a = await read(res, (t) => t.includes('out-42'))
    expect(a.text).toContain('20 90')
    expect(a.raw).toContain('event: info')
    m.resize(info.id, 132, 43)
    const res2 = m.stream(info.id)
    m.input(info.id, 'stty size; exit\r')
    const b = await read(res2, (_t, raw) => raw.includes('event: exit'))
    expect(b.text).toContain('out-42') // the screen so far comes first (reconnect)
    expect(b.text).toContain('43 132')
    expect(b.raw).toContain('event: exit\ndata: 0')
    await Bun.sleep(50)
    expect(m.has(info.id)).toBe(false)
    expect(() => m.input(info.id, 'x')).toThrow()
  })

  it('ends after the idle time; output alone does not count as activity', async () => {
    const lines: string[] = []
    const m = new TerminalManager((l) => lines.push(l))
    const info = m.open(spec({ argv: ['sh', '-c', 'while true; do echo tick; sleep 0.05; done'], idleMs: 400 }))
    await Bun.sleep(1200)
    expect(m.has(info.id)).toBe(false)
    expect(lines.some((l) => l.includes('without input'))).toBe(true)
    expect(lines[0]).toContain('terminal opened: shell "me@test" as me')
  })

  it('locking ends the sessions of that unlock only; limits and checks', async () => {
    const m = new TerminalManager(() => {})
    const a = m.open(spec({ argv: ['sleep', '30'], owner: 'a' }))
    const b = m.open(spec({ argv: ['sleep', '30'], owner: 'b' }))
    m.closeOwner('a')
    await Bun.sleep(300)
    expect(m.has(a.id)).toBe(false)
    expect(m.has(b.id)).toBe(true)
    expect(() => m.input(b.id, 'x'.repeat(70_000))).toThrow()
    expect(() => m.stream('nope')).toThrow()
    for (let i = 0; i < 7; i++) m.open(spec({ argv: ['sleep', '30'], owner: 'b' }))
    expect(() => m.open(spec({ argv: ['sleep', '30'], owner: 'b' }))).toThrow(/8/)
    m.closeOwner('b')
    expect(clampSize(1, 1)).toEqual({ cols: 10, rows: 4 })
    expect(clampSize(9999, NaN)).toEqual({ cols: 500, rows: 24 })
  })

  it('keeps at most 128 KiB of screen for reconnecting', { timeout: 30_000 }, async () => {
    const m = new TerminalManager(() => {})
    const info = m.open(spec({ argv: ['sh', '-c', 'sleep 0.3; head -c 400000 /dev/zero | tr "\\0" x; echo; echo END-MARK; sleep 5'] }))
    // wait until everything was written …
    await read(m.stream(info.id), (t) => t.includes('END-MARK'), 15_000)
    // … then a new reader gets only the last 128 KiB
    const { text } = await read(m.stream(info.id), (t) => t.includes('END-MARK'), 5000)
    expect(text).toContain('END-MARK')
    expect(text.length).toBe(SCROLLBACK) // ASCII: one byte per character
    m.close(info.id)
  })
})

describe('the demo terminal', () => {
  it('pretends: echo, line editing, commands, Ctrl+C, exit – no process', async () => {
    const m = new TerminalManager(() => {}, demoSpawner)
    const info = m.open(spec({ argv: ['/bin/false'], label: 'tristan@nas-01', user: 'tristan' }))
    const res = m.stream(info.id)
    m.input(info.id, 'whoamx\x7fi\r')
    m.input(info.id, 'rm -rf /\r')
    m.input(info.id, 'abc\x03')
    m.input(info.id, 'exit\r')
    const { text, raw } = await read(res, (_t, r) => r.includes('event: exit'))
    expect(text).toContain('Quadeck demo')
    expect(text).toContain('whoamx\b \bi\r\ntristan') // backspace erased the x, whoami answered
    expect(text).toContain('rm: demo only')
    expect(text).toContain('^C')
    expect(raw).toContain('event: exit\ndata: 0')
  })
})

describe('home network, keys, settings', () => {
  it('knows local addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.178.20', '100.101.102.103', '169.254.1.1', '::1', 'fd12:3456::1', 'fe80::1%eth0', '::ffff:192.168.1.5', '[fd00::5]:443']) expect(isLocalAddress(a)).toBe(true)
    for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '2a01:4f8::1', 'unknown', '']) expect(isLocalAddress(a)).toBe(false)
  })
  it('control keys and settings', () => {
    expect(ctrlKey('c')).toBe('\x03')
    expect(ctrlKey('D')).toBe('\x04')
    expect(ctrlKey('[')).toBe('\x1b')
    expect(ctrlKey('1')).toBeUndefined()
    expect(parseTerminalSettings({})).toEqual({ enabled: false, localOnly: true, idleMinutes: 15 })
    expect(parseTerminalSettings({ enabled: true, localOnly: false, idleMinutes: 60 })).toEqual({ enabled: true, localOnly: false, idleMinutes: 60 })
    expect(parseTerminalSettings({ enabled: 'yes', idleMinutes: 7 })).toEqual({ enabled: false, localOnly: true, idleMinutes: 15 })
  })
  it('the web app: off by default, home network only, only the owner', () => {
    const req = (peer: string) => new Request('http://x/', { headers: { [PEER_HEADER]: peer } })
    expect(() => web.assertTerminalAllowed(req('192.168.1.5'))).toThrow(/aus|off/i)
    web.setTerminalSettings({ enabled: true })
    expect(() => web.assertTerminalAllowed(req('192.168.1.5'))).not.toThrow()
    expect(() => web.assertTerminalAllowed(req('203.0.113.9'))).toThrow()
    web.setTerminalSettings({ enabled: true, localOnly: false })
    expect(() => web.assertTerminalAllowed(req('203.0.113.9'))).not.toThrow()
    web.remember({ id: 't1', kind: 'shell', label: 'x', user: 'u', startedAt: 1 }, 'session-a')
    expect(web.owned('t1', 'session-a')).toBe('t1')
    expect(() => web.owned('t1', 'session-b')).toThrow()
    expect(() => web.owned(5, 'session-a')).toThrow()
    expect(web.ownedBy('session-a')).toHaveLength(1)
  })
  it('the unlock remembers who unlocked, and locking is announced', async () => {
    const g = new Gate('quadeck', 15, { verifyQuadeck: async (pw) => pw === 'ok' })
    const locked: string[] = []
    g.onLock((t) => locked.push(t))
    const { token } = await g.unlock('', 'ok')
    expect(g.userOf(token)).toBe(g.info().suggestedUser)
    expect(g.userOf('forged')).toBeUndefined()
    g.lock(token)
    expect(locked).toEqual([token])
    expect(g.userOf(token)).toBeUndefined()
  })
})
