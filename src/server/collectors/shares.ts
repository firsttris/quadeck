// Shares collector: SMB from smb.conf, NFS from /etc/exports and /etc/exports.d.
// Read-only parsing of the config files; nothing is executed.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { msg } from '~/shared/i18n'
import type { SharesState } from '~/shared/shares'
import type { Share } from '~/shared/types'

const SKIP_SECTIONS = new Set(['global', 'homes', 'printers', 'print$'])
const yes = (v: string | undefined) => !!v && /^(yes|true|1)$/i.test(v.trim())
const no = (v: string | undefined) => !!v && /^(no|false|0)$/i.test(v.trim())

/** Joins "\"-continued lines and drops comments. */
function logicalLines(text: string, comment: RegExp): string[] {
  const out: string[] = []
  let cur = ''
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!cur && comment.test(line.trim())) continue
    if (line.endsWith('\\')) {
      cur += line.slice(0, -1) + ' '
      continue
    }
    out.push((cur + line).trim())
    cur = ''
  }
  if (cur) out.push(cur.trim())
  return out.filter(Boolean)
}

export function parseSmbConf(text: string): Share[] {
  const sections: { name: string; opts: Record<string, string> }[] = []
  for (const line of logicalLines(text, /^[#;]/)) {
    const sec = line.match(/^\[(.+)\]$/)
    if (sec) {
      sections.push({ name: sec[1]!.trim(), opts: {} })
      continue
    }
    const kv = line.match(/^([^=]+?)\s*=\s*(.*)$/)
    if (kv && sections.length) sections[sections.length - 1]!.opts[kv[1]!.toLowerCase().replace(/\s+/g, ' ')] = kv[2]!.trim()
  }
  const shares: Share[] = []
  for (const { name, opts } of sections) {
    if (SKIP_SECTIONS.has(name.toLowerCase()) || yes(opts['printable']) || yes(opts['print ok']) || !opts['path']) continue
    if (no(opts['available'])) continue
    // "writable", "writeable" and "write ok" are inverse synonyms of "read only" (default: read only = yes).
    const writable = [opts['writable'], opts['writeable'], opts['write ok']].some(yes) || no(opts['read only'])
    const readonly = yes(opts['read only']) || !writable
    const notes: string[] = []
    if (yes(opts['guest ok']) || yes(opts['public'])) notes.push(msg('collectors_guestsAllowed'))
    if (opts['valid users']) notes.push(msg('shares_smb_onlyUsers', { users: opts['valid users'] }))
    if (no(opts['browseable']) || no(opts['browsable'])) notes.push(msg('shares_smb_hidden'))
    shares.push({ type: 'SMB', name, path: opts['path'], access: readonly ? msg('shares_smb_read') : msg('shares_smb_readWrite'), note: notes.join(' · ') || undefined })
  }
  return shares
}

export function parseExports(text: string): Share[] {
  const shares: Share[] = []
  for (const line of logicalLines(text, /^#/)) {
    const m = line.match(/^("([^"]+)"|(\S+))\s*(.*)$/)
    if (!m) continue
    const path = m[2] ?? m[3]!
    if (!path.startsWith('/')) continue
    const clients = (m[4] ?? '').match(/[^\s(]*(\([^)]*\))?/g)?.filter(Boolean) ?? []
    const parsed = clients.map((c) => {
      const cm = c.match(/^([^(]*)(?:\(([^)]*)\))?$/)!
      const opts = (cm[2] ?? '').split(',').map((o) => o.trim())
      return { host: cm[1] || '*', rw: opts.includes('rw') }
    })
    if (!parsed.length) parsed.push({ host: '*', rw: false })
    const access = parsed.map((c) => `${c.host}${c.rw ? '' : ' (ro)'}`).join(', ')
    shares.push({ type: 'NFS', name: basename(path) || path, path, access })
  }
  return shares
}

export function collectShares(paths: { smbConf: string; exports: string; exportsDir: string }): Share[] {
  const read = (p: string) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return undefined
    }
  }
  const out: Share[] = []
  const smb = read(paths.smbConf)
  if (smb) out.push(...parseSmbConf(smb))
  const exp = read(paths.exports)
  if (exp) out.push(...parseExports(exp))
  if (existsSync(paths.exportsDir)) {
    for (const f of readdirSync(paths.exportsDir)
      .filter((f) => f.endsWith('.exports'))
      .sort()) {
      const t = read(join(paths.exportsDir, f))
      if (t) out.push(...parseExports(t))
    }
  }
  return out
}

/** Overview-card rows from the full shares state. */
export function sharesSummary(st: SharesState): Share[] {
  const smb: Share[] = st.smb.shares.map((s) => {
    const notes = [
      s.guestOk ? msg('collectors_guestsAllowed') : '',
      s.validUsers ? msg('collectors_only', { validUsers: s.validUsers }) : '',
      s.browseable ? '' : msg('shares_smb_hidden'),
      s.connections ? msg('collectors_connected', { connections: s.connections }) : '',
    ].filter(Boolean)
    return { type: 'SMB', name: s.name, path: s.path, access: s.readOnly ? msg('shares_smb_read') : msg('shares_smb_readWrite'), note: notes.join(' · ') || undefined }
  })
  const nfs: Share[] = st.nfs.exports.map((e) => ({
    type: 'NFS',
    name: basename(e.path) || e.path,
    path: e.path,
    access: e.clients.map((c) => `${c.host}${c.options.includes('rw') ? '' : ' (ro)'}`).join(', '),
  }))
  return [...smb, ...nfs]
}
