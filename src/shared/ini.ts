// systemd/Quadlet unit files as editable text: reading and changing single
// keys keeps every other line (comments, unknown keys, order) unchanged, so
// the form and the text view can work on the same file.

import { tr } from './i18n'
import { QUADLET_KEYS, QUADLET_SECTION } from './quadlet-keys'
import type { Diagnostic, QuadletType } from './quadlets'

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

/**
 * Sets all values of a key: replaces the existing lines in place (the first
 * occurrence keeps its position), removes surplus ones, or appends to the
 * section (created if missing). Empty list = remove the key.
 */
export function setValues(text: string, section: string, key: string, values: string[]): string {
  const lines = text.split('\n')
  const entries = parseIni(text)
  // Empty entries stay (an added, not yet filled list entry); pass [] to remove the key.
  const vals = values.map((v) => v.replace(/[\r\n]+/g, ' ').trim())
  const fresh = vals.map((v) => `${key}=${v}`)
  const existing = entries.filter((e) => e.kind === 'kv' && e.section === section && e.key === key)
  if (existing.length) {
    // From the bottom so earlier indices stay valid.
    for (let k = existing.length - 1; k >= 0; k--) {
      const e = existing[k]!
      lines.splice(e.start, e.end - e.start + 1, ...(k === 0 ? fresh : []))
    }
    return lines.join('\n')
  }
  if (!fresh.length) return text
  const secIdx = entries.findIndex((e) => e.kind === 'section' && e.section === section)
  if (secIdx >= 0) {
    // After the last non-blank entry of the section.
    let last = entries[secIdx]!.end
    for (let j = secIdx + 1; j < entries.length && entries[j]!.section === section && entries[j]!.kind !== 'section'; j++) {
      if (entries[j]!.kind !== 'blank') last = entries[j]!.end
    }
    lines.splice(last + 1, 0, ...fresh)
    return lines.join('\n')
  }
  const block = [`[${section}]`, ...fresh]
  if (section === 'Unit') {
    // [Unit] conventionally comes first.
    return [...block, '', ...lines].join('\n').replace(/\n{3,}/g, '\n\n')
  }
  const body = text.replace(/\s*$/, '')
  return (body ? `${body}\n\n` : '') + block.join('\n') + '\n'
}

const SYSTEMD_SECTIONS = new Set(['Unit', 'Service', 'Install', 'Timer', 'Socket', 'Path', 'Quadlet'])

/** Our own checks (line-precise); the Quadlet generator has the last word. */
export function lintQuadlet(text: string, type: QuadletType): Diagnostic[] {
  const diags: Diagnostic[] = []
  const entries = parseIni(text)
  const main = QUADLET_SECTION[type]
  const keys = QUADLET_KEYS[main]!
  const seen = new Map<string, number>()
  for (const e of entries) {
    const line = e.start + 1
    if (e.kind === 'invalid') diags.push({ line, severity: 'error', message: tr('Zeile ist weder Abschnitt, Schlüssel=Wert noch Kommentar', 'Line is neither a section, Key=Value nor a comment') })
    if (e.kind === 'section' && e.section !== main && !SYSTEMD_SECTIONS.has(e.section) && !e.section.startsWith('X-') && !QUADLET_KEYS[e.section])
      diags.push({ line, severity: 'warning', message: tr(`Unbekannter Abschnitt [${e.section}]`, `Unknown section [${e.section}]`) })
    if (e.kind === 'section' && e.section !== main && QUADLET_KEYS[e.section])
    {
      const ext = Object.entries(QUADLET_SECTION).find(([, s]) => s === e.section)![0]
      diags.push({ line, severity: 'error', message: tr(`[${e.section}] gehört in eine .${ext}-Datei`, `[${e.section}] belongs in a .${ext} file`) })
    }
    if (e.kind !== 'kv') continue
    if (!e.section) {
      diags.push({ line, severity: 'error', message: tr(`${e.key}= steht vor dem ersten Abschnitt`, `${e.key}= comes before the first section`) })
      continue
    }
    if (!e.value) diags.push({ line, severity: 'warning', message: tr(`${e.key}= ist leer`, `${e.key}= is empty`) })
    if (e.section !== main) continue
    const doc = keys[e.key!]
    if (!doc) {
      diags.push({ line, severity: 'warning', message: tr(`Unbekannter Schlüssel ${e.key} in [${main}]`, `Unknown key ${e.key} in [${main}]`) })
      continue
    }
    if (!doc.multi && seen.has(e.key!)) diags.push({ line, severity: 'warning', message: tr(`${e.key} ist mehrfach gesetzt – es gilt der letzte Wert (Zeile ${line})`, `${e.key} is set more than once – the last value applies (line ${line})`) })
    seen.set(e.key!, line)
    if (doc.options && e.value && !doc.options.includes(e.value)) diags.push({ line, severity: 'warning', message: tr(`${e.key}=${e.value}: erwartet ${doc.options.filter(Boolean).join(', ')}`, `${e.key}=${e.value}: expected ${doc.options.filter(Boolean).join(', ')}`) })
  }
  if (!entries.some((e) => e.kind === 'section' && e.section === main)) diags.push({ severity: 'error', message: tr(`Abschnitt [${main}] fehlt`, `Section [${main}] is missing`) })
  else if (type === 'container' && !getValue(text, main, 'Image') && !getValue(text, main, 'Rootfs')) diags.push({ severity: 'error', message: tr('Image= fehlt', 'Image= is missing') })
  else if (type === 'kube' && !getValue(text, main, 'Yaml')) diags.push({ severity: 'error', message: tr('Yaml= fehlt', 'Yaml= is missing') })
  else if (type === 'image' && !getValue(text, main, 'Image')) diags.push({ severity: 'error', message: tr('Image= fehlt', 'Image= is missing') })
  return diags
}

/** Line of `key` in `section` (1-based), for mapping generator messages. */
export function lineOf(text: string, section: string, key: string): number | undefined {
  const e = parseIni(text).find((x) => x.kind === 'kv' && x.section === section && x.key === key)
  return e ? e.start + 1 : undefined
}
