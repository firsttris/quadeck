// `quadeck job <spec>`: executes one maintenance job as root. Started by the
// helper as a transient systemd unit (so it survives a restart of Quadeck
// itself, e.g. when the update replaces podman or systemd) or as a child
// process where systemd-run is not available. Output goes to stdout; the last
// line is the exit marker the helper waits for.

import { localize, msg } from '~/shared/i18n'
import { HttpError } from '../auth'
import { assertUnitName } from '../privileged/actions'
import { FEATURES, PACKAGE_NAME, PROTECTED_PACKAGES, type Feature, type JobSpec } from '~/shared/packages'
import { aurHelper, aurUser, runAurUpgrade } from './aur'
import { fileRootPaths } from '../files/backend'
import { fsJobSteps, prepareFsJob, systemFsOps } from '../files/transfer'
import { baseName, validatePath } from '~/shared/files'
import { imageUpdates } from './images'
import { detectProvider, type Step } from './providers'
import { release } from 'node:os'
import { SystemBackup } from '../backup/backend'
import { STOP_UNIT, SNAPSHOT_ID, absPathProblem } from '~/shared/backup'
import { isFlavor, kernelInfos, kernelRemoveProblem, parseBootctlList, parsePacmanQ } from '~/shared/boot'

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
    case 'mkinitcpio':
      return { kind: o.kind }
    case 'remove': {
      const names = Array.isArray(o.names) ? o.names : []
      if (!names.length || names.length > 200 || !names.every((n) => typeof n === 'string' && PACKAGE_NAME.test(n))) throw new HttpError(400, msg('api_packages_invalidNames'))
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
    case 'install': {
      if (typeof o.feature !== 'string' || !(o.feature in FEATURES)) throw new HttpError(400, msg('packages_error_unknownFeature'))
      return { kind: 'install', feature: o.feature as Feature }
    }
    case 'fs-copy':
    case 'fs-move':
    case 'fs-delete': {
      const paths = Array.isArray(o.paths) ? o.paths : []
      if (!paths.length || paths.length > 1000 || !paths.every((p) => typeof p === 'string' && !validatePath(p))) throw new HttpError(400, msg('packages_error_invalidPaths'))
      if (o.kind === 'fs-delete') return { kind: 'fs-delete', paths: paths as string[] }
      if (typeof o.toDir !== 'string' || validatePath(o.toDir)) throw new HttpError(400, msg('packages_error_invalidTarget'))
      return { kind: o.kind, paths: paths as string[], toDir: o.toDir, overwrite: o.overwrite === true }
    }
    case 'backup-restore': {
      const paths = Array.isArray(o.paths) ? o.paths : []
      const stop = Array.isArray(o.stop) ? o.stop : []
      if (typeof o.snapshot !== 'string' || !SNAPSHOT_ID.test(o.snapshot)) throw new HttpError(400, msg('backup_error_snapshot'))
      if (!paths.length || paths.length > 200 || paths.some((p) => absPathProblem(p))) throw new HttpError(400, msg('packages_error_invalidPaths'))
      if (o.target !== undefined && absPathProblem(o.target)) throw new HttpError(400, msg('packages_error_invalidTarget'))
      if (stop.length > 30 || !stop.every((u) => typeof u === 'string' && STOP_UNIT.test(u) && !u.startsWith('-'))) throw new HttpError(400, msg('backup_error_unit'))
      return { kind: 'backup-restore', snapshot: o.snapshot, paths: paths as string[], ...(o.target !== undefined ? { target: o.target as string } : {}), stop: stop as string[] }
    }
    case 'kernel-install':
    case 'kernel-remove':
      if (!isFlavor(o.flavor)) throw new HttpError(400, msg('boot_error_unknownKernel'))
      return { kind: o.kind, flavor: o.flavor }
    default:
      throw new HttpError(400, msg('packages_error_unknownJob'))
  }
}

export function jobTitle(spec: JobSpec): string {
  switch (spec.kind) {
    case 'upgrade':
      return msg('packages_job_systemUpdate')
    case 'aur-upgrade':
      return msg('packages_job_aurUpdate')
    case 'remove': {
      const names = `${spec.names.slice(0, 4).join(', ')}${spec.names.length > 4 ? ` +${spec.names.length - 4}` : ''}`
      return msg('packages_job_remove', { names })
    }
    case 'images-update':
      return msg('packages_job_updateImages')
    case 'image-update':
      return msg('packages_job_updateImage', { unit: spec.unit })
    case 'install': {
      const label = FEATURES[spec.feature].label
      return msg('packages_job_install', { label })
    }
    case 'mkinitcpio':
      return msg('packages_job_rebuildInitramfs')
    case 'kernel-install':
      return msg('packages_job_installKernel', { flavor: spec.flavor })
    case 'kernel-remove':
      return msg('packages_job_removeKernel', { flavor: spec.flavor })
    case 'backup-restore': {
      const what = spec.paths.length === 1 ? spec.paths[0]! : msg('common_items', { n: spec.paths.length })
      return spec.target ? msg('backup_job_restoreTo', { what, target: spec.target }) : msg('backup_job_restoreInPlace', { what })
    }
    case 'fs-copy':
    case 'fs-move':
    case 'fs-delete': {
      const one = spec.paths.length === 1 ? baseName(spec.paths[0]!) : undefined
      const what = one ?? msg('common_items', { n: spec.paths.length })
      if (spec.kind === 'fs-delete') return msg('packages_job_fsDelete', { what })
      return spec.kind === 'fs-copy' ? msg('packages_job_fsCopy', { what, toDir: spec.toDir }) : msg('packages_job_fsMove', { what, toDir: spec.toDir })
    }
  }
}

