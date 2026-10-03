// A file from the explorer to the browser: in a new tab when the browser can
// show it (images, PDF, audio, video, plain text), as a download otherwise.
// Range requests let a video start and jump without loading the whole file.

import { fileKind } from '~/shared/files'
import { HttpError } from '../auth'
import { msg } from '~/shared/i18n'

export interface OpenedFile {
  name: string
  size: number
  mtime: number
  /** Read lazily: only the requested range is read. */
  blob: Blob
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
}

/** Content type and whether the browser may show it itself. HTML and SVG never: they would run on Quadeck's address. */
export function mimeOf(name: string): { type: string; inline: boolean } {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  const kind = fileKind(name)
  if (kind === 'browser' && MIME[ext]) return { type: MIME[ext], inline: true }
  if (kind === 'text') return { type: 'text/plain; charset=utf-8', inline: true }
  return { type: 'application/octet-stream', inline: false }
}

/** "bytes=a-b" → the byte range, undefined for the whole file; throws 416 for a range outside it. */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim())
  if (!m || (!m[1] && !m[2])) return undefined
  let start: number
  let end: number
  if (!m[1]) {
    // the last n bytes
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  if (start >= size || start > end) throw new HttpError(416, msg('files_error_range'))
  return { start, end }
}

const CHUNK = 1024 * 1024

/**
 * The bytes start…end as a stream, read 1 MiB at a time when the browser asks for more – a film
 * is never held in memory. Own loop: Bun (1.3) streams a sliced Blob from the start of the
 * slice to the end of the file, only slice().arrayBuffer() reads exactly the slice.
 */
export function chunks(blob: Blob, start: number, end: number): ReadableStream<Uint8Array> {
  let pos = start
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (pos >= end) return ctrl.close()
      const next = Math.min(end, pos + CHUNK)
      const buf = new Uint8Array(await blob.slice(pos, next).arrayBuffer())
      pos = next
      ctrl.enqueue(buf)
    },
  })
}

const asciiName = (name: string) => name.replace(/[^\x20-\x7e]|["\\]/g, '_')

export function fileResponse(f: OpenedFile, opts: { range?: string | null; download?: boolean } = {}): Response {
  const { type, inline } = mimeOf(f.name)
  const show = inline && !opts.download
  const headers: Record<string, string> = {
    'content-type': opts.download ? 'application/octet-stream' : type,
    'content-disposition': `${show ? 'inline' : 'attachment'}; filename="${asciiName(f.name)}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'accept-ranges': 'bytes',
    'last-modified': new Date(f.mtime).toUTCString(),
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
    // No scripts in what is shown; the PDF viewer needs its own document, so no sandbox there.
    'content-security-policy': type === 'application/pdf' ? "default-src 'self'; script-src 'none'; frame-ancestors 'none'" : "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  }
  let range: { start: number; end: number } | undefined
  try {
    range = parseRange(opts.range, f.size)
  } catch {
    return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${f.size}` } })
  }
  if (!range) return new Response(chunks(f.blob, 0, f.size), { headers: { ...headers, 'content-length': String(f.size) } })
  return new Response(chunks(f.blob, range.start, range.end + 1), {
    status: 206,
    headers: { ...headers, 'content-length': String(range.end - range.start + 1), 'content-range': `bytes ${range.start}-${range.end}/${f.size}` },
  })
}
