// Text operations on smb.conf and exports files. Only the edited share
// changes; comments, [global] and everything Quadeck does not know stay.

import { tr } from '~/shared/i18n'
import type { NfsClient, NfsExportSpec, SmbShareInfo, SmbShareSpec } from '~/shared/shares'

// ---------- smb.conf ----------

interface SmbSection {
  name: string
  /** Header line and last line of the section (0-based, inclusive). */
  start: number
  end: number
  opts: Map<string, { value: string; line: number }>
}

const normKey = (k: string) => k.trim().toLowerCase().replace(/\s+/g, ' ')
const yes = (v: string | undefined) => !!v && /^(yes|true|1)$/i.test(v.trim())
const no = (v: string | undefined) => !!v && /^(no|false|0)$/i.test(v.trim())

export function smbSections(text: string): SmbSection[] {
  const lines = text.split('\n')
  const out: SmbSection[] = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim()
    const sec = t.match(/^\[(.+)\]$/)
    if (sec) {
      if (out.length) out[out.length - 1]!.end = i - 1
      out.push({ name: sec[1]!.trim(), start: i, end: lines.length - 1, opts: new Map() })
      continue
    }
    if (!out.length || !t || t.startsWith('#') || t.startsWith(';')) continue
    const kv = t.match(/^([^=]+?)\s*=\s*(.*)$/)
    if (kv) out[out.length - 1]!.opts.set(normKey(kv[1]!), { value: kv[2]!.trim(), line: i })
  }
  return out
}

/** Keys the form owns (with their synonyms, removed on save to avoid contradictions). */
const OWNED = ['path', 'comment', 'read only', 'writable', 'writeable', 'write ok', 'guest ok', 'public', 'valid users', 'browseable', 'browsable']
const SKIP = new Set(['global', 'homes', 'printers', 'print$'])

export function smbShares(text: string): Omit<SmbShareInfo, 'connections'>[] {
  return smbSections(text)
    .filter((s) => !SKIP.has(s.name.toLowerCase()) && s.opts.has('path') && !yes(s.opts.get('printable')?.value) && !yes(s.opts.get('print ok')?.value))
    .map((s) => {
      const v = (k: string) => s.opts.get(k)?.value
      const writable = [v('writable'), v('writeable'), v('write ok')].some(yes) || no(v('read only'))
      return {
        name: s.name,
        path: v('path')!,
        comment: v('comment') ?? '',
        readOnly: yes(v('read only')) || !writable,
        guestOk: yes(v('guest ok')) || yes(v('public')),
        validUsers: v('valid users') ?? '',
        browseable: !(no(v('browseable')) || no(v('browsable'))),
        extraKeys: [...s.opts.keys()].filter((k) => !OWNED.includes(k)),
      }
    })
}

function renderOwned(spec: SmbShareSpec, indent: string): string[] {
  const l = [`${indent}path = ${spec.path}`]
  if (spec.comment) l.push(`${indent}comment = ${spec.comment}`)
  l.push(`${indent}read only = ${spec.readOnly ? 'yes' : 'no'}`)
  l.push(`${indent}guest ok = ${spec.guestOk ? 'yes' : 'no'}`)
  if (spec.validUsers.trim())
    l.push(
      `${indent}valid users = ${spec.validUsers
        .trim()
        .split(/[\s,]+/)
        .join(' ')}`,
    )
  l.push(`${indent}browseable = ${spec.browseable ? 'yes' : 'no'}`)
  return l
}

/**
 * Creates, changes (incl. rename) or deletes one share section. The owned
 * keys are rewritten at the position of the first of them; other keys and
 * comments in the section stay.
 */
