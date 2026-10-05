// Line diff (Myers) for the save preview and the history view.

export interface DiffLine {
  op: ' ' | '+' | '-'
  text: string
}/**
 * Line diff. The common start and end are cut off first (a save usually changes a few lines in
 * the middle); the rest is Myers' O((N+M)·D) algorithm, whose memory grows with the number of
 * changed lines D, not with the file size squared. Beyond MAX_EDITS changes the rest is shown as
 * removed and re-added, which keeps a 2 MB file from freezing or crashing the tab.
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n')
  const y = b.split('\n')
  let start = 0
  while (start < x.length && start < y.length && x[start] === y[start]) start++
  let ex = x.length
  let ey = y.length
  while (ex > start && ey > start && x[ex - 1] === y[ey - 1]) {
    ex--
    ey--
  }
  const out: DiffLine[] = []
  for (let i = 0; i < start; i++) out.push({ op: ' ', text: x[i]! })
  out.push(...myers(x.slice(start, ex), y.slice(start, ey)))
  for (let i = ex; i < x.length; i++) out.push({ op: ' ', text: x[i]! })
  return out
}

export const MAX_EDITS = 2000

function myers(x: string[], y: string[]): DiffLine[] {
  const n = x.length
  const m = y.length
  const max = Math.min(n + m, MAX_EDITS)
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d]: v before step d for k = -d-1 … d+1 (index k + d + 1); O(D²) in total
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1
      let j = i - k
      while (i < n && j < m && x[i] === y[j]) {
        i++
        j++
      }
      v[off + k] = i
      if (i >= n && j >= m) return backtrack(x, y, trace, d)
    }
  }
  return [...x.map((text) => ({ op: '-' as const, text })), ...y.map((text) => ({ op: '+' as const, text }))]
}

function backtrack(x: string[], y: string[], trace: Int32Array[], edits: number): DiffLine[] {
  const rev: DiffLine[] = []
  let i = x.length
  let j = y.length
  for (let d = edits; d > 0; d--) {
    const t = trace[d]!
    const at = (k: number) => t[k + d + 1]!
    const k = i - j
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const pk = down ? k + 1 : k - 1
    const si = down ? at(pk) : at(pk) + 1
    while (i > si) {
      i--
      j--
      rev.push({ op: ' ', text: x[i]! })
    }
    if (down) rev.push({ op: '+', text: y[--j]! })
    else rev.push({ op: '-', text: x[--i]! })
  }
  while (i > 0) {
    i--
    rev.push({ op: ' ', text: x[i]! })
  }
  return rev.reverse()
}



/** Changed lines with `context` unchanged lines around them; gaps become null. */
export function hunks(d: DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = new Set<number>()
  d.forEach((l, i) => {
    if (l.op !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) keep.add(k)
  })
  const out: (DiffLine | null)[] = []
  let last = -1
  for (let i = 0; i < d.length; i++) {
    if (!keep.has(i)) continue
    if (last >= 0 && i > last + 1) out.push(null)
    out.push(d[i]!)
    last = i
  }
  return out
}
