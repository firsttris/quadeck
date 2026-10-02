import { HttpError } from '../auth'
import type { UserChange } from '~/shared/users'

// Request bodies → UserChange at both boundaries (API route and helper). The
// content checks (name rules, existing groups, lock-out) follow in the backend.

const str = (v: unknown, max = 600) => {
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, 'Ungültige Anfrage')
  return v
}

export function parseUserChange(v: unknown): UserChange {
  if (!v || typeof v !== 'object') throw new HttpError(400, 'Änderung fehlt')
  const c = v as Record<string, unknown>
  const name = str(c.name, 32)
  const groups = () => {
    if (!Array.isArray(c.groups) || c.groups.length > 50) throw new HttpError(400, 'Ungültige Gruppen')
    return [...new Set(c.groups.map((g) => str(g, 32)))]
  }
  switch (c.kind) {
    case 'create':
      return { kind: 'create', name, fullName: str(c.fullName ?? '', 100), admin: c.admin === true, password: c.password === undefined || c.password === '' ? undefined : str(c.password, 512), shell: str(c.shell, 100), groups: groups() }
    case 'update':
      return { kind: 'update', name, fullName: str(c.fullName ?? '', 100), shell: str(c.shell, 100), groups: groups(), admin: c.admin === true }
    case 'password':
    case 'samba-password':
      return { kind: c.kind, name, password: str(c.password, 512) }
    case 'lock':
    case 'unlock':
      return { kind: c.kind, name }
    case 'delete':
      return { kind: 'delete', name, removeHome: c.removeHome === true }
  }
  throw new HttpError(400, 'Unbekannte Änderung')
}
