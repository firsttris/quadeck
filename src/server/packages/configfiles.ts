// .pacnew & co.: show both versions, then keep yours, take over the new one or
// save a merge. Only files of the current list are touched; passwd, shadow,
// fstab … never get the package version. sshd_config and smb.conf are checked
// with sshd -t / testparm before they are written; the previous file stays as
// <file>.quadeck-bak.

import { chmodSync, chownSync, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpError } from '../auth'
import { run } from '../exec'
import { describeConfigFile, parseConfigPath, replaceRisk, type ConfigAction, type ConfigFileInfo } from '~/shared/configfiles'

const MAX = 512 * 1024

export interface ConfigFs {
  /** The current list (from the scan of /etc). */
  list(): Promise<string[]>
  read(path: string): string | undefined
  exists(path: string): boolean
  /** Atomic, keeps owner and mode of an existing file; the previous content goes to <path>.quadeck-bak. */
  write(path: string, content: string): void
  remove(path: string): void
  /** Error text, or undefined. */
  check(kind: string, content: string): Promise<string | undefined>
  after(what: NonNullable<ConfigFileInfo['after']>): Promise<string | undefined>
}

const isBinary = (s: string) => s.includes('\u0000')

export async function configFileInfo(fs: ConfigFs, path: string): Promise<ConfigFileInfo> {
  if (!(await fs.list()).includes(path)) throw new HttpError(404, `${path} steht nicht (mehr) in der Liste`)
  const parsed = parseConfigPath(path)
  if (!parsed) throw new HttpError(400, 'Keine Konfigurationsdatei eines Pakets')
  const content = fs.read(path)
  const liveContent = fs.read(parsed.live)
  const binary = (content !== undefined && (content.length > MAX || isBinary(content))) || (liveContent !== undefined && (liveContent.length > MAX || isBinary(liveContent)))
  return {
    path,
    ...parsed,
    liveExists: fs.exists(parsed.live),
    content: binary ? undefined : content,
    liveContent: binary ? undefined : liveContent,
    binary: binary || undefined,
    replaceRisk: binary || parsed.kind === 'save' ? undefined : replaceRisk(parsed.live, liveContent, content),
    ...describeConfigFile(path, parsed.kind, parsed.live),
  }
}

export async function applyConfigAction(fs: ConfigFs, path: string, action: ConfigAction, merged?: string): Promise<{ done: string; after?: ConfigFileInfo['after']; warning?: string }> {
  const f = await configFileInfo(fs, path)
  if (action === 'keep') {
    fs.remove(path)
    return { done: f.kind === 'save' ? `${path} gelöscht` : `${f.live} bleibt, ${path} gelöscht` }
  }
  if (f.kind === 'save') throw new HttpError(409, 'Gesicherte Fassungen werden nur gelöscht – zum Übernehmen den Inhalt bearbeiten und von Hand speichern')
  if (f.noReplace) throw new HttpError(403, f.noReplace)
  if (f.binary) throw new HttpError(409, 'Keine Textdatei – hier nur behalten oder löschen')
  if (action === 'replace' && f.replaceRisk) throw new HttpError(409, f.replaceRisk)
  const text = action === 'replace' ? f.content! : merged
  if (text === undefined || text.length > MAX || isBinary(text)) throw new HttpError(400, 'Ungültiger Inhalt')
  if (f.check) {
    const err = await fs.check(f.check, text)
    if (err) throw new HttpError(422, `${f.check} lehnt die Datei ab – nichts geändert: ${err}`)
  }
  fs.write(f.live, text.endsWith('\n') ? text : text + '\n')
  fs.remove(path)
  // Fast follow-ups right away; mkinitcpio takes a while and runs as a job from the page.
  let warning: string | undefined
  if (f.after && f.after !== 'mkinitcpio') warning = await fs.after(f.after)
  return { done: action === 'replace' ? `${f.live} durch die neue Fassung ersetzt` : `${f.live} gespeichert`, after: f.after, warning }
}

export class SystemConfigFs implements ConfigFs {
  constructor(private listFn: () => string[]) {}

  async list() {
    return this.listFn()
  }

  read(path: string) {
    try {
      if (lstatSync(path).isSymbolicLink()) return undefined
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  }

  exists(path: string) {
    return existsSync(path)
  }

  write(path: string, content: string) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new HttpError(409, `${path} ist ein Symlink und wird nicht überschrieben`)
    const st = existsSync(path) ? statSync(path) : undefined
    if (st) copyFileSync(path, `${path}.quadeck-bak`)
    const tmp = `${path}.quadeck-tmp`
    writeFileSync(tmp, content, { mode: st ? st.mode & 0o7777 : 0o644 })
    if (st) {
      chownSync(tmp, st.uid, st.gid)
      chmodSync(tmp, st.mode & 0o7777)
    }
    renameSync(tmp, path)
  }

  remove(path: string) {
    rmSync(path, { force: true })
  }

  async check(kind: string, content: string) {
    const dir = mkdtempSync(join(tmpdir(), 'quadeck-conf-'))
    try {
      const file = join(dir, 'candidate')
      writeFileSync(file, content, { mode: 0o600 })
      if (kind === 'sshd -t') {
        const sshd = ['/usr/sbin/sshd', '/usr/bin/sshd', '/sbin/sshd'].find((p) => existsSync(p))
        if (!sshd) return undefined
        const r = await run([sshd, '-t', '-f', file], { timeoutMs: 15_000 })
        return r.code === 0 ? undefined : (r.stderr || r.stdout).trim().replace(file, 'sshd_config')
      }
      if (kind === 'testparm') {
        if (!Bun.which('testparm')) return undefined
        const r = await run(['testparm', '-s', file], { timeoutMs: 15_000 })
        return r.code === 0 ? undefined : (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')
      }
      return undefined
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async after(what: NonNullable<ConfigFileInfo['after']>) {
    const argv =
      what === 'sshd-reload' ? ['systemctl', 'try-reload-or-restart', 'sshd.service', 'ssh.service'] : what === 'smb-reload' ? ['smbcontrol', 'smbd', 'reload-config'] : what === 'locale-gen' ? ['locale-gen'] : undefined
    if (!argv || !Bun.which(argv[0]!)) return undefined
    const r = await run(argv, { timeoutMs: 120_000 })
    return r.code === 0 ? undefined : `Gespeichert, aber ${argv.join(' ')} meldet: ${(r.stderr || r.stdout).trim().slice(0, 200)}`
  }
}

/** Demo: the files live in memory. */
export class FixtureConfigFs implements ConfigFs {
  constructor(
    private files: Record<string, string>,
    private listRef: { configFiles: string[] },
  ) {}
  async list() {
    return this.listRef.configFiles
  }
  read(path: string) {
    return this.files[path]
  }
  exists(path: string) {
    return path in this.files
  }
  write(path: string, content: string) {
    if (path in this.files) this.files[`${path}.quadeck-bak`] = this.files[path]!
    this.files[path] = content
  }
  remove(path: string) {
    delete this.files[path]
    this.listRef.configFiles = this.listRef.configFiles.filter((p) => p !== path)
  }
  async check(kind: string, content: string) {
    if (kind === 'sshd -t' && /^\s*Port\s+(?!\d+\s*$)/m.test(content)) return 'Bad port number'
    return undefined
  }
  async after() {
    return undefined
  }
}
