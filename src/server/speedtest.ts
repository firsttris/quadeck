// Speed test. Between the browser and the server: the server sends and
// receives test data (/api/speedtest). Between the server and the internet:
// Cloudflare's speed test endpoints (speed.cloudflare.com), measured by the
// web app itself – no root, nothing to install.

import { randomBytes } from 'node:crypto'
import { and, asc, gte, sql } from 'drizzle-orm'
import { getSetting, setSetting } from './settings'
import { db, schema } from './db'
import { msg } from '~/shared/i18n'
import { DEFAULT_SCHEDULE, judgeSpeed, lastSlot, mbps, pingStats, SPEED_HISTORY, usualDown, type SpeedResult, type SpeedSchedule } from '~/shared/speedtest'

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

// ---------- one run at a time, saved, judged ----------

export type SpeedCheck = { at: number; alert?: 'slow' | 'down'; down?: number; expected?: number; detail?: string; /** A bad result waits for a second one. */ recheckAt?: number }

const CHECK = 'speedtest.check'
const SCHEDULE = 'speedtest.schedule'
const LAST_AUTO = 'speedtest.lastAuto'
const RECHECK_MS = 15 * 60_000

let running: Promise<SpeedResult> | undefined
export const speedRunning = () => !!running

export function speedCheck(): SpeedCheck | undefined {
  return getSetting<SpeedCheck>(CHECK)
}

export function speedSchedule(): SpeedSchedule {
  return { ...DEFAULT_SCHEDULE, ...(getSetting<SpeedSchedule>(SCHEDULE) ?? {}) }
}

export function setSpeedSchedule(v: unknown): SpeedSchedule {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const hour = Number(o.hour)
  const s: SpeedSchedule = { enabled: o.enabled === true, every: o.every === '6h' ? '6h' : 'daily', hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 4 }
  setSetting(SCHEDULE, s)
  return s
}

/** The minute past the hour this server measures at (spreads many servers over the hour). */
export function speedMinute(): number {
  let mnt = getSetting<number>('speedtest.minute')
  if (mnt === undefined) {
    mnt = 5 + Math.floor(Math.random() * 40)
    setSetting('speedtest.minute', mnt)
  }
  return mnt
}

/** When the next automatic run is due. */
export function nextSpeedRun(now = Date.now()): number | undefined {
  const s = speedSchedule()
  if (!s.enabled) return undefined
  const check = speedCheck()
  if (check?.recheckAt) return check.recheckAt
  const step = s.every === '6h' ? 6 * 3600_000 : 86_400_000
  return lastSlot(s, now, speedMinute()) + step
}

/** Download, upload and ping as metrics (one year, for the graph). */
function record(r: SpeedResult) {
  db()
    .insert(schema.metricSamples)
    .values([
      { ts: r.at, metric: 'speed:down', value: r.down },
      { ts: r.at, metric: 'speed:up', value: r.up },
      { ts: r.at, metric: 'speed:ping', value: r.ping },
    ])
    .run()
}

export function speedSeries(days = 365, now = Date.now()): Record<'down' | 'up' | 'ping', [number, number][]> {
  const t = schema.metricSamples
  const rows = db()
    .select({ ts: t.ts, metric: t.metric, value: t.value })
    .from(t)
    .where(and(gte(t.ts, now - days * 86_400_000), sql`${t.metric} LIKE 'speed:%'`))
    .orderBy(asc(t.ts))
    .all()
  const out: Record<'down' | 'up' | 'ping', [number, number][]> = { down: [], up: [], ping: [] }
  for (const r of rows) {
    const k = r.metric.slice(6) as 'down' | 'up' | 'ping'
    if (k in out) out[k].push([r.ts, r.value])
  }
  return out
}

/**
 * Server ↔ internet, one at a time (a second caller waits for the same run). The result is
 * saved, recorded for the graph and judged for the notification rule: a bad result is
 * measured again after 15 minutes and only reported when that one is bad too.
 */
