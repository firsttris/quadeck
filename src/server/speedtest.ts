// Speed test. Between the browser and the server: the server sends and
// receives test data (/api/speedtest). Between the server and the internet:
// Cloudflare's speed test endpoints (speed.cloudflare.com), measured by the
// web app itself – no root, nothing to install.

import { randomBytes } from 'node:crypto'
import { getSetting, setSetting } from './settings'
import { mbps, pingStats, SPEED_HISTORY, type SpeedResult } from '~/shared/speedtest'

const CHUNK = randomBytes(1024 * 1024)
/** Upper limit of one download request from the page. */
export const MAX_DOWN = 200 * 1024 * 1024

/** `bytes` of test data (random, so compression does not cheat). */
export function testData(bytes: number): ReadableStream<Uint8Array> {
  let left = Math.max(0, Math.min(MAX_DOWN, Math.floor(bytes)))
  return new ReadableStream({
    pull(ctrl) {
      if (left <= 0) return ctrl.close()
      const n = Math.min(left, CHUNK.length)
      ctrl.enqueue(new Uint8Array(CHUNK.subarray(0, n)))
      left -= n
    },
  })
}

/** Reads a request body to the end; returns its size (the upload test). */
export async function drain(body: ReadableStream<Uint8Array> | null, limit = 64 * 1024 * 1024): Promise<number> {
  if (!body) return 0
  let n = 0
  const reader = body.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    n += value.length
    if (n > limit) {
      await reader.cancel()
      break
    }
  }
  return n
}

export function speedHistory(): SpeedResult[] {
  return getSetting<SpeedResult[]>('speedtest.history') ?? []
}

export function saveSpeed(r: SpeedResult): SpeedResult[] {
  const list = [r, ...speedHistory()].slice(0, SPEED_HISTORY)
  setSetting('speedtest.history', list)
  return list
}

const CF = 'https://speed.cloudflare.com'

/** Parallel requests for `ms`, counting bytes as they arrive (download) or when a request is done (upload). */
export type SpeedProgress = { phase: 'ping' | 'down' | 'up'; value: number; done?: number }

async function measure(ms: number, parallel: number, one: (signal: AbortSignal, count: (n: number) => void) => Promise<void>, onTick?: (mbit: number, done: number) => void): Promise<number> {
  const ctrl = new AbortController()
  let bytes = 0
  const start = performance.now()
  const timer = setTimeout(() => ctrl.abort(), ms)
  const tick = onTick && setInterval(() => onTick(mbps(bytes, performance.now() - start), Math.min(1, (performance.now() - start) / ms)), 250)
  const worker = async () => {
    // Also by the clock: a very fast source would never let the timer run.
    while (!ctrl.signal.aborted && performance.now() - start < ms) {
      try {
        await one(ctrl.signal, (n) => (bytes += n))
      } catch (e) {
        if (!ctrl.signal.aborted) throw e
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: parallel }, worker))
  } finally {
    clearTimeout(timer)
    if (tick) clearInterval(tick)
  }
  return mbps(bytes, performance.now() - start)
}

/** Server ↔ internet through Cloudflare: ping, then download and upload for a few seconds each. */
export async function internetSpeed(opts: { seconds?: number; fetchImpl?: typeof fetch; onProgress?: (p: SpeedProgress) => void } = {}): Promise<SpeedResult> {
  const f = opts.fetchImpl ?? fetch
  const report = opts.onProgress ?? (() => {})
  const ms = (opts.seconds ?? 6) * 1000
  const times: number[] = []
  let where: string | undefined
  for (let i = 0; i < 8; i++) {
    const t = performance.now()
    const r = await f(`${CF}/__down?bytes=0`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    await r.arrayBuffer()
    times.push(performance.now() - t)
    where ??= r.headers.get('cf-meta-colo') ?? undefined
    report({ phase: 'ping', value: Math.round(times.at(-1)!), done: (i + 1) / 8 })
  }
  const down = await measure(
    ms,
    4,
    async (signal, count) => {
      const r = await f(`${CF}/__down?bytes=25000000`, { cache: 'no-store', signal })
      const reader = r.body!.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        count(value.length)
      }
    },
    (v, done) => report({ phase: 'down', value: v, done }),
  )
  const body = new Uint8Array(CHUNK.subarray(0, 1024 * 1024))
  const up = await measure(
    ms,
    4,
    async (signal, count) => {
      for (let i = 0; i < 4 && !signal.aborted; i++) {
        const r = await f(`${CF}/__up`, { method: 'POST', body, signal })
        await r.arrayBuffer()
        count(body.length)
      }
    },
    (v, done) => report({ phase: 'up', value: v, done }),
  )
  return { at: Date.now(), kind: 'internet', down, up, ...pingStats(times), where }
}

/** Demo: plausible numbers after a short wait, no network. */
export async function demoInternetSpeed(onProgress: (p: SpeedProgress) => void = () => {}): Promise<SpeedResult> {
  const j = () => 0.9 + Math.random() * 0.2
  // The same course as a real run, faster.
  for (const [phase, top, steps] of [
    ['ping', 9, 4],
    ['down', 480, 10],
    ['up', 46, 10],
  ] as const)
    for (let i = 1; i <= steps; i++) {
      await new Promise((r) => setTimeout(r, 120))
      onProgress({ phase, value: Math.round(top * Math.min(1, (i / steps) * 1.6) * j()), done: i / steps })
    }
  return { at: Date.now(), kind: 'internet', down: Math.round(480 * j()), up: Math.round(46 * j()), ping: Math.round(9 * j() * 10) / 10, jitter: 1.4, where: 'FRA' }
}
