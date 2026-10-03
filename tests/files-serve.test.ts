import { describe, expect, it } from 'vitest'
import { chunks, fileResponse, mimeOf, parseRange } from '~/server/files/serve'

const file = (name: string, text = '0123456789') => ({ name, size: text.length, mtime: Date.UTC(2026, 0, 2), blob: new Blob([text]) })

describe('files for the browser', () => {
  it('shows what the browser can show, never HTML or SVG', () => {
    expect(mimeOf('a.pdf')).toEqual({ type: 'application/pdf', inline: true })
    expect(mimeOf('Film.MP4')).toEqual({ type: 'video/mp4', inline: true })
    expect(mimeOf('notes.txt')).toEqual({ type: 'text/plain; charset=utf-8', inline: true })
    expect(mimeOf('page.html')).toEqual({ type: 'text/plain; charset=utf-8', inline: true })
    expect(mimeOf('logo.svg')).toEqual({ type: 'text/plain; charset=utf-8', inline: true })
    expect(mimeOf('film.mkv')).toEqual({ type: 'application/octet-stream', inline: false })
  })

  it('reads byte ranges', () => {
    expect(parseRange(null, 10)).toBeUndefined()
    expect(parseRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 })
    expect(parseRange('bytes=7-', 10)).toEqual({ start: 7, end: 9 })
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 })
    expect(() => parseRange('bytes=10-', 10)).toThrow()
    expect(parseRange('bytes=1-2,4-5', 10)).toBeUndefined() // several ranges: the whole file
  })

  it('answers with the range, safe headers and the name', async () => {
    const r = fileResponse(file('Größe.mp4'), { range: 'bytes=2-4' })
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(r.headers.get('content-length')).toBe('3')
    expect(await r.text()).toBe('234')
    expect(r.headers.get('content-disposition')).toBe(`inline; filename="Gr__e.mp4"; filename*=UTF-8''Gr%C3%B6%C3%9Fe.mp4`)
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('content-security-policy')).toMatch(/^sandbox;/)
    expect(r.headers.get('accept-ranges')).toBe('bytes')

    const dl = fileResponse(file('notes.txt'), { download: true })
    expect(dl.headers.get('content-type')).toBe('application/octet-stream')
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(fileResponse(file('x.zip')).headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(fileResponse(file('x.mp4'), { range: 'bytes=20-' }).status).toBe(416)
  })
  it('sends only the range of a real file, also when the response is wrapped again on its way out', async () => {
    const blob = Bun.file('fixtures/demo/files/photo.jpg')
    const r = fileResponse({ name: 'a.jpg', size: blob.size, mtime: 0, blob }, { range: 'bytes=0-1' })
    const wrapped = new Response(r.body, { status: r.status, headers: r.headers })
    expect([...new Uint8Array(await wrapped.arrayBuffer())]).toEqual([0xff, 0xd8])
  })
  it('streams large ranges in pieces', async () => {
    const big = new Blob([new Uint8Array(3 * 1024 * 1024 + 5).map((_, i) => i % 251)])
    const parts: number[] = []
    const reader = chunks(big, 10, 2.5 * 1024 * 1024).getReader()
    let first: Uint8Array | undefined
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      first ??= value
      parts.push(value.length)
    }
    expect(parts).toEqual([1024 * 1024, 1024 * 1024, 2.5 * 1024 * 1024 - 10 - 2 * 1024 * 1024])
    expect(first![0]).toBe(10 % 251)
  })
})
