// Minimal TOML line editing for the containers.conf/registries.conf forms:
// reads and replaces single `key = value` lines, everything else (comments,
// unknown keys) stays. Values are TOML basic strings, arrays of them,
// numbers or booleans.

export type TomlValue = string | number | boolean | string[]

interface Located {
  line: number
  raw: string
}

function locate(text: string, section: string, key: string): Located | undefined {
  const lines = text.split('\n')
  let current = ''
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim()
    const sec = t.match(/^\[([^\]]+)\]$/)
    if (sec) {
      current = sec[1]!.trim()
      continue
    }
    const kv = t.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/)
    if (kv && current === section && kv[1] === key) return { line: i, raw: kv[2]! }
  }
  return undefined
}

export function getToml(text: string, section: string, key: string): TomlValue | undefined {
  const l = locate(text, section, key)
  if (!l) return undefined
  const raw = l.raw.replace(/\s+#.*$/, '').trim()
  try {
    return JSON.parse(raw.replace(/'([^']*)'/g, '"$1"')) as TomlValue
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
    if (value === undefined) lines.splice(l.line, 1)
    else lines[l.line] = `${key} = ${literal(value)}`
    return lines.join('\n')
  }
  if (value === undefined) return text
  const entry = `${key} = ${literal(value)}`
  if (!section) {
    // Top-level keys must come before the first table.
    const first = lines.findIndex((x) => /^\s*\[/.test(x))
    lines.splice(first < 0 ? lines.length : first, 0, entry)
    return lines.join('\n')
  }
  const head = lines.findIndex((x) => x.trim() === `[${section}]`)
  if (head < 0) return `${text.replace(/\s*$/, '')}\n\n[${section}]\n${entry}\n`
  let at = head + 1
  while (at < lines.length && !/^\s*\[/.test(lines[at]!)) at++
  while (at > head + 1 && !lines[at - 1]!.trim()) at--
  lines.splice(at, 0, entry)
  return lines.join('\n')
}
