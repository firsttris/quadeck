import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { config } from '~/server/config'
import { authed, readJson } from '~/server/http'
import { drain, nextSpeedRun, runInternetTest, saveSpeed, setSpeedSchedule, speedCheck, speedCheckMessage, speedHistory, speedRunning, speedSchedule, speedSeries, testData } from '~/server/speedtest'
import { hubReady } from '~/server/hub'
import { notifier } from '~/server/notify'
import { assertWritable } from '~/server/guard'
import { currentLang, localize, msg } from '~/shared/i18n'
import type { SpeedResult } from '~/shared/speedtest'

// Speed test. GET → { history, schedule, next, series, alert } · ?ping → { t } · ?down=<bytes> → test data.
// POST ?up → reads the body, { bytes } · { internet: true } → server ↔ internet (NDJSON progress) ·
// { client: result } → saves what the page measured · { schedule } → automatic runs.
const rule = () => {
  const n = notifier().settings()
  return { enabled: !!n.rules.internet, speedMode: n.speedMode, speedPercent: n.speedPercent, speedMbit: n.speedMbit }
}

const NO_CACHE = { 'cache-control': 'no-store', 'content-encoding': 'identity' }

export const Route = createFileRoute('/api/speedtest/')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const q = new URL(request.url).searchParams
        if (q.has('ping')) return Response.json({ t: Date.now() }, { headers: NO_CACHE })
        const down = q.get('down')
        if (down !== null) return new Response(testData(Number(down) || 0), { headers: { ...NO_CACHE, 'content-type': 'application/octet-stream' } })
        return Response.json({ history: speedHistory(), running: speedRunning(), schedule: speedSchedule(), next: nextSpeedRun(), series: speedSeries(), alert: speedCheckMessage(speedCheck()) })
      }),
      POST: authed(async ({ request }) => {
        const lang = currentLang()
        if (new URL(request.url).searchParams.has('up')) return Response.json({ bytes: await drain(request.body) }, { headers: NO_CACHE })
        const b = await readJson<{ internet?: unknown; client?: Partial<SpeedResult>; schedule?: unknown }>(request)
        if (b.schedule !== undefined) {
          assertWritable()
          const schedule = setSpeedSchedule(b.schedule)
          return Response.json({ schedule, next: nextSpeedRun() })
        }
        if (b.internet === true) {
          // One run at a time. The answer is a stream: progress lines, then the result (NDJSON).
          if (speedRunning()) throw new HttpError(409, msg('speed_error_running'))
          const enc = new TextEncoder()
          const stream = new ReadableStream<Uint8Array>({
            start(ctrl) {
              const send = (o: unknown) => {
                try {
                  ctrl.enqueue(enc.encode(JSON.stringify(o) + '\n'))
                } catch {
                  // page closed
                }
              }
              runInternetTest({ demo: !!config().fixturesDir, rule: rule(), onProgress: send })
                .then(async (r) => {
                  void hubReady().then((h) => h.publish())
                  send({ result: r, history: speedHistory(), series: speedSeries() })
                })
                .catch((e: Error) => send({ error: localize(e.message, lang) }))
                .finally(() => {
                  try {
                    ctrl.close()
                  } catch {
                    // closed
                  }
                })
            },
          })
          return new Response(stream, { headers: { ...NO_CACHE, 'content-type': 'application/x-ndjson' } })
        }
        const c = b.client
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e6 ? Math.round(v * 10) / 10 : undefined)
        if (c && num(c.down) !== undefined && num(c.up) !== undefined && num(c.ping) !== undefined) {
          const r: SpeedResult = { at: Date.now(), kind: 'client', down: num(c.down)!, up: num(c.up)!, ping: num(c.ping)!, jitter: num(c.jitter) ?? 0, where: typeof c.where === 'string' ? c.where.slice(0, 60) : undefined }
          return Response.json({ result: r, history: saveSpeed(r) })
        }
        throw new HttpError(400, msg('common_errors_unknownRequest'))
      }),
    },
  },
})
