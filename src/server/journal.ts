// Live journal: `journalctl -o json -f` per unit, streamed as SSE.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JournalEntry } from '~/shared/types'
import { config } from './config'

const UNIT = /^[A-Za-z0-9:_.\\@-]{1,240}$/

function messageText(m: unknown): string {
  if (typeof m === 'string') return m
  if (Array.isArray(m)) return Buffer.from(m as number[]).toString('utf8') // binary-safe MESSAGE
  return ''
}

export function parseJournalLine(line: string): JournalEntry | undefined {
  try {
    const o = JSON.parse(line) as Record<string, unknown>
    const unit = (o.CONTAINER_NAME ?? o._SYSTEMD_UNIT ?? o.SYSLOG_IDENTIFIER ?? o._COMM ?? '') as string
    return {
      ts: Math.floor(Number(o.__REALTIME_TIMESTAMP) / 1000),
      unit: String(unit).replace(/\.service$/, ''),
      priority: Number(o.PRIORITY ?? 6),
      message: messageText(o.MESSAGE),
      cursor: o.__CURSOR as string | undefined,
    }
  } catch {
    return undefined
  }
}

export function journalArgs(opts: { unit?: string; priority?: number; lines?: number }): string[] {
  const args = ['journalctl', '-o', 'json', '--no-pager', '-f', '-n', String(opts.lines ?? 200)]
  if (opts.unit) {
    if (!UNIT.test(opts.unit) || opts.unit.startsWith('-')) throw new Error('Ungültige Unit')
    args.push('-u', opts.unit)
  }
  if (opts.priority !== undefined && !(Number.isInteger(opts.priority) && opts.priority >= 0 && opts.priority <= 7)) throw new Error('Ungültige Priorität')
  if (opts.priority !== undefined) args.push('-p', `0..${opts.priority}`)
  return args
}

const encoder = new TextEncoder()
const sse = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

export function journalStream(opts: { unit?: string; priority?: number }, signal: AbortSignal, stillAllowed: () => boolean = () => true): ReadableStream<Uint8Array> {
  const args = journalArgs(opts)
  const fixtures = config().fixturesDir
  let cleanup = () => {}
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: JournalEntry) => {
        try {
          controller.enqueue(sse('entry', e))
        } catch {
          cleanup()
        }
      }
      const ping = setInterval(() => {
        try {
          if (!stillAllowed()) {
            cleanup()
            controller.close()
            return
          }
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          cleanup()
        }
      }, 15_000)

      if (fixtures) {
        let entries: JournalEntry[] = []
        try {
          entries = JSON.parse(readFileSync(join(fixtures, 'journal.json'), 'utf8'))
          const newest = Math.max(...entries.map((e) => e.ts))
          entries = entries.map((e) => ({ ...e, ts: e.ts - newest + Date.now() - 60_000 }))
        } catch {
          entries = []
        }
        const match = (e: JournalEntry) => (!opts.unit || e.unit === opts.unit.replace(/\.service$/, '')) && (opts.priority === undefined || e.priority <= opts.priority)
        entries.filter(match).forEach(send)
        let i = 0
        const t = setInterval(() => {
          const src = entries.filter(match)
          if (!src.length) return
          send({ ...src[i++ % src.length]!, ts: Date.now() })
        }, 3000)
        cleanup = () => {
          clearInterval(t)
          clearInterval(ping)
        }
      } else {
        const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
        cleanup = () => {
          clearInterval(ping)
          proc.kill()
        }
        ;(async () => {
          const decoder = new TextDecoder()
          let buf = ''
          for await (const chunk of proc.stdout) {
            buf += decoder.decode(chunk, { stream: true })
            let nl
            while ((nl = buf.indexOf('\n')) >= 0) {
              const e = parseJournalLine(buf.slice(0, nl))
              buf = buf.slice(nl + 1)
              if (e) send(e)
            }
          }
          try {
            controller.enqueue(sse('end', {}))
            controller.close()
          } catch {
            // already closed
          }
        })().catch(() => cleanup())
      }
      signal.addEventListener('abort', () => {
        cleanup()
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
    },
    cancel() {
      cleanup()
    },
  })
}