const out = (s: string) => process.stdout.write(s.endsWith('\n') ? s : s + '\n')

async function exec(argv: string[], env: Record<string, string> = {}): Promise<number> {
  out(`$ ${argv.join(' ')}`)
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', env: { ...process.env, LC_ALL: 'C.UTF-8', ...env } })
  return proc.exited
}

async function capture(argv: string[]) {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LC_ALL: 'C' } })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { stdout, code }
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
      if (!p) throw new Error(msg('system_page_noManager'))
      return steps(p.upgradeSteps())
    }
    case 'remove': {
      const p = detectProvider()
      if (!p) throw new Error(msg('system_page_noManager'))
      // Re-check here, where root acts: never take away a protected package.
      const preview = await p.removePreview(spec.names)
      if (preview.error) throw new Error(preview.error)
      const blocked = preview.packages.filter((x) => PROTECTED_PACKAGES[p.id].includes(x.name)).map((x) => x.name)
      if (blocked.length) throw new Error(msg('packages_error_protectedAffected', { list: blocked.join(', ') }))
      out(msg('packages_job_removing', { list: preview.packages.map((x) => x.name).join(' ') }))
      return steps(p.removeSteps(spec.names))
    }
    case 'aur-upgrade': {
      const helper = aurHelper()
      const user = aurUser()
      if (!helper) throw new Error(msg('packages_error_noAurHelper'))
      if (!user) throw new Error(msg('packages_error_noAurUser'))
      return runAurUpgrade(helper, user, exec, out)
    }
    case 'install': {
      const p = detectProvider()
      if (!p) throw new Error(msg('system_page_noManager'))
      return steps(p.installSteps(FEATURES[spec.feature].packages[p.id]))
    }
    case 'fs-copy':
    case 'fs-move':
    case 'fs-delete': {
      // Checked again here, where root acts.
      const prepared = prepareFsJob(spec, systemFsOps(fileRootPaths()))
      for (const argv of fsJobSteps(spec, prepared)) {
        const code = await exec(argv)
        if (code !== 0) return code
      }
      return 0
    }
    case 'mkinitcpio':
      if (!Bun.which('mkinitcpio')) throw new Error(msg('packages_error_mkinitcpioMissing'))
      return exec(['mkinitcpio', '-P'])
    case 'kernel-install': {
      if (detectProvider()?.id !== 'pacman') throw new Error(msg('packages_error_kernelArchOnly'))
      // DKMS modules (NVIDIA, ZFS …) are built for every kernel that has its headers.
      const pkgs = [spec.flavor, ...(Bun.which('dkms') ? [`${spec.flavor}-headers`] : [])]
      return exec(['pacman', '-S', '--needed', '--noconfirm', '--noprogressbar', '--color', 'never', '--', ...pkgs])
    }
    case 'kernel-remove': {
      if (detectProvider()?.id !== 'pacman') throw new Error(msg('packages_error_kernelArchOnly'))
      // Checked again here, where root acts: never the running, the default or the last kernel.
      const installed = parsePacmanQ((await capture(['pacman', '-Q', 'linux', 'linux-lts', 'linux-zen', 'linux-hardened', `${spec.flavor}-headers`])).stdout)
      const entries = Bun.which('bootctl') ? parseBootctlList((await capture(['bootctl', '--no-pager', 'list', '--json=short'])).stdout).map((e) => ({ ...e, missing: [] })) : []
      const kernels = kernelInfos(installed, release(), entries)
      const k = kernels.find((x) => x.pkg === spec.flavor)!
      if (!k.installed) throw new Error(msg('packages_error_kernelNotInstalled', { flavor: spec.flavor }))
      const problem = kernelRemoveProblem(k, kernels)
      if (problem) throw new Error(`${spec.flavor}: ${problem}`)
      return exec(['pacman', '-Rns', '--noconfirm', '--noprogressbar', '--color', 'never', '--', spec.flavor, ...(installed.has(`${spec.flavor}-headers`) ? [`${spec.flavor}-headers`] : [])])
    }
    case 'backup-restore':
      return new SystemBackup({ log: out }).restore(spec)
    case 'images-update':
      // Rolls back to the previous image if the restarted unit fails.
      return exec(['podman', 'auto-update', '--rollback=true'])
    case 'image-update': {
      const item = (await imageUpdates()).find((i) => i.unit === spec.unit)
      if (!item) throw new Error(msg('packages_error_notAutoUpdate', { unit: spec.unit }))
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
    if (process.getuid?.() !== 0) throw new Error(msg('packages_error_jobNeedsRoot'))
    code = await execute(decodeSpec(encoded ?? ''))
  } catch (e) {
    out(msg('packages_job_error', { message: (e as Error).message }))
    code = 1
  }
  out(`${EXIT_MARKER}${code}`)
  return code
}
