import { HttpError } from '../auth'
import { msg } from '~/shared/i18n'
import { m } from '~/paraglide/messages'
import type { EntryInput, FstabChange } from '~/shared/fstab'

// Request bodies → FstabChange, at both boundaries (API route and helper).

const str = (v: unknown, max = 4096) => {
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, msg(m.fstab_error_invalidRequest))
  return v
}

function entry(v: unknown): EntryInput {
  if (!v || typeof v !== 'object') throw new HttpError(400, msg(m.fstab_error_entryMissing))
  const e = v as Record<string, unknown>
  if (!Array.isArray(e.options) || e.options.length > 40) throw new HttpError(400, msg(m.fstab_error_invalidOptions))
  return {
    spec: str(e.spec, 300),
    file: str(e.file, 300),
    vfstype: str(e.vfstype, 40),
    options: e.options.map((o) => str(o, 200)),
    freq: Number(e.freq) || 0,
    passno: Number(e.passno) || 0,
    note: e.note === undefined ? undefined : str(e.note, 200),
  }
}

export function parseFstabChange(v: unknown): FstabChange {
  if (!v || typeof v !== 'object') throw new HttpError(400, msg(m.fstab_error_changeMissing))
  const c = v as Record<string, unknown>
  const line = Number(c.line)
  switch (c.kind) {
    case 'add':
      return { kind: 'add', entry: entry(c.entry) }
    case 'update':
      if (!Number.isInteger(line) || line < 1) throw new HttpError(400, msg(m.fstab_error_lineMissing))
      return { kind: 'update', line, original: str(c.original, 2000), entry: entry(c.entry) }
    case 'remove':
      if (!Number.isInteger(line) || line < 1) throw new HttpError(400, msg(m.fstab_error_lineMissing))
      return { kind: 'remove', line, original: str(c.original, 2000) }
    case 'restore':
      return { kind: 'restore', content: str(c.content, 256 * 1024) }
  }
  throw new HttpError(400, msg(m.fstab_error_unknownChange))
}
