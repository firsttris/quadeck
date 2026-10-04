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

/**
 * systemd's Environment= syntax: assignments separated by spaces, each may be quoted
 * ("A=b c" or 'A=b c'). Returns the assignments with their key and value.
 */
export function splitEnvironment(value: string): { raw: string; key: string; value: string }[] {
  const out: { raw: string; key: string; value: string }[] = []
  let i = 0
  while (i < value.length) {
    while (value[i] === ' ' || value[i] === '\t') i++
    if (i >= value.length) break
    let raw = ''
    let text = ''
    const q = value[i] === '"' || value[i] === "'" ? value[i] : undefined
    if (q) {
      const end = value.indexOf(q, i + 1)
      const stop = end < 0 ? value.length : end
      text = value.slice(i + 1, stop)
      raw = value.slice(i, Math.min(value.length, stop + 1))
      i = stop + 1
    } else {
      let j = i
      while (j < value.length && value[j] !== ' ' && value[j] !== '\t') j++
      raw = value.slice(i, j)
      text = raw
      i = j
    }
    const eq = text.indexOf('=')
    if (eq > 0) out.push({ raw, key: text.slice(0, eq), value: text.slice(eq + 1) })
  }
  return out
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
  const rest = splitEnvironment(hit.value).filter((a) => a.key !== key)
  const secret = `Secret=${name},type=env,target=${key}`
  all.splice(hit.index, 1, ...(rest.length ? [`Environment=${rest.map((a) => a.raw).join(' ')}`, secret] : [secret]))
  return all.join('\n')
}