export function runInternetTest(opts: { demo: boolean; auto?: boolean; rule?: { enabled: boolean; speedMode: 'relative' | 'fixed'; speedPercent: number; speedMbit: number }; onProgress?: (p: SpeedProgress) => void }): Promise<SpeedResult> {
  if (running) return running
  const before = speedHistory()
  running = (opts.demo ? demoInternetSpeed(opts.onProgress) : internetSpeed({ onProgress: opts.onProgress }))
    .then((r) => {
      const res: SpeedResult = opts.auto ? { ...r, auto: true } : r
      saveSpeed(res)
      record(res)
      judge(res.down, undefined, before, opts.rule)
      return res
    })
    .catch((e: Error) => {
      judge(undefined, e.message, before, opts.rule)
      throw e
    })
    .finally(() => {
      running = undefined
      if (opts.auto) setSetting(LAST_AUTO, Date.now())
    })
  return running
}

function judge(down: number | undefined, error: string | undefined, before: SpeedResult[], rule: { enabled: boolean; speedMode: 'relative' | 'fixed'; speedPercent: number; speedMbit: number } | undefined) {
  const now = Date.now()
  const prev = speedCheck()
  if (!rule?.enabled) return setSetting(CHECK, { at: now })
  const verdict = down === undefined ? { slow: true, expected: undefined } : judgeSpeed(down, usualDown(before, now), rule)
  if (!verdict.slow) return setSetting(CHECK, { at: now })
  const bad = { at: now, down, expected: verdict.expected, detail: error }
  // First bad result: measure again before telling anyone.
  if (!prev?.recheckAt && !prev?.alert) return setSetting(CHECK, { ...bad, recheckAt: now + RECHECK_MS })
  setSetting(CHECK, { ...bad, alert: down === undefined ? 'down' : 'slow' })
}

/** Called every minute by the hub: runs the automatic test when it is due. */
export async function speedTick(opts: { demo: boolean; rule: { enabled: boolean; speedMode: 'relative' | 'fixed'; speedPercent: number; speedMbit: number } }, now = Date.now()): Promise<boolean> {
  const s = speedSchedule()
  if (!s.enabled || running) return false
  const check = speedCheck()
  const last = getSetting<number>(LAST_AUTO) ?? 0
  const due = check?.recheckAt ? now >= check.recheckAt : lastSlot(s, now, speedMinute()) > last
  if (!due) return false
  await runInternetTest({ demo: opts.demo, auto: true, rule: opts.rule }).catch(() => undefined)
  return true
}

export const speedCheckMessage = (c: SpeedCheck | undefined) =>
  c?.alert === 'down' ? msg('speed_alert_down', { detail: c.detail ?? '' }) : c?.alert === 'slow' ? msg('speed_alert_slow', { down: Math.round(c.down ?? 0), expected: Math.round(c.expected ?? 0) }) : undefined

/** Demo: two months of daily measurements for the graph (once). */
export function seedSpeedHistory(now = Date.now()) {
  const t = schema.metricSamples
  if (
    db()
      .select({ n: sql<number>`count(*)` })
      .from(t)
      .where(sql`${t.metric} LIKE 'speed:%'`)
      .get()!.n > 0
  )
    return
  const rows: { ts: number; metric: string; value: number }[] = []
  let seed = 11
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let d = 60; d >= 1; d--) {
    const ts = now - d * 86_400_000
    const dip = d === 23 || d === 22 ? 0.35 : 1 // a bad evening at the provider
    rows.push(
      { ts, metric: 'speed:down', value: Math.round(470 * dip * (0.9 + rnd() * 0.15)) },
      { ts, metric: 'speed:up', value: Math.round(46 * (0.9 + rnd() * 0.15)) },
      { ts, metric: 'speed:ping', value: Math.round((8 + rnd() * 4) * 10) / 10 },
    )
  }
  db().insert(t).values(rows).run()
}
