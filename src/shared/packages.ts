// Types shared by the package/update views and the server side
// (web app, root helper and the `quadeck job` runner).

import type { KernelFlavor } from './boot'
import type { PackFormat } from './archives'
import { msg } from './i18n'

export type ManagerId = 'pacman' | 'apt' | 'dnf' | 'zypper' | 'apk' | 'rpm-ostree' | 'transactional-update'

export interface InstalledPackage {
  name: string
  version: string
  description?: string
  /** Installed size in bytes (if the manager reports it). */
  size?: number
  /** explicit = installed on purpose, dependency = pulled in; undefined = unknown. */
  reason?: 'explicit' | 'dependency'
  /** Not from a configured repository (AUR, manually installed .deb/.rpm). */
  foreign?: boolean
  /** Dependency nothing needs any more. */
  orphan?: boolean
}

export interface PackageDetail extends InstalledPackage {
  url?: string
  installedAt?: number
  depends: string[]
  requiredBy: string[]
  optionalFor?: string[]
  protected: boolean
}

export interface PackageUpdate {
  name: string
  from: string
  to: string
  /** Repository (core, extra, aur, updates, …). */
  repo?: string
  downloadSize?: number
}

export interface AurInfo {
  /** yay or paru, if installed. */
  helper?: 'yay' | 'paru'
  /** User the helper runs as (QUADECK_AUR_USER or the first admin user). */
  user?: string
}

export interface PackageOverview {
  manager: ManagerId | null
  label: string
  /** Packages can be removed (not on rpm-ostree). */
  canRemove: boolean
  aur?: AurInfo
  rebootRequired: boolean
  rebootReason?: string
  /** Config files the package manager left next to the live ones (.pacnew, .rpmnew, .dpkg-dist). */
  configFiles: string[]
  configHint?: string
  /** Last full system upgrade (from the package manager's log). */
  lastUpgrade?: number
  protected: string[]
}

export interface UpdatesReport {
  checkedAt: number
  repo: PackageUpdate[]
  aur: PackageUpdate[]
  error?: string
  aurError?: string
}

export interface RemovePreview {
  /** Everything the removal takes away (requested + no longer needed dependencies). */
  packages: { name: string; version?: string }[]
  /** Protected packages that would be removed – removal is refused. */
  blocked: string[]
  /** Manager output when it refuses (e.g. still required by …). */
  error?: string
}

export interface ImageUpdate {
  unit: string
  container: string
  image: string
  policy: string
  /** pending = new image available, false = up to date, … (podman auto-update). */
  updated: string
}

export interface ImageUpdatesReport {
  checkedAt: number
  items: ImageUpdate[]
  error?: string
}

export type JobSpec =
  | { kind: 'upgrade' }
  | { kind: 'aur-upgrade' }
  | { kind: 'remove'; names: string[] }
  | { kind: 'images-update' }
  | { kind: 'image-update'; unit: string }
  | { kind: 'install'; feature: Feature }
  | { kind: 'fs-copy'; paths: string[]; toDir: string; overwrite: boolean }
  | { kind: 'fs-move'; paths: string[]; toDir: string; overwrite: boolean }
  | { kind: 'fs-delete'; paths: string[] }
  | { kind: 'fs-extract'; archive: string; toDir: string; overwrite: boolean }
  | { kind: 'fs-pack'; paths: string[]; format: PackFormat; name: string }
  | { kind: 'kernel-install'; flavor: KernelFlavor }
  | { kind: 'kernel-remove'; flavor: KernelFlavor }
  | { kind: 'mkinitcpio' }
  | { kind: 'backup-restore'; snapshot: string; paths: string[]; target?: string; stop: string[] }

export type JobStatus = 'running' | 'ok' | 'failed'

export interface JobInfo {
  id: string
  spec: JobSpec
  title: string
  status: JobStatus
  startedAt: number
  endedAt?: number
  exitCode?: number
}

export interface JobState extends JobInfo {
  /** Output lines starting at `from`. */
  lines: string[]
  from: number
  total: number
}

export interface NewsItem {
  title: string
  link: string
  date: number
}

/**
 * Packages whose removal would break the system (or Quadeck itself). Removal
 * is refused when they are among the packages a removal takes away.
 */
