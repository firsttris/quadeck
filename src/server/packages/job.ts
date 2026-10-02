// `quadeck job <spec>`: executes one maintenance job as root. Started by the
// helper as a transient systemd unit (so it survives a restart of Quadeck
// itself, e.g. when the update replaces podman or systemd) or as a child
// process where systemd-run is not available. Output goes to stdout; the last
// line is the exit marker the helper waits for.

import { HttpError } from '../auth'
import { assertUnitName } from '../privileged/actions'
import { PACKAGE_NAME, PROTECTED_PACKAGES, type JobSpec } from '~/shared/packages'
import { aurHelper, aurUser, runAurUpgrade } from './aur'
import { imageUpdates } from './images'
import { detectProvider, type Step } from './providers'

export const EXIT_MARKER = '::quadeck-exit '

export function encodeSpec(spec: JobSpec) {
  return Buffer.from(JSON.stringify(spec)).toString('base64url')
}

export function decodeSpec(s: string): JobSpec {
  return parseJobSpec(JSON.parse(Buffer.from(s, 'base64url').toString('utf8')))
}

/** Validates a job spec from outside (web app → helper → job). */
export function parseJobSpec(v: unknown): JobSpec {
  const o = (v ?? {}) as Record<string, unknown>
  switch (o.kind) {
    case 'upgrade':
    case 'aur-upgrade':
    case 'images-update':
      return { kind: o.kind }
    case 'remove': {
      const names = Array.isArray(o.names) ? o.names : []
      if (!names.length || names.length > 200 || !names.every((n) => typeof n === 'string' && PACKAGE_NAME.test(n))) throw new HttpError(400, 'Ungültige Paketnamen')
      return { kind: 'remove', names: [...new Set(names as string[])] }
    }
    case 'image-update': {
      const unit = typeof o.unit === 'string' ? o.unit : ''
      try {
        assertUnitName(unit)
      } catch (e) {
        throw new HttpError(400, (e as Error).message)
      }
      return { kind: 'image-update', unit }
    }
    default:
      throw new HttpError(400, 'Unbekannter Job')
  }
}

export function jobTitle(spec: JobSpec): string {
  switch (spec.kind) {
    case 'upgrade':
      return 'Systemupdate'
    case 'aur-upgrade':
      return 'AUR-Update'
    case 'remove':
      return `Entfernen: ${spec.names.slice(0, 4).join(', ')}${spec.names.length > 4 ? ` +${spec.names.length - 4}` : ''}`
    case 'images-update':
      return 'Container-Images aktualisieren'
    case 'image-update':
      return `Image aktualisieren: ${spec.unit}`
  }
}

const out = (s: string) => process.stdout.write(s.endsWith('\n') ? s : s + '\n')

async function exec(argv: string[], env: Record<string, string> = {}): Promise<number> {
  out(`$ ${argv.join(' ')}`)
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', env: { ...process.env, LC_ALL: 'C.UTF-8', ...env } })
  return proc.exited
}

async function steps(list: Step[]) {
  for (const s of list) {
    const code = await exec(s.argv, s.env)
    if (code !== 0) return code
  }
  return 0
}

async function execute(spec: JobSpec): Promise<number> {
  switch (spec.kind) {
    case 'upgrade': {
      const p = detectProvider()
      if (!p) throw new Error('Kein unterstützter Paketmanager gefunden')
      return steps(p.upgradeSteps())
    }
    case 'remove': {
      const p = detectProvider()
      if (!p) throw new Error('Kein unterstützter Paketmanager gefunden')
      // Re-check here, where root acts: never take away a protected package.
      const preview = await p.removePreview(spec.names)
      if (preview.error) throw new Error(preview.error)
      const blocked = preview.packages.filter((x) => PROTECTED_PACKAGES[p.id].includes(x.name)).map((x) => x.name)
      if (blocked.length) throw new Error(`Geschützte Pakete wären betroffen: ${blocked.join(', ')}`)
      out(`Wird entfernt: ${preview.packages.map((x) => x.name).join(' ')}`)
      return steps(p.removeSteps(spec.names))
    }
    case 'aur-upgrade': {
      const helper = aurHelper()
      const user = aurUser()
      if (!helper) throw new Error('Weder yay noch paru ist installiert')
      if (!user) throw new Error('Kein Benutzer für AUR-Updates (QUADECK_AUR_USER setzen)')
      return runAurUpgrade(helper, user, exec, out)
    }
    case 'images-update':
      // Rolls back to the previous image if the restarted unit fails.
      return exec(['podman', 'auto-update', '--rollback=true'])
    case 'image-update': {
      const item = (await imageUpdates()).find((i) => i.unit === spec.unit)
      if (!item) throw new Error(`${spec.unit} ist nicht für Auto-Update markiert`)
      const pulled = await exec(['podman', 'pull', '--', item.image])
      if (pulled !== 0) return pulled
      return exec(['systemctl', 'restart', '--', spec.unit])
    }
  }
}

export async function runJobCommand(encoded: string | undefined): Promise<number> {
  process.umask(0o022) // installed files must stay readable for everyone
  let code = 1
  try {
    if (process.getuid?.() !== 0) throw new Error('quadeck job muss als root laufen')
    code = await execute(decodeSpec(encoded ?? ''))
  } catch (e) {
    out(`Fehler: ${(e as Error).message}`)
    code = 1
  }
  out(`${EXIT_MARKER}${code}`)
  return code
}
