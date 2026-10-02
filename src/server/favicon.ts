import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config'

const ALLOWED = ['image/x-icon', 'image/vnd.microsoft.icon', 'image/png', 'image/gif', 'image/jpeg', 'image/webp']
const MAX_BYTES = 256 * 1024
const misses = new Map<string, number>()

async function readCapped(res: Response, max: number): Promise<Uint8Array | undefined> {
  const len = Number(res.headers.get('content-length'))
  if (len > max) {
    await res.body?.cancel()
    return undefined
  }
  const reader = res.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * Fetches /favicon.ico of a known service once and caches it on disk (raster
 * formats only, max 256 KiB, no redirects so a service cannot bounce the
 * request to other internal hosts). Cache key includes the URL.
 */
export async function faviconFor(key: string, url: string): Promise<{ data: Uint8Array; type: string } | undefined> {
  const dir = join(config().dataDir, 'icons', 'favicons')
  const target = new URL('/favicon.ico', url).toString()
  const id = new Bun.CryptoHasher('sha256').update(`${key}\n${target}`).digest('hex').slice(0, 32)
  const file = join(dir, id)
  if (existsSync(file) && existsSync(file + '.type')) return { data: readFileSync(file), type: readFileSync(file + '.type', 'utf8') }
  if ((misses.get(id) ?? 0) > Date.now()) return undefined
  try {
    const res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(5000), tls: { rejectUnauthorized: false } } as RequestInit)
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
    if (!res.ok || !ALLOWED.includes(type)) {
      await res.body?.cancel()
      throw new Error('no favicon')
    }
    const data = await readCapped(res, MAX_BYTES)
    if (!data?.length) throw new Error('no favicon')
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, data)
    writeFileSync(file + '.type', type)
    return { data, type }
  } catch {
    misses.set(id, Date.now() + 3600_000)
    return undefined
  }
}
