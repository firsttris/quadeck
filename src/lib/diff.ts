// Line diff (LCS) for the save preview and the history view.

export interface DiffLine {
  op: ' ' | '+' | '-'
  text: string
}

export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n')
  const y = b.split('\n')
  const n = x.length
  const m = y.length
  // lcs[i][j] = LCS length of x[i..], y[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: ' ', text: x[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: '-', text: x[i++]! })
    else out.push({ op: '+', text: y[j++]! })
  }
  while (i < n) out.push({ op: '-', text: x[i++]! })
  while (j < m) out.push({ op: '+', text: y[j++]! })
  return out
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
