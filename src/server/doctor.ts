// `quadeck doctor`: what Quadeck finds on this machine (distribution, package manager, init system,
// Podman/Quadlets, coreutils, boot loader) and what that means for its features. Run by hand when
// something is missing, and by CI in containers of each distribution.

import { existsSync, readFileSync } from 'node:fs'
import { parseOsRelease } from './collectors/system'
import { run } from './exec'
import { gnuCoreutils } from './files/transfer'
import { detectProvider } from './packages/providers'
import { isMusl } from './update'

/** Quadlets came with Podman 4.4. */
export const QUADLET_MIN = [4, 4] as const

/** "podman version 5.2.1" → [5, 2, 1]. */
export function parsePodmanVersion(out: string): number[] | undefined {
  const v = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(out)
  return v ? [Number(v[1]), Number(v[2]), Number(v[3] ?? 0)] : undefined
}

export const quadletSupport = (v: number[]) => v[0]! > QUADLET_MIN[0] || (v[0] === QUADLET_MIN[0] && v[1]! >= QUADLET_MIN[1])

/** ID and ID_LIKE of /etc/os-release, e.g. ["opensuse-tumbleweed", "opensuse", "suse"]. */
export function osIds(text: string): string[] {
  const get = (k: string) => new RegExp(`^${k}="?([^"\\n]*)"?`, 'm').exec(text)?.[1] ?? ''
  return [get('ID'), ...get('ID_LIKE').split(/\s+/)].filter(Boolean)
}

export interface DoctorReport {
  os: string
  osIds: string[]
  arch: string
  libc: 'glibc' | 'musl'
  packageManager: string | null
  init: 'systemd' | 'other'
  podman: string | null
  quadlets: boolean
  coreutils: 'gnu' | 'busybox'
  bootLoader: 'systemd-boot' | 'other'
  root: boolean
}

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

export async function doctorReport(): Promise<DoctorReport> {
  const osText = read('/etc/os-release') || read('/usr/lib/os-release')
  const podman = Bun.which('podman') ? await run(['podman', '--version']).catch(() => undefined) : undefined
  const pv = podman?.code === 0 ? parsePodmanVersion(podman.stdout) : undefined
  const boot = Bun.which('bootctl') ? await run(['bootctl', '--no-pager', 'is-installed']).catch(() => undefined) : undefined
  return {
    os: parseOsRelease(osText),
    osIds: osIds(osText),
    arch: process.arch,
    libc: isMusl() ? 'musl' : 'glibc',
    packageManager: detectProvider()?.id ?? null,
    init: existsSync('/run/systemd/system') ? 'systemd' : 'other',
    podman: pv ? pv.join('.') : null,
    quadlets: !!pv && quadletSupport(pv),
    coreutils: gnuCoreutils() ? 'gnu' : 'busybox',
    bootLoader: boot?.code === 0 ? 'systemd-boot' : 'other',
    root: process.getuid?.() === 0,
  }
}

/** Human-readable lines, with what each finding means. */
export function formatReport(r: DoctorReport): string {
  const row = (k: string, v: string, note?: string) => `${(k + ':').padEnd(17)}${v}${note ? `  – ${note}` : ''}`
  return [
    row('System', r.os),
    row('Architecture', `${r.arch} (${r.libc})`),
    row('Package manager', r.packageManager ?? 'none', r.packageManager ? undefined : 'package pages hidden'),
    row('Init', r.init, r.init === 'systemd' ? undefined : 'services, timers, journal and Quadlets hidden'),
    row('Podman', r.podman ?? 'not installed', !r.podman ? 'container pages hidden' : r.quadlets ? 'Quadlets supported' : `Quadlets need Podman ${QUADLET_MIN.join('.')} or newer`),
    row('Coreutils', r.coreutils, r.coreutils === 'gnu' ? undefined : 'file explorer copies without reflink'),
    row('Boot loader', r.bootLoader, r.bootLoader === 'systemd-boot' ? undefined : 'boot entries need systemd-boot (reboot and kernel parameters work)'),
  ].join('\n')
}

/** `--expect key=value` checks for CI; returns the mismatches. */
export function checkExpectations(r: DoctorReport, expects: string[]): string[] {
  return expects.flatMap((e) => {
    const [k, v] = e.split('=', 2) as [keyof DoctorReport, string | undefined]
    if (!(k in r) || v === undefined) return [`unknown expectation: ${e}`]
    const actual = r[k]
    const ok = Array.isArray(actual) ? actual.includes(v) : String(actual) === v
    return ok ? [] : [`${k}: expected ${v}, found ${Array.isArray(actual) ? actual.join(' ') : String(actual)}`]
  })
}
