// Shares (SMB, NFS) on the host: read, preview, write with check + backup,
// reload, service control. SystemShares runs where root is; FixtureShares
// keeps demo files in memory.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HttpError } from '../auth'
import { run } from '../exec'
import {
  validateNfs,
  validateSmb,
  type NfsExportInfo,
  type ShareChange,
  type ShareConnection,
  type SharePreview,
  type ShareService,
  type ShareServiceAction,
  type SharesState,
} from '~/shared/shares'
import { parseExportsFile, parseNfsdClientInfo, parseSmbstatusShares, setExport, setSmbShare, smbShares } from './config'

export interface SharesAdmin {
  sharesState(): Promise<SharesState>
  previewShare(change: ShareChange): Promise<SharePreview>
}

export interface SharesBackend extends SharesAdmin {
  applyShare(change: ShareChange): Promise<SharesState>
  shareService(kind: 'smb' | 'nfs', action: ShareServiceAction): Promise<SharesState>
}

const SMB_UNITS = ['smb.service', 'smbd.service', 'nmb.service', 'nmbd.service']
const NFS_UNITS = ['nfs-server.service', 'nfs-kernel-server.service']

/** Parses a share change from outside (web app → helper). */
export function parseShareChange(v: unknown): ShareChange {
  const o = (v ?? {}) as Record<string, unknown>
  const str = (x: unknown) => (typeof x === 'string' ? x : '')
  if (o.kind === 'smb') {
    const s = o.spec as Record<string, unknown> | null
    const spec = s
      ? { name: str(s.name).trim(), path: str(s.path).trim(), comment: str(s.comment).trim(), readOnly: s.readOnly === true, guestOk: s.guestOk === true, validUsers: str(s.validUsers).trim(), browseable: s.browseable !== false }
      : null
    if (spec) {
      const errs = validateSmb(spec)
      if (errs.length) throw new HttpError(400, errs.join(' · '))
    }
    if (!spec && !str(o.original)) throw new HttpError(400, 'Nichts zu ändern')
    return { kind: 'smb', original: str(o.original) || undefined, spec }
  }
  if (o.kind === 'nfs') {
    const s = o.spec as Record<string, unknown> | null
    const spec = s
      ? {
          path: str(s.path).trim(),
          clients: (Array.isArray(s.clients) ? s.clients : []).map((c: Record<string, unknown>) => ({
            host: str(c?.host).trim(),
            options: (Array.isArray(c?.options) ? c.options : []).map(str).map((x: string) => x.trim()).filter(Boolean),
          })),
        }
      : null
    if (spec) {
      const errs = validateNfs(spec)
      if (errs.length) throw new HttpError(400, errs.join(' · '))
    }
    const orig = o.original as Record<string, unknown> | undefined
    const original = orig ? { file: str(orig.file), path: str(orig.path) } : undefined
    if (!spec && !original) throw new HttpError(400, 'Nichts zu ändern')
    return { kind: 'nfs', original, spec }
  }
  throw new HttpError(400, 'kind muss smb oder nfs sein')
}

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

function atomicWrite(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
  const tmp = `${path}.quadeck-tmp`
  writeFileSync(tmp, content, { mode: 0o644 })
  renameSync(tmp, path)
}

