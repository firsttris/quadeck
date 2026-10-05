// Minimal TOML editing for the containers.conf/registries.conf forms: reads and replaces
// `key = value` entries (a value may span several lines: arrays, """ strings), everything else
// (comments, unknown keys, [[array tables]]) stays. Values are TOML basic strings, arrays of
// them, numbers or booleans.

export type TomlValue = string | number | boolean | string[]

interface Located {
  /** First and last line of the entry (a multi-line array spans several). */
  line: number
  end: number
  raw: string
}

/** [table] → its name; [[array.table]] → marked, so a form field never matches its keys. */
const HEADER = /^\[(\[)?\s*([^\][]+?)\s*\]\]?\s*(?:#.*)?$/
const isHeader = (line: string) => HEADER.test(line.trim())

const ML = ['"""', "'''"]

/** Bracket depth and open multi-line string after `text` (strings and comments skipped). */
function scan(text: string, state: { depth: number; ml?: string }) {
  let i = 0
  while (i < text.length) {
    if (state.ml) {
      const close = text.indexOf(state.ml, i)
      if (close < 0) return
      i = close + 3
      state.ml = undefined
      continue
    }
    const c = text[i]!
    if (c === '#') return
    const ml = ML.find((q) => text.startsWith(q, i))
    if (ml) {
      state.ml = ml
      i += 3
    } else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += c === '"' && text[j] === '\\' ? 2 : 1
      i = j + 1
    } else {
      if (c === '[') state.depth++
      else if (c === ']') state.depth--
      i++
    }
  }
}

function locate(text: string, section: string, key: string): Located | undefined {
  const lines = text.split('\n')
  let current = ''
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim()
    const sec = t.match(HEADER)
    if (sec) {
      current = sec[1] ? `[[${sec[2]}]]` : sec[2]!
      continue
    }
    const kv = t.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/)
    if (!kv) continue
    // the entry ends where its brackets and strings are closed
    const state: { depth: number; ml?: string } = { depth: 0 }
    scan(kv[2]!, state)
    let end = i
    while ((state.depth > 0 || state.ml) && end + 1 < lines.length) scan(lines[++end]!, state)
    if (current === section && kv[1] === key) return { line: i, end, raw: [kv[2]!, ...lines.slice(i + 1, end + 1)].join('\n') }
    i = end
  }
  return undefined
}

/** Drops comments outside strings, line by line. */
function stripComments(raw: string) {
  return raw
    .split('\n')
    .map((l) => {
      let q: string | undefined
      for (let i = 0; i < l.length; i++) {
        const c = l[i]!
        if (q) {
          if (c === '\\' && q === '"') i++
          else if (c === q) q = undefined
        } else if (c === '"' || c === "'") q = c
        else if (c === '#') return l.slice(0, i)
      }
      return l
    })
    .join('\n')
}

export function getToml(text: string, section: string, key: string): TomlValue | undefined {
  const l = locate(text, section, key)
  if (!l) return undefined
  const raw = stripComments(l.raw).trim()
  try {
    // literal strings → JSON strings; TOML allows a trailing comma in arrays
    return JSON.parse(raw.replace(/'([^']*)'/g, (_, v: string) => JSON.stringify(v)).replace(/,(\s*)\]/g, '$1]')) as TomlValue
  } catch {
    return raw
  }
}

const literal = (v: TomlValue) => (Array.isArray(v) ? `[${v.map((s) => JSON.stringify(s)).join(', ')}]` : typeof v === 'string' ? JSON.stringify(v) : String(v))

/** Sets (or with undefined removes) a key; creates the section if needed. */
export function setToml(text: string, section: string, key: string, value: TomlValue | undefined): string {
  const lines = text.split('\n')
  const l = locate(text, section, key)
  if (l) {
    if (value === undefined) lines.splice(l.line, l.end - l.line + 1)
    else lines.splice(l.line, l.end - l.line + 1, `${key} = ${literal(value)}`)
    return lines.join('\n')
  }
  if (value === undefined) return text
  const entry = `${key} = ${literal(value)}`
  if (!section) {
    // Top-level keys must come before the first table.
    const first = lines.findIndex(isHeader)
    lines.splice(first < 0 ? lines.length : first, 0, entry)
    return lines.join('\n')
  }
  const head = lines.findIndex((x) => {
    const h = x.trim().match(HEADER)
    return !!h && !h[1] && h[2] === section
  })
  if (head < 0) return `${text.replace(/\s*$/, '')}\n\n[${section}]\n${entry}\n`
  let at = head + 1
  while (at < lines.length && !isHeader(lines[at]!)) at++
  while (at > head + 1 && !lines[at - 1]!.trim()) at--
  lines.splice(at, 0, entry)
  return lines.join('\n')
}
