// Terminal sessions (root helper): a shell or `podman exec` in a pseudo terminal (Bun's
// `terminal` spawn option). Output goes to any attached readers as server-sent events (base64,
// with a ping every 8 s so quiet connections stay open); the last 128 KiB are kept so a reconnecting page
// gets the screen back. Input resets the idle timer, output does not (htop alone keeps nothing
// alive). Sessions belong to the unlock token that opened them: locking ends them.

import { randomBytes } from 'node:crypto'
import { msg } from '~/shared/i18n'
import type { TerminalInfo } from '~/shared/terminal'
import { HttpError } from '../auth'

export const SCROLLBACK = 128 * 1024
/** Below Bun's 10 s idle timeout, so a quiet shell keeps its connection. */
const PING_MS = 8_000
const MAX_SESSIONS = 8

interface Term {
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  close(): void
}

export interface OpenSpec {
  argv: string[]
  env?: Record<string, string>
  cwd?: string
  cols: number
  rows: number
  owner: string
  label: string
  kind: TerminalInfo['kind']
  user: string
  idleMs: number
}

/** What runs in a session: a real pseudo terminal, or the demo's pretend shell. */
export interface Spawned {
  term: Term
  kill(sig?: string): void
  exited: Promise<number>
}
export type Spawner = (spec: OpenSpec, onData: (chunk: Uint8Array) => void) => Spawned

export const ptySpawner: Spawner = (spec, onData) => {
  const { cols, rows } = clampSize(spec.cols, spec.rows)
  const proc = Bun.spawn(spec.argv, {
    cwd: spec.cwd,
    env: { ...spec.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    terminal: { cols, rows, data: (_t: unknown, chunk: Uint8Array) => onData(new Uint8Array(chunk)) },
  } as unknown as Parameters<typeof Bun.spawn>[1]) as unknown as { terminal: Term; kill(sig?: string): void; exited: Promise<number> }
  return { term: proc.terminal, kill: (sig) => proc.kill(sig as never), exited: proc.exited }
}

interface Session {
  info: TerminalInfo
  owner: string
  proc: Spawned
  term: Term
  buffer: Uint8Array[]
  size: number
  readers: Set<ReadableStreamDefaultController<Uint8Array>>
  idle?: ReturnType<typeof setTimeout>
  idleMs: number
}

const enc = new TextEncoder()
const event = (name: string, data: string) => enc.encode(`event: ${name}\ndata: ${data}\n\n`)
const b64 = (d: Uint8Array) => Buffer.from(d).toString('base64')

export const clampSize = (cols: number, rows: number) => ({ cols: Math.min(500, Math.max(10, Math.floor(cols) || 80)), rows: Math.min(200, Math.max(4, Math.floor(rows) || 24)) })

export class TerminalManager {
  private sessions = new Map<string, Session>()

  constructor(
    private log: (line: string) => void = (l) => console.log(`[quadeck-helper] ${l}`),
    private spawn: Spawner = ptySpawner,
  ) {}

  open(spec: OpenSpec): TerminalInfo {
    if ([...this.sessions.values()].filter((s) => s.owner === spec.owner).length >= MAX_SESSIONS) throw new HttpError(429, msg('terminal_error_tooMany', { n: MAX_SESSIONS }))
    const id = randomBytes(24).toString('base64url')
    let session: Session | undefined
    const pending: Uint8Array[] = []
    const proc = this.spawn(spec, (chunk) => {
      if (session) this.output(session, chunk)
      else pending.push(chunk)
    })
    session = {
      info: { id, kind: spec.kind, label: spec.label, user: spec.user, startedAt: Date.now() },
      owner: spec.owner,
      proc,
      term: proc.term,
      buffer: [],
      size: 0,
      readers: new Set(),
      idleMs: spec.idleMs,
    }
    this.sessions.set(id, session)
    for (const c of pending) this.output(session, c)
    this.touch(session)
    this.log(`terminal opened: ${spec.kind} "${spec.label}" as ${spec.user}`)
    const s = session
    void proc.exited.then((code) => {
      this.log(`terminal closed: ${spec.kind} "${spec.label}" (exit ${code})`)
      for (const r of s.readers) {
        try {
          r.enqueue(event('exit', String(code)))
          r.close()
        } catch {
          // reader already gone
        }
      }
      s.readers.clear()
      clearTimeout(s.idle)
      try {
        s.term.close()
      } catch {
        // already closed
      }
      this.sessions.delete(id)
    })
    return session.info
  }

  private output(s: Session, chunk: Uint8Array) {
    s.buffer.push(chunk)
    s.size += chunk.length
    // keep exactly the last SCROLLBACK bytes (cut into the oldest chunk rather than drop it whole)
    while (s.size > SCROLLBACK) {
      const over = s.size - SCROLLBACK
      const first = s.buffer[0]!
      if (first.length <= over) s.buffer.shift()
      else s.buffer[0] = first.subarray(over)
      s.size -= Math.min(first.length, over)
    }
    const e = event('data', b64(chunk))
    for (const r of s.readers) {
      try {
        r.enqueue(e)
      } catch {
        s.readers.delete(r)
      }
    }
  }

  private touch(s: Session) {
    clearTimeout(s.idle)
    s.idle = setTimeout(() => {
      this.log(`terminal ended after ${Math.round(s.idleMs / 60_000)} min without input: "${s.info.label}"`)
      this.kill(s)
    }, s.idleMs)
  }

  private kill(s: Session) {
    try {
      s.proc.kill('SIGHUP')
    } catch {
      // gone
    }
    setTimeout(() => {
      if (this.sessions.get(s.info.id) === s) s.proc.kill('SIGKILL')
    }, 3000)
  }

  private get(id: string, owner?: string): Session {
    const s = this.sessions.get(id)
    if (!s || (owner !== undefined && s.owner !== owner)) throw new HttpError(404, msg('terminal_error_gone'))
    return s
  }

  /** Server-sent events: the scrollback first, then live output, `exit` at the end, pings meanwhile. */
  stream(id: string): Response {
    const s = this.get(id)
    let ping: ReturnType<typeof setInterval> | undefined
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctrl = c
        c.enqueue(event('info', JSON.stringify(s.info)))
        if (s.size) c.enqueue(event('data', b64(Buffer.concat(s.buffer))))
        s.readers.add(c)
        ping = setInterval(() => {
          try {
            c.enqueue(enc.encode(': ping\n\n'))
          } catch {
            clearInterval(ping)
          }
        }, PING_MS)
      },
      cancel: () => {
        clearInterval(ping)
        if (ctrl) s.readers.delete(ctrl)
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
  }

  input(id: string, data: string) {
    const s = this.get(id)
    if (data.length > 64 * 1024) throw new HttpError(413, msg('terminal_error_input'))
    s.term.write(data)
    this.touch(s)
  }

  resize(id: string, cols: number, rows: number) {
    const s = this.get(id)
    const size = clampSize(cols, rows)
    s.term.resize(size.cols, size.rows)
  }

  close(id: string) {
    this.kill(this.get(id))
  }

  /** Locking ends every session of that unlock. */
  closeOwner(owner: string) {
    for (const s of this.sessions.values()) if (s.owner === owner) this.kill(s)
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  has(id: string) {
    return this.sessions.has(id)
  }
}