/** testparm on a candidate smb.conf (private temp directory). */
async function testparm(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'quadeck-smb-'))
  try {
    const file = join(dir, 'smb.conf')
    writeFileSync(file, text, { mode: 0o600 })
    return await run(['testparm', '-s', file], { timeoutMs: 15_000 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export class SystemShares implements SharesBackend {
  readonly smbConf: string
  readonly exports: string
  readonly exportsDir: string

  private reload: boolean

  /** reload = false: no smbcontrol/exportfs (tests on temp files). */
  constructor(opts: { smbConf?: string; exports?: string; exportsDir?: string; reload?: boolean } = {}) {
    this.reload = opts.reload ?? true
    this.smbConf = opts.smbConf ?? (process.env.QUADECK_SMB_CONF?.trim() || '/etc/samba/smb.conf')
    this.exports = opts.exports ?? (process.env.QUADECK_EXPORTS?.trim() || '/etc/exports')
    this.exportsDir = opts.exportsDir ?? '/etc/exports.d'
  }

  get managedExports() {
    return join(this.exportsDir, 'quadeck.exports')
  }

  private exportFiles() {
    const files = [this.exports]
    try {
      files.push(...readdirSync(this.exportsDir).filter((f) => f.endsWith('.exports')).sort().map((f) => join(this.exportsDir, f)))
    } catch {
      // no exports.d
    }
    if (!files.includes(this.managedExports)) files.push(this.managedExports)
    return files
  }

  private async services(units: string[]): Promise<ShareService[]> {
    const r = await run(['systemctl', 'show', ...units, '-p', 'Id,LoadState,ActiveState,UnitFileState'])
    return r.stdout
      .trim()
      .split(/\n\s*\n/)
      .map((b) => Object.fromEntries(b.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])))
      .filter((p) => p.Id && p.LoadState === 'loaded')
      .map((p) => ({ unit: p.Id!, exists: true, active: p.ActiveState === 'active', enabled: p.UnitFileState === 'enabled' }))
  }

  private async smbConnections(): Promise<ShareConnection[]> {
    if (!Bun.which('smbstatus')) return []
    const r = await run(['smbstatus', '-S'], { timeoutMs: 5000 })
    return r.code === 0 ? parseSmbstatusShares(r.stdout) : []
  }

  private nfsClients(): string[] {
    const dir = '/proc/fs/nfsd/clients'
    try {
      return [...new Set(readdirSync(dir).map((c) => parseNfsdClientInfo(read(join(dir, c, 'info')) ?? '')).filter((x): x is string => !!x))]
    } catch {
      return []
    }
  }

  async sharesState(): Promise<SharesState> {
    const smbText = read(this.smbConf)
    const connections = await this.smbConnections()
    const exportsList: NfsExportInfo[] = []
    for (const f of this.exportFiles()) {
      const t = read(f)
      if (t) for (const e of parseExportsFile(t)) exportsList.push({ ...e, file: f, managed: f === this.managedExports })
    }
    const [smbServices, nfsServices] = await Promise.all([this.services(SMB_UNITS), this.services(NFS_UNITS)])
    return {
      smb: {
        file: this.smbConf,
        exists: smbText !== undefined,
        installed: !!Bun.which('smbd') || existsSync('/usr/sbin/smbd'),
        shares: smbText ? smbShares(smbText).map((s) => ({ ...s, connections: connections.filter((c) => c.share.toLowerCase() === s.name.toLowerCase()).length })) : [],
        services: smbServices,
        connections,
      },
      nfs: {
        files: this.exportFiles().filter((f) => existsSync(f)),
        managedFile: this.managedExports,
        installed: !!Bun.which('exportfs') || existsSync('/usr/sbin/exportfs'),
        exports: exportsList,
        services: nfsServices,
        clients: this.nfsClients(),
      },
    }
  }

  private target(change: ShareChange): { file: string; before: string; after: string; warnings: string[] } {
    const warnings: string[] = []
    const path = change.spec?.path
    if (path) {
      try {
        if (!statSync(path).isDirectory()) throw new Error()
      } catch {
        throw new HttpError(422, `${path} existiert nicht oder ist kein Verzeichnis`)
      }
    }
    try {
      if (change.kind === 'smb') {
        const before = read(this.smbConf) ?? ''
        if (change.spec?.guestOk && !change.spec.readOnly) warnings.push('Gäste dürfen schreiben – jeder im Netz kann Dateien ändern oder löschen')
        return { file: this.smbConf, before, after: setSmbShare(before, change.original, change.spec), warnings }
      }
      // NFS: changes stay in the file the export lives in; new ones go to quadeck.exports.
      const file = change.original?.file || this.managedExports
      if (!this.exportFiles().includes(file)) throw new HttpError(400, `Unbekannte exports-Datei: ${file}`)
      const before = read(file) ?? ''
      if (change.spec?.clients.some((c) => c.host === '*' && c.options.includes('rw'))) warnings.push('Schreibzugriff für alle Rechner (*) – besser auf das eigene Netz beschränken')
      if (change.spec?.clients.some((c) => c.options.includes('no_root_squash'))) warnings.push('no_root_squash: root auf dem Client ist auch hier root')
      return { file, before, after: setExport(before, change.original?.path, change.spec), warnings }
    } catch (e) {
      if (e instanceof HttpError) throw e
      throw new HttpError(409, (e as Error).message)
    }
  }

  async previewShare(change: ShareChange): Promise<SharePreview> {
    const t = this.target(change)
    if (change.kind === 'smb' && Bun.which('testparm')) {
      const r = await testparm(t.after)
      const errs = (r.stderr + r.stdout).split('\n').filter((l) => /error|unknown parameter|ignoring/i.test(l))
      if (r.code !== 0 || errs.length) t.warnings.push(`testparm: ${errs.join(' · ') || `Exit ${r.code}`}`)
    }
    return t
  }

  async applyShare(change: ShareChange): Promise<SharesState> {
    const t = this.target(change)
    if (change.kind === 'smb' && Bun.which('testparm')) {
      const r = await testparm(t.after)
      if (r.code !== 0) throw new HttpError(422, `testparm lehnt die Konfiguration ab: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' · ')}`)
    }
    if (existsSync(t.file)) writeFileSync(`${t.file}.quadeck-bak`, t.before, { mode: 0o644 })
    atomicWrite(t.file, t.after)
    if (change.kind === 'smb') {
      // Running smbd picks the change up without disconnecting anyone.
      if (this.reload && Bun.which('smbcontrol')) await run(['smbcontrol', 'smbd', 'reload-config'], { timeoutMs: 15_000 })
    } else if (this.reload && Bun.which('exportfs')) {
      const r = await run(['exportfs', '-ra'], { timeoutMs: 30_000 })
      if (r.code !== 0) {
        // Roll back so NFS keeps working with the old exports.
        atomicWrite(t.file, t.before)
        await run(['exportfs', '-ra'], { timeoutMs: 30_000 })
        throw new HttpError(422, `exportfs lehnt den Export ab (zurückgesetzt): ${(r.stderr || r.stdout).trim()}`)
      }
    }
    return this.sharesState()
  }

  async shareService(kind: 'smb' | 'nfs', action: ShareServiceAction): Promise<SharesState> {
    const units = (await this.services(kind === 'smb' ? SMB_UNITS : NFS_UNITS)).map((s) => s.unit)
    if (!units.length) throw new HttpError(404, kind === 'smb' ? 'Samba ist nicht installiert (Paket samba)' : 'Kein NFS-Server installiert (nfs-utils / nfs-kernel-server)')
    const argv = action === 'enable' ? ['systemctl', 'enable', '--now', ...units] : ['systemctl', action, ...units]
    const r = await run(argv, { timeoutMs: 60_000 })
    if (r.code !== 0) throw new HttpError(500, `${argv.join(' ')}: ${r.stderr.trim()}`)
    return this.sharesState()
  }
}

// ---------- fixtures ----------

export class FixtureShares implements SharesBackend {
  private files = new Map<string, string>()
  private svc = { smb: { active: true, enabled: true }, nfs: { active: true, enabled: true } }

  constructor(private dir: string) {
    this.files.set('/etc/samba/smb.conf', read(join(dir, 'smb.conf')) ?? '')
    this.files.set('/etc/exports', read(join(dir, 'exports')) ?? '')
  }

  private managed = '/etc/exports.d/quadeck.exports'

  /** Demo directories that "exist". */
  private dirExists(p: string) {
    return p.startsWith('/mnt/') || p.startsWith('/srv/')
  }

  async sharesState(): Promise<SharesState> {
    const smbText = this.files.get('/etc/samba/smb.conf') ?? ''
    const connections: ShareConnection[] = [
      { share: 'Medien', client: '192.168.1.31', since: Date.now() - 3600_000 },
      { share: 'Medien', client: '192.168.1.42', since: Date.now() - 600_000 },
    ]
    const exportsList: NfsExportInfo[] = []
    for (const [f, t] of this.files) if (f !== '/etc/samba/smb.conf') for (const e of parseExportsFile(t)) exportsList.push({ ...e, file: f, managed: f === this.managed })
    const s = this.svc
    return {
      smb: {
        file: '/etc/samba/smb.conf',
        exists: true,
        installed: true,
        shares: smbShares(smbText).map((x) => ({ ...x, connections: connections.filter((c) => c.share === x.name).length })),
        services: [
          { unit: 'smb.service', exists: true, ...s.smb },
          { unit: 'nmb.service', exists: true, ...s.smb },
        ],
        connections,
      },
      nfs: {
        files: [...this.files.keys()].filter((f) => f !== '/etc/samba/smb.conf'),
        managedFile: this.managed,
        installed: true,
        exports: exportsList,
        services: [{ unit: 'nfs-server.service', exists: true, ...s.nfs }],
        clients: ['192.168.1.20'],
      },
    }
  }

  private target(change: ShareChange) {
    const warnings: string[] = []
    if (change.spec?.path && !this.dirExists(change.spec.path)) throw new HttpError(422, `${change.spec.path} existiert nicht oder ist kein Verzeichnis`)
    try {
      if (change.kind === 'smb') {
        const before = this.files.get('/etc/samba/smb.conf') ?? ''
        if (change.spec?.guestOk && !change.spec.readOnly) warnings.push('Gäste dürfen schreiben – jeder im Netz kann Dateien ändern oder löschen')
        return { file: '/etc/samba/smb.conf', before, after: setSmbShare(before, change.original, change.spec), warnings }
      }
      const file = change.original?.file || this.managed
      const before = this.files.get(file) ?? ''
      if (change.spec?.clients.some((c) => c.host === '*' && c.options.includes('rw'))) warnings.push('Schreibzugriff für alle Rechner (*) – besser auf das eigene Netz beschränken')
      if (change.spec?.clients.some((c) => c.options.includes('no_root_squash'))) warnings.push('no_root_squash: root auf dem Client ist auch hier root')
      return { file, before, after: setExport(before, change.original?.path, change.spec), warnings }
    } catch (e) {
      if (e instanceof HttpError) throw e
      throw new HttpError(409, (e as Error).message)
    }
  }

  async previewShare(change: ShareChange) {
    return this.target(change)
  }

  async applyShare(change: ShareChange) {
    const t = this.target(change)
    this.files.set(t.file, t.after)
    return this.sharesState()
  }

  async shareService(kind: 'smb' | 'nfs', action: ShareServiceAction) {
    this.svc[kind] = action === 'stop' ? { ...this.svc[kind], active: false } : action === 'enable' ? { active: true, enabled: true } : { ...this.svc[kind], active: true }
    return this.sharesState()
  }

  /** Current demo files (the hub shows the overview card from them). */
  text(file: 'smb' | 'exports') {
    if (file === 'smb') return this.files.get('/etc/samba/smb.conf') ?? ''
    return [...this.files].filter(([f]) => f !== '/etc/samba/smb.conf').map(([, t]) => t).join('\n')
  }
}
