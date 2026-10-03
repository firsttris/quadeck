import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '~/server/auth'
import { config } from '~/server/config'
import { authed, readJson } from '~/server/http'
import { demoInternetSpeed, drain, internetSpeed, saveSpeed, speedHistory, testData } from '~/server/speedtest'
import { currentLang, localize, msg } from '~/shared/i18n'
import type { SpeedResult } from '~/shared/speedtest'

// Speed test. GET → { history } · ?ping → { t } · ?down=<bytes> → test data.
// POST ?up → reads the body, { bytes } · { internet: true } → server ↔ internet, saved ·
// { client: result } → saves what the page measured.
let running: Promise<SpeedResult> | undefined

const NO_CACHE = { 'cache-control': 'no-store', 'content-encoding': 'identity' }

export const Route = createFileRoute('/api/speedtest/')({
  server: {
    handlers: {
      GET: authed(async ({ request }) => {
        const q = new URL(request.url).searchParams
        if (q.has('ping')) return Response.json({ t: Date.now() }, { headers: NO_CACHE })
        const down = q.get('down')
        if (down !== null) return new Response(testData(Number(down) || 0), { headers: { ...NO_CACHE, 'content-type': 'application/octet-stream' } })
        return Response.json({ history: speedHistory(), running: !!running })
      }),
      POST: authed(async ({ request }) => {
        const lang = currentLang()
        if (new URL(request.url).searchParams.has('up')) return Response.json({ bytes: await drain(request.body) }, { headers: NO_CACHE })
        const b = await readJson<{ internet?: unknown; client?: Partial<SpeedResult> }>(request)
        if (b.internet === true) {
          // One run at a time. The answer is a stream: progress lines, then the result (NDJSON).
          if (running) throw new HttpError(409, msg('speed_error_running'))
          const enc = new TextEncoder()
          let send: (o: unknown) => void = () => {}
          const stream = new ReadableStream<Uint8Array>({
            start(ctrl) {
              send = (o) => {
                try {
                  ctrl.enqueue(enc.encode(JSON.stringify(o) + '\n'))
                } catch {
                  // page closed
                }
              }
              running = (config().fixturesDir ? demoInternetSpeed(send) : internetSpeed({ onProgress: send })).finally(() => (running = undefined))
              running
                .then((r) => send({ result: r, history: saveSpeed(r) }))
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
