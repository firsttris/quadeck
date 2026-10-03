// Reverse proxy: edit the Caddyfile and reload Caddy.
//
// Finding the file, in order: QUADECK_CADDYFILE → a path picked in the UI →
// the Caddy Quadlet (path inside the container from Exec= or the image
// default, mapped to the host through Volume=) → caddy.service on the host →
// /etc/caddy/Caddyfile if it exists.
//
// Saving: check (admin API /adapt, else `caddy validate` in a throwaway
// container of the same image, else the caddy binary on the host) → history
// → write IN PLACE (a single-file bind mount keeps pointing at the old inode
// if the file is replaced) → reload (admin API /load, else `podman exec …
// caddy reload`, else `systemctl reload caddy`). A failed reload restores the
// previous file; Caddy keeps running with its old config either way.

import { closeSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { HttpError } from '../auth'
import { run } from '../exec'
import { UnitHistory } from '../systemd/editor'
import { msg } from '~/shared/i18n'
import type { Revision } from '~/shared/quadlets'
import {
  DEFAULT_CADDYFILE,
  applyCaddyChange,
  caddyFromQuadlet,
  configFromCommand,
  contentHash,
  manualPathProblem,
  parseCaddyfile,
  type CaddyChange,
  type CaddyResult,
  type CaddySource,
  type CaddyState,
  type QuadletCaddy,
} from '~/shared/caddy'

export interface CaddyAdmin {
  caddyState(): Promise<CaddyState>
  caddyRevision(id: string): Promise<string>
}

/** Writes; the caller has checked the unlock. */
export interface CaddyBackend extends CaddyAdmin {
  applyCaddy(change: CaddyChange, expected: string | undefined): Promise<CaddyResult>
  setCaddyPath(path: string | null): Promise<CaddyState>
}

const MAX = 1024 * 1024

export interface CaddyHost {
  /** QUADECK_CADDYFILE, only when set explicitly. */
  envPath(): string | undefined
  manualPath(): string | undefined
  setManualPath(path: string | undefined): void
  read(path: string): string | undefined
  isFile(path: string): boolean
  /** In place: truncate and write the same inode, owner and mode stay. */
  write(path: string, content: string): void
  quadlets(): { name: string; content: string }[]
  /** caddy.service on the host: ExecStart, if the unit exists. */
  service(): Promise<{ execStart: string; active: boolean } | undefined>
  volumePath(name: string): Promise<string | undefined>
  /** Admin API reachable? */
  api(): Promise<boolean>
  /** Error text, or undefined when Caddy accepts it. */
  apiAdapt(content: string): Promise<string | undefined>
  apiLoad(content: string): Promise<string | undefined>
  containerRunning(name: string): Promise<boolean>
  /** Error text, undefined when valid, 'unavailable' when it cannot be checked this way. */
  validateInImage(q: QuadletCaddy, content: string): Promise<string | undefined | 'unavailable'>
  validateOnHost(content: string): Promise<string | undefined | 'unavailable'>
  execReload(container: string, containerPath: string): Promise<string | undefined>
  serviceReload(): Promise<string | undefined>
  history: { list(path: string): Revision[]; read(path: string, id: string): string; saved(path: string, before: string | undefined, after: string): void }
}

interface Located {
  source?: CaddySource
  quadlet?: QuadletCaddy
  problem?: string
  readonly?: string
}

export class CaddyManager implements CaddyBackend {
  constructor(private host: CaddyHost) {}

  async locate(): Promise<Located> {
    const h = this.host
    const env = h.envPath()
    if (env) return h.isFile(env) ? { source: { path: env, how: 'env' } } : { source: { path: env, how: 'env' }, problem: msg('proxy_errors_envMissing', { path: env }) }
    const manual = h.manualPath()
    if (manual) return h.isFile(manual) ? { source: { path: manual, how: 'manual' } } : { source: { path: manual, how: 'manual' }, problem: msg('proxy_errors_manualGone', { path: manual }) }
    for (const f of h.quadlets()) {
      const q = caddyFromQuadlet(f.name, f.content)
      if (!q) continue
      const base = { how: 'quadlet' as const, quadlet: q.quadlet, container: q.container, image: q.image, containerPath: q.containerPath }
      if (q.json) return { quadlet: q, problem: msg('proxy_errors_json', { quadlet: q.quadlet }) }
      let path = q.hostPath
      if (!path && q.volume) {
        const mp = await h.volumePath(q.volume.name)
        if (mp) path = mp.replace(/\/+$/, '') + q.volume.rest
      }
      if (!path)
        return {
          quadlet: q,
          problem: msg('proxy_errors_notMounted', { quadlet: q.quadlet, containerPath: q.containerPath }),
        }
      return h.isFile(path) ? { source: { ...base, path }, quadlet: q } : { source: { ...base, path }, quadlet: q, problem: msg('proxy_errors_mountedMissing', { quadlet: q.quadlet, path: path }) }
    }
    const svc = await h.service()
    if (svc) {
      const path = configFromCommand(svc.execStart).path ?? DEFAULT_CADDYFILE
      if (h.isFile(path)) return { source: { path, how: 'service' } }
    }
    if (h.isFile(DEFAULT_CADDYFILE)) return { source: { path: DEFAULT_CADDYFILE, how: 'default' } }
    return { problem: msg('proxy_errors_notFound') }
  }

  /** How a change would go live right now. */
  private async reloadVia(loc: Located): Promise<CaddyState['reload']> {
    const h = this.host
    if (await h.api()) return 'api'
    if (loc.quadlet && (await h.containerRunning(loc.quadlet.container))) return 'container'
    if ((await h.service())?.active) return 'service'
    return 'none'
  }

  private async state(loc?: Located): Promise<CaddyState> {
    loc ??= await this.locate()
    const reload = await this.reloadVia(loc)
    const base: CaddyState = { source: loc.source, problem: loc.problem, blocks: [], unstructured: false, running: reload !== 'none', reload, history: [], manual: this.host.manualPath() }
    if (!loc.source || loc.problem) return base
    const content = this.host.read(loc.source.path)
    if (content === undefined) return { ...base, problem: msg('proxy_errors_unreadable', { path: loc.source!.path }) }
    if (content.length > MAX || content.includes('\0')) return { ...base, problem: msg('proxy_errors_notText', { path: loc.source!.path }) }
    const parsed = parseCaddyfile(content)
    return { ...base, content, hash: contentHash(content), blocks: parsed.blocks, unstructured: parsed.unstructured, history: this.host.history.list(loc.source.path) }
  }

  caddyState() {
    return this.state()
  }

  async caddyRevision(id: string) {
    const loc = await this.locate()
    if (!loc.source)
      throw new HttpError(
        404,
        msg('proxy_errors_noFile'),
      )
    return this.host.history.read(loc.source.path, id)
  }

  async setCaddyPath(path: string | null) {
    if (path === null) {
      this.host.setManualPath(undefined)
      return this.state()
    }
    const p = path.trim()
    const problem = manualPathProblem(p)
    if (problem) throw new HttpError(400, problem)
    if (!this.host.isFile(p))
      throw new HttpError(
        404,
        msg('proxy_errors_missing', { path: p }),
      )
    const content = this.host.read(p) ?? ''
    if (content.length > MAX || content.includes('\0'))
      throw new HttpError(
        400,
        msg('proxy_errors_notText', { path: p }),
      )
    this.host.setManualPath(p)
    return this.state()
  }

  /** Error text from Caddy, or a warning when nothing could check it. */
  private async validate(loc: Located, content: string): Promise<{ error?: string; warning?: string }> {
    const h = this.host
    if (await h.api()) {
      const err = await h.apiAdapt(content)
      return err ? { error: err } : {}
    }
    if (loc.quadlet) {
      const r = await h.validateInImage(loc.quadlet, content)
      if (r !== 'unavailable') return r ? { error: r } : {}
    }
    const r = await h.validateOnHost(content)
    if (r !== 'unavailable') return r ? { error: r } : {}
    return { warning: msg('proxy_errors_unchecked') }
  }

  async applyCaddy(change: CaddyChange, expected: string | undefined): Promise<CaddyResult> {
    const loc = await this.locate()
    if (!loc.source || loc.problem) throw new HttpError(409, loc.problem ?? msg('proxy_errors_noFile'))
    const path = loc.source.path
    const before = this.host.read(path) ?? ''
    if (expected && expected !== contentHash(before))
      throw new HttpError(
        409,
        msg('proxy_errors_changed'),
      )
    let after: string
    try {
      after = applyCaddyChange(before, change)
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
    if (after.length > MAX || after.includes('\0'))
      throw new HttpError(
        400,
        msg('common_errors_invalidContent'),
      )
    if (after === before) return { state: await this.state(loc), reloaded: 'none', warning: msg('proxy_errors_noChange') }
    const check = await this.validate(loc, after)
    if (check.error) throw new HttpError(422, msg('proxy_errors_rejected') + check.error)
    this.host.history.saved(path, before, after)
    this.host.write(path, after)
    const via = await this.reloadVia(loc)
    let err: string | undefined
    if (via === 'api') err = await this.host.apiLoad(after)
    else if (via === 'container') err = await this.host.execReload(loc.quadlet!.container, loc.quadlet!.containerPath)
    else if (via === 'service') err = await this.host.serviceReload()
    if (err) {
      this.host.write(path, before)
      throw new HttpError(422, msg('proxy_errors_reloadFailed') + err)
    }
    const warning = check.warning ?? (via === 'none' ? msg('proxy_errors_stopped') : undefined)
    return { state: await this.state(loc), reloaded: via, warning }
  }
}

// ---------- the real host ----------

const readSafe = (p: string) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

/** Last line(s) of Caddy's error output, without the JSON log noise. */
function caddyError(out: string): string {
  const lines = out.trim().split('\n').filter(Boolean)
  const msg = lines.map((l) => {
    try {
      const j = JSON.parse(l) as { msg?: string; error?: string }
      return j.error ?? j.msg ?? l
    } catch {
      return l
    }
  })
  return (msg.filter((l) => /error|Error|invalid|unrecognized|unexpected|wrong/.test(l)).at(-1) ?? msg.at(-1) ?? '').slice(0, 600)
}

export class SystemCaddyHost implements CaddyHost {
  history: CaddyHost['history']

  constructor(
    private adminUrl = process.env.QUADECK_CADDY_ADMIN?.trim() || 'http://localhost:2019',
    private quadletDir = process.env.QUADECK_QUADLET_DIR?.trim() || '/etc/containers/systemd',
    private stateFile = process.env.QUADECK_CADDY_STATE || '/var/lib/quadeck-helper/caddy.json',
    historyDir = process.env.QUADECK_CADDY_HISTORY || '/var/lib/quadeck-helper/caddy-history',
  ) {
    const h = new UnitHistory(historyDir)
    this.history = { list: (p) => h.list(p), read: (p, id) => h.read(p, id), saved: (p, b, a) => h.saved(p, b, a) }
  }

  envPath() {
    return process.env.QUADECK_CADDYFILE?.trim() || undefined
  }

  manualPath() {
    try {
      const v = (JSON.parse(readFileSync(this.stateFile, 'utf8')) as { path?: unknown }).path
      return typeof v === 'string' ? v : undefined
    } catch {
      return undefined
    }
  }

  setManualPath(path: string | undefined) {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 })
    writeFileSync(this.stateFile, JSON.stringify(path ? { path } : {}), { mode: 0o600 })
  }

  read(path: string) {
    return readSafe(path)
  }

  isFile(path: string) {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }

  write(path: string, content: string) {
    // Never through a symlink into something else: the target must still be a regular file.
    const real = lstatSync(path).isSymbolicLink() ? realpathSync(path) : path
    if (!statSync(real).isFile())
      throw new HttpError(
        409,
        msg('proxy_errors_notRegular', { path: path }),
      )
    const fd = openSync(real, 'r+')
    try {
      ftruncateSync(fd, 0)
      writeSync(fd, content, 0, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  quadlets() {
    try {
      return readdirSync(this.quadletDir)
        .filter((f) => f.endsWith('.container'))
        .sort()
        .map((f) => ({ name: f, content: readSafe(join(this.quadletDir, f)) ?? '' }))
    } catch {
      return []
    }
  }

  async service() {
    const r = await run(['systemctl', 'show', 'caddy.service', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'ExecStart', '--no-pager'])
    if (r.code !== 0) return undefined
    const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(r.stdout)?.[1] ?? ''
    if (get('LoadState') !== 'loaded') return undefined
    const exec = /argv\[\]=([^;]*)/.exec(get('ExecStart'))?.[1]?.trim() ?? ''
    return { execStart: exec, active: get('ActiveState') === 'active' }
  }

  async volumePath(name: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) return undefined
    const r = await run(['podman', 'volume', 'inspect', '--format', '{{.Mountpoint}}', name])
    return r.code === 0 ? r.stdout.trim() || undefined : undefined
  }

  private url(path: string) {
    return `${this.adminUrl.replace(/\/$/, '')}${path}`
  }

  async api() {
    try {
      const r = await fetch(this.url('/config/'), { signal: AbortSignal.timeout(3000) })
      return r.ok
    } catch {
      return false
    }
  }

  private async post(path: string, content: string): Promise<string | undefined> {
    try {
      const r = await fetch(this.url(path), { method: 'POST', headers: { 'content-type': 'text/caddyfile' }, body: content, signal: AbortSignal.timeout(30_000) })
      if (r.ok) return undefined
      const text = await r.text()
      try {
        return (JSON.parse(text) as { error?: string }).error ?? text.slice(0, 600)
      } catch {
        return text.slice(0, 600) || `HTTP ${r.status}`
      }
    } catch (e) {
      return (e as Error).message
    }
  }

  apiAdapt(content: string) {
    return this.post('/adapt', content)
  }

  apiLoad(content: string) {
    return this.post('/load', content)
  }

  async containerRunning(name: string) {
    const r = await run(['podman', 'container', 'inspect', '--format', '{{.State.Running}}', name])
    return r.code === 0 && r.stdout.trim() === 'true'
  }

  async validateInImage(q: QuadletCaddy, content: string) {
    if (!Bun.which('podman')) return 'unavailable' as const
    const dir = join(tmpdir(), `quadeck-caddy-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { mode: 0o700 })
    try {
      const file = join(dir, 'Caddyfile')
      writeFileSync(file, content, { mode: 0o644 })
      // Same mounts as the real container (imports keep working), the candidate over the Caddyfile.
      const mounts = q.volumes.flatMap((v) => ['-v', v.replace(/:(ro|rw|z|Z)(,(ro|rw|z|Z))*$/, ':ro')])
      const r = await run(['podman', 'run', '--rm', '--network=none', '--pull=never', ...mounts, '-v', `${file}:${q.containerPath}:ro`, q.image, 'caddy', 'validate', '--config', q.containerPath, '--adapter', 'caddyfile'], {
        timeoutMs: 60_000,
      })
      if (r.code === 0) return undefined
      if (/image not known|no such image|Error: .*pull/i.test(r.stderr)) return 'unavailable' as const
      return caddyError(r.stderr || r.stdout)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async validateOnHost(content: string) {
    if (!Bun.which('caddy')) return 'unavailable' as const
    const dir = join(tmpdir(), `quadeck-caddy-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { mode: 0o700 })
    try {
      const file = join(dir, 'Caddyfile')
      writeFileSync(file, content, { mode: 0o600 })
      const r = await run(['caddy', 'validate', '--config', file, '--adapter', 'caddyfile'], { timeoutMs: 60_000 })
      return r.code === 0 ? undefined : caddyError(r.stderr || r.stdout)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async execReload(container: string, containerPath: string) {
    const r = await run(['podman', 'exec', container, 'caddy', 'reload', '--config', containerPath, '--adapter', 'caddyfile'], { timeoutMs: 60_000 })
    return r.code === 0 ? undefined : caddyError(r.stderr || r.stdout)
  }

  async serviceReload() {
    const r = await run(['systemctl', 'reload', 'caddy.service'], { timeoutMs: 60_000 })
    return r.code === 0 ? undefined : (r.stderr || r.stdout).trim().slice(0, 600)
  }
}

// ---------- demo ----------

/** Demo: the files live in memory; "Caddy" accepts what parses and has balanced braces. */
export class FixtureCaddyHost implements CaddyHost {
  private files = new Map<string, string>()
  private manual: string | undefined
  private quadletFiles: { name: string; content: string }[] = []
  private revs = new Map<string, { rev: Revision; content: string }[]>()
  private seq = 0
  history: CaddyHost['history']

  constructor(dir: string) {
    const caddyfile = readSafe(join(dir, 'Caddyfile'))
    if (caddyfile !== undefined) this.files.set('/etc/caddy/Caddyfile', caddyfile)
    try {
      this.quadletFiles = readdirSync(join(dir, 'quadlets'))
        .filter((f) => f.endsWith('.container'))
        .sort()
        .map((f) => ({ name: f, content: readSafe(join(dir, 'quadlets', f)) ?? '' }))
    } catch {
      // none
    }
    this.history = {
      list: (p) => (this.revs.get(p) ?? []).map((r) => r.rev).reverse(),
      read: (p, id) => {
        const r = this.revs.get(p)?.find((x) => x.rev.id === id)
        if (!r)
          throw new HttpError(
            404,
            msg('common_errors_versionNotFound'),
          )
        return r.content
      },
      saved: (p, b, a) => {
        const list = this.revs.get(p) ?? []
        const add = (content: string, message: string) => list.push({ rev: { id: `${Date.now()}-${++this.seq}`, date: Date.now(), message }, content })
        if (b !== undefined && !list.length)
          add(
            b,
            msg('common_history_original'),
          )
        add(
          a,
          msg('common_history_saved'),
        )
        this.revs.set(p, list.slice(-20))
      },
    }
  }

  envPath() {
    return undefined
  }
  manualPath() {
    return this.manual
  }
  setManualPath(path: string | undefined) {
    this.manual = path
  }
  read(path: string) {
    return this.files.get(path)
  }
  isFile(path: string) {
    return this.files.has(path)
  }
  write(path: string, content: string) {
    this.files.set(path, content)
  }
  quadlets() {
    return this.quadletFiles
  }
  async service() {
    return undefined
  }
  async volumePath() {
    return undefined
  }
  async api() {
    return true
  }
  private check(content: string) {
    let depth = 0
    for (const c of content.replace(/#[^\n]*/g, '')) {
      if (c === '{') depth++
      if (c === '}') depth--
      if (depth < 0) break
    }
    if (depth !== 0) return 'Caddyfile:1 - Error during parsing: unexpected end of file or unbalanced braces'
    const bad = parseCaddyfile(content).blocks.find((b) => b.kind === 'site' && /^\s*reverse_proxy\s*$/m.test(b.text))
    return bad ? `Caddyfile:${bad.line} - Error during parsing: reverse_proxy: no upstreams` : undefined
  }
  async apiAdapt(content: string) {
    return this.check(content)
  }
  async apiLoad(content: string) {
    return this.check(content)
  }
  async containerRunning() {
    return true
  }
  async validateInImage() {
    return 'unavailable' as const
  }
  async validateOnHost() {
    return 'unavailable' as const
  }
  async execReload() {
    return undefined
  }
  async serviceReload() {
    return undefined
  }
}
