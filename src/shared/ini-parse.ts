// The one INI/unit-file reader (sections, comments, backslash continuation lines, CRLF). No other
// imports, so every module that reads unit or Quadlet files can use it without import cycles.

export interface IniEntry {
  kind: 'section' | 'kv' | 'blank' | 'comment' | 'invalid'
  section: string
  key?: string
  value?: string
  /** First and last raw line (0-based); continuation lines make it longer. */
  start: number
  end: number
}

export function parseIni(text: string): IniEntry[] {
  const lines = text.split('\n')
  const out: IniEntry[] = []
  let section = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '')
    const t = line.trim()
    if (!t) {
      out.push({ kind: 'blank', section, start: i, end: i })
      continue
    }
    if (t.startsWith('#') || t.startsWith(';')) {
      out.push({ kind: 'comment', section, start: i, end: i })
      continue
    }
    const sec = t.match(/^\[([^\]]+)\]$/)
    if (sec) {
      section = sec[1]!
      out.push({ kind: 'section', section, start: i, end: i })
      continue
    }
    const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s?(.*)$/)
    if (!kv) {
      out.push({ kind: 'invalid', section, start: i, end: i })
      continue
    }
    let value = kv[2]!
    const start = i
    // "Key=a \" + next line continues the value.
    while (value.endsWith('\\') && i + 1 < lines.length) {
      i++
      value = value.slice(0, -1) + ' ' + lines[i]!.trim()
    }
    out.push({ kind: 'kv', section, key: kv[1]!, value: value.trim(), start, end: i })
  }
  return out
}

export function getValues(text: string, section: string, key: string): string[] {
  return parseIni(text)
    .filter((e) => e.kind === 'kv' && e.section === section && e.key === key)
    .map((e) => e.value!)
}

export const getValue = (text: string, section: string, key: string) => getValues(text, section, key).at(-1) ?? ''

