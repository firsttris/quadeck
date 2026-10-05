// Podman secrets: passwords kept by Podman instead of in the Quadlet file. Finding passwords in
// plain text in Environment= lines and rewriting such a line into Secret=…,type=env,target=…
// No I/O here; secret values never pass through these functions except the one being moved.

export const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/
export const MAX_SECRET_BYTES = 64 * 1024

export interface PodmanSecret {
  id: string
  name: string
  created?: number
  updated?: number
  /** Quadlet files with Secret=<name>. */
  usedBy: string[]
}

/** A password in plain text in a Quadlet file. The value itself is never sent to the page. */
export interface PlainSecret {
  file: string
  key: string
  line: number
  /** A free secret name to suggest. */
  suggested: string
}

export interface SecretsState {
  secrets: PodmanSecret[]
  plain: PlainSecret[]
}

/** Environment variables that hold credentials (not *_FILE, which point to a file). */
export const SENSITIVE_KEY = /(PASS(WORD|WD)?|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIALS?)$/i
export const isSensitive = (key: string) => SENSITIVE_KEY.test(key) && !/_FILE$/i.test(key)

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', s: ' ', a: '\x07', b: '\b', f: '\f', v: '\v' }

/**
 * systemd's Environment= syntax, word by word: words are separated by blanks, quotes ("…" or '…')
 * may start anywhere inside a word (FOO="a b" is one word) and a backslash escapes the next
 * character. `raw` is the word as written, `text` the unquoted, unescaped value.
 */
export function environmentWords(value: string): { raw: string; text: string }[] {
  const out: { raw: string; text: string }[] = []
  let i = 0
  while (i < value.length) {
    while (value[i] === ' ' || value[i] === '\t') i++
    if (i >= value.length) break
    const start = i
    let text = ''
    let quote: string | undefined
    for (; i < value.length; i++) {
      const c = value[i]!
      if (!quote && (c === ' ' || c === '\t')) break
      if (c === '\\' && i + 1 < value.length) {
        const n = value[++i]!
        text += ESCAPES[n] ?? n
      } else if (quote ? c === quote : c === '"' || c === "'") quote = quote ? undefined : c
      else text += c
    }
    out.push({ raw: value.slice(start, i), text })
  }
  return out
}

/** The assignments of an Environment= value with their key and value (words without "=" are skipped). */
export function splitEnvironment(value: string): { raw: string; key: string; value: string }[] {
  return environmentWords(value).flatMap(({ raw, text }) => {
    const eq = text.indexOf('=')
    return eq > 0 ? [{ raw, key: text.slice(0, eq), value: text.slice(eq + 1) }] : []
  })
}

interface Line {
  index: number
  section: string
  key: string
  value: string
}

function lines(content: string): Line[] {
  let section = ''
  return content.split('\n').flatMap((l, index) => {
    const t = l.trim()
    const s = /^\[([^\]]+)\]$/.exec(t)
    if (s) {
      section = s[1]!
      return []
    }
    if (!t || t.startsWith('#') || t.startsWith(';')) return []
    const eq = t.indexOf('=')
    if (eq < 1) return []
    return [{ index, section, key: t.slice(0, eq).trim(), value: t.slice(eq + 1).trim() }]
  })
}

/** Secret=<name>[,opts] in [Container] (and [Pod]/[Kube] don't take secrets). */
export function secretRefs(content: string): string[] {
  return lines(content)
    .filter((l) => l.section === 'Container' && l.key === 'Secret')
    .map((l) => l.value.split(',')[0]!.trim())
    .filter(Boolean)
}

/** Credentials in plain text in Environment= lines of a .container file. */
export function findPlain(file: string, content: string, taken: Set<string> = new Set()): PlainSecret[] {
  const out: PlainSecret[] = []
  const used = new Set(taken)
  for (const l of lines(content)) {
    if (l.section !== 'Container' || l.key !== 'Environment') continue
    for (const a of splitEnvironment(l.value)) {
      // ${VAR} and %-specifiers come from elsewhere: not a password in this file
      if (!isSensitive(a.key) || !a.value || /^\$\{?\w+\}?$|^%\w$/.test(a.value)) continue
      const suggested = suggestName(file, a.key, used)
      used.add(suggested)
      out.push({ file, key: a.key, line: l.index + 1, suggested })
    }
  }
  return out
}

/** "immich.container", "DB_PASSWORD" → "immich-db-password" (with -2, -3 … if taken). */
export function suggestName(file: string, key: string, taken: Set<string> = new Set()): string {
  const stem = file.replace(/\.[a-z]+$/, '')
  const base = `${stem}-${key.toLowerCase().replace(/_/g, '-')}`
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 60)
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 57)}-${n}`
  return name
}

/** The plain value of one key (the helper reads it to create the secret). */
export function plainValue(content: string, key: string): string | undefined {
  for (const l of lines(content)) if (l.section === 'Container' && l.key === 'Environment') for (const a of splitEnvironment(l.value)) if (a.key === key) return a.value
  return undefined
}

/**
 * Removes KEY=… from its Environment= line (the line goes when nothing is left) and puts
 * Secret=<name>,type=env,target=KEY in its place. Other lines stay byte for byte.
 */
export function moveToSecret(content: string, key: string, name: string): string {
  const all = content.split('\n')
  const hit = lines(content).find((l) => l.section === 'Container' && l.key === 'Environment' && splitEnvironment(l.value).some((a) => a.key === key))
  if (!hit) throw new Error(`no ${key}`)
  // every other word stays as written, also ones systemd would ignore
  const rest = environmentWords(hit.value).filter((w) => {
    const eq = w.text.indexOf('=')
    return eq <= 0 || w.text.slice(0, eq) !== key
  })
  const secret = `Secret=${name},type=env,target=${key}`
  all.splice(hit.index, 1, ...(rest.length ? [`Environment=${rest.map((w) => w.raw).join(' ')}`, secret] : [secret]))
  return all.join('\n')
}