export function setSmbShare(text: string, original: string | undefined, spec: SmbShareSpec | null): string {
  const lines = text.split('\n')
  const sections = smbSections(text)
  const find = (n: string) => sections.find((s) => s.name.toLowerCase() === n.toLowerCase())
  const sec = original ? find(original) : undefined
  if (original && !sec) throw new Error(tr(`Freigabe [${original}] nicht gefunden`, `Share [${original}] not found`))
  if (spec && (!sec || sec.name.toLowerCase() !== spec.name.toLowerCase()) && find(spec.name)) throw new Error(tr(`Eine Freigabe [${spec.name}] gibt es schon`, `A share [${spec.name}] already exists`))

  if (!sec) {
    if (!spec) return text
    const body = text.replace(/\s*$/, '')
    return `${body}${body ? '\n\n' : ''}[${spec.name}]\n${renderOwned(spec, '   ').join('\n')}\n`
  }
  // Section without trailing blank lines.
  let end = sec.end
  while (end > sec.start && !lines[end]!.trim()) end--
  if (!spec) {
    let start = sec.start
    // Comment lines directly above the header belong to the share.
    while (start > 0 && /^\s*[#;]/.test(lines[start - 1]!)) start--
    lines.splice(start, sec.end - start + 1)
    return lines.join('\n').replace(/\n{3,}/g, '\n\n')
  }
  const owned = [...sec.opts].filter(([k]) => OWNED.includes(k)).map(([, v]) => v.line)
  const firstOwned = owned.length ? Math.min(...owned) : sec.start + 1
  const indent = owned.length ? (lines[firstOwned]!.match(/^\s*/)?.[0] ?? '   ') : '   '
  const body: string[] = []
  for (let i = sec.start + 1; i <= end; i++) {
    if (i === firstOwned) body.push(...renderOwned(spec, indent))
    if (owned.includes(i)) continue
    body.push(lines[i]!)
  }
  if (firstOwned > end) body.push(...renderOwned(spec, indent))
  lines.splice(sec.start, end - sec.start + 1, `[${spec.name}]`, ...body)
  return lines.join('\n')
}

// ---------- exports ----------

export interface ExportLine extends NfsExportSpec {
  line: number
}

/** Splits "host(opts) host2(opts)" respecting quotes around the path. */
export function parseExportsFile(text: string): ExportLine[] {
  const out: ExportLine[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.replace(/\r$/, '')
    const start = i
    while (line.endsWith('\\') && i + 1 < lines.length) line = line.slice(0, -1) + ' ' + lines[++i]!
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = t.match(/^("([^"]+)"|(\S+))\s*(.*)$/)
    if (!m) continue
    const path = m[2] ?? m[3]!
    if (!path.startsWith('/')) continue
    const clients: NfsClient[] = (m[4]!.match(/[^\s(]*(\([^)]*\))?/g) ?? []).filter(Boolean).map((c) => {
      const cm = c.match(/^([^(]*)(?:\(([^)]*)\))?$/)!
      return {
        host: cm[1] || '*',
        options: (cm[2] ?? '')
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      }
    })
    out.push({ path, clients, line: start })
  }
  return out
}

export function renderExport(spec: NfsExportSpec): string {
  const path = /\s/.test(spec.path) ? `"${spec.path}"` : spec.path
  return `${path} ${spec.clients.map((c) => `${c.host}${c.options.length ? `(${c.options.join(',')})` : ''}`).join(' ')}`
}

/** Replaces, removes or appends one export line. */
export function setExport(text: string, originalPath: string | undefined, spec: NfsExportSpec | null): string {
  const lines = text.split('\n')
  const entries = parseExportsFile(text)
  const cur = originalPath ? entries.find((e) => e.path === originalPath) : undefined
  if (originalPath && !cur) throw new Error(tr(`Export ${originalPath} nicht gefunden`, `Export ${originalPath} not found`))
  if (spec && spec.path !== originalPath && entries.some((e) => e.path === spec.path)) throw new Error(tr(`${spec.path} ist hier schon exportiert`, `${spec.path} is already exported here`))
  if (cur) {
    let end = cur.line
    while (lines[end]!.replace(/\r$/, '').endsWith('\\')) end++
    lines.splice(cur.line, end - cur.line + 1, ...(spec ? [renderExport(spec)] : []))
    return lines.join('\n')
  }
  if (!spec) return text
  const body = text.replace(/\s*$/, '')
  return `${body ? `${body}\n` : '# Managed by Quadeck – manual changes here are fine too\n'}${renderExport(spec)}\n`
}

// ---------- status output ----------

/** smbstatus -S: "Service  pid  Machine  Connected at …". */
export function parseSmbstatusShares(out: string): { share: string; client: string; since?: number }[] {
  const rows: { share: string; client: string; since?: number }[] = []
  let started = false
  for (const line of out.split('\n')) {
    if (/^-{5,}/.test(line.trim())) {
      started = true
      continue
    }
    if (!started || !line.trim()) continue
    const m = line.trim().match(/^(\S+)\s+(\d+)\s+(\S+)\s+(.+?)(\s{2,}\S.*)?$/)
    if (!m || m[1] === 'IPC$') continue
    const t = Date.parse(m[4]!.replace(/\s+[A-Z]{2,5}$/, ''))
    rows.push({ share: m[1]!, client: m[3]!, since: Number.isFinite(t) ? t : undefined })
  }
  return rows
}

/** /proc/fs/nfsd/clients/<n>/info → "address: '192.168.1.20:839'". */
export function parseNfsdClientInfo(text: string): string | undefined {
  return text.match(/^address:\s*'?([^'\n]+?)(?::\d+)?'?$/m)?.[1]
}