export const PROTECTED_PACKAGES: Record<ManagerId, string[]> = {
  pacman: [
    'base',
    'linux',
    'linux-lts',
    'linux-zen',
    'linux-hardened',
    'linux-firmware',
    'systemd',
    'glibc',
    'pacman',
    'bash',
    'coreutils',
    'filesystem',
    'util-linux',
    'shadow',
    'pam',
    'sudo',
    'openssh',
    'podman',
    'iproute2',
    'grub',
    'mkinitcpio',
    'archlinux-keyring',
    'ca-certificates',
  ],
  apt: [
    'apt',
    'dpkg',
    'libc6',
    'systemd',
    'systemd-sysv',
    'bash',
    'coreutils',
    'base-files',
    'base-passwd',
    'login',
    'passwd',
    'util-linux',
    'sudo',
    'openssh-server',
    'podman',
    'iproute2',
    'grub-common',
    'linux-image-generic',
    'ca-certificates',
    'init',
  ],
  dnf: ['dnf', 'dnf5', 'rpm', 'glibc', 'systemd', 'bash', 'coreutils', 'filesystem', 'setup', 'shadow-utils', 'util-linux', 'sudo', 'openssh-server', 'podman', 'iproute', 'kernel', 'kernel-core', 'grub2-common', 'ca-certificates'],
  zypper: ['zypper', 'rpm', 'glibc', 'systemd', 'bash', 'coreutils', 'filesystem', 'shadow', 'util-linux', 'sudo', 'openssh-server', 'podman', 'iproute2', 'kernel-default', 'grub2', 'ca-certificates'],
  apk: ['apk-tools', 'alpine-base', 'busybox', 'musl', 'openrc', 'openssh', 'podman', 'sudo', 'ca-certificates', 'linux-lts'],
  'rpm-ostree': [],
  'transactional-update': ['zypper', 'rpm', 'glibc', 'systemd', 'bash', 'coreutils', 'filesystem', 'shadow', 'util-linux', 'sudo', 'openssh-server', 'podman', 'iproute2', 'kernel-default', 'ca-certificates', 'transactional-update', 'tukit'],
}

export const PACKAGE_NAME = /^[A-Za-z0-9@_+][A-Za-z0-9@._+:-]{0,127}$/

/** Updates that usually need a reboot to take effect. */
export const REBOOT_PACKAGES = /^(linux(-lts|-zen|-hardened)?|linux-image-.*|kernel(-core|-default)?|systemd|glibc|libc6|musl|linux-firmware|intel-ucode|amd-ucode|nvidia.*)$/

/**
 * Tools Quadeck pages need, installable with one click. Only these – never
 * arbitrary package names from the browser.
 */
export type Feature = 'smart' | 'samba' | 'nfs' | 'ssh' | 'restic' | 'hdparm' | 'zip'

/** `label` is a getter: read in the viewer's language. */
export const FEATURES: Record<Feature, { label: string; packages: Record<ManagerId, string[]>; service?: Record<ManagerId, string> }> = {
  smart: {
    get label() {
      return msg('packages_feature_smartmontools')
    },
    packages: { pacman: ['smartmontools'], apt: ['smartmontools'], dnf: ['smartmontools'], zypper: ['smartmontools'], apk: ['smartmontools'], 'rpm-ostree': ['smartmontools'], 'transactional-update': ['smartmontools'] },
  },
  samba: {
    get label() {
      return msg('packages_feature_samba')
    },
    packages: { pacman: ['samba'], apt: ['samba'], dnf: ['samba'], zypper: ['samba'], apk: ['samba'], 'rpm-ostree': ['samba'], 'transactional-update': ['samba'] },
  },
  nfs: {
    get label() {
      return msg('packages_feature_nfs')
    },
    packages: { pacman: ['nfs-utils'], apt: ['nfs-kernel-server'], dnf: ['nfs-utils'], zypper: ['nfs-kernel-server'], apk: ['nfs-utils'], 'rpm-ostree': ['nfs-utils'], 'transactional-update': ['nfs-kernel-server'] },
  },
  ssh: {
    get label() {
      return msg('packages_feature_openssh')
    },
    packages: { pacman: ['openssh'], apt: ['openssh-server'], dnf: ['openssh-server'], zypper: ['openssh-server'], apk: ['openssh'], 'rpm-ostree': ['openssh-server'], 'transactional-update': ['openssh-server'] },
  },
  hdparm: {
    label: 'hdparm',
    packages: { pacman: ['hdparm'], apt: ['hdparm'], dnf: ['hdparm'], zypper: ['hdparm'], apk: ['hdparm'], 'rpm-ostree': ['hdparm'], 'transactional-update': ['hdparm'] },
  },
  zip: {
    label: 'zip / unzip',
    packages: { pacman: ['zip', 'unzip'], apt: ['zip', 'unzip'], dnf: ['zip', 'unzip'], zypper: ['zip', 'unzip'], apk: ['zip', 'unzip'], 'rpm-ostree': ['zip', 'unzip'], 'transactional-update': ['zip', 'unzip'] },
  },
  restic: {
    label: 'restic',
    packages: { pacman: ['restic'], apt: ['restic'], dnf: ['restic'], zypper: ['restic'], apk: ['restic'], 'rpm-ostree': ['restic'], 'transactional-update': ['restic'] },
  },
}

/** The command to run by hand, for the hint next to the button. */
export function installCommand(manager: ManagerId, feature: Feature): string {
  const pkgs = FEATURES[feature].packages[manager].join(' ')
  switch (manager) {
    case 'pacman':
      return `sudo pacman -S --needed ${pkgs}`
    case 'apt':
      return `sudo apt install ${pkgs}`
    case 'dnf':
      return `sudo dnf install ${pkgs}`
    case 'zypper':
      return `sudo zypper install ${pkgs}`
    case 'apk':
      return `doas apk add ${pkgs}`
    case 'rpm-ostree':
      return `sudo rpm-ostree install ${pkgs} && sudo systemctl reboot`
    case 'transactional-update':
      return `sudo transactional-update pkg install ${pkgs} && sudo systemctl reboot`
  }
}
