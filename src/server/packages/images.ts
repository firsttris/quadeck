// Container image updates via `podman auto-update` (containers with the
// io.containers.autoupdate label / AutoUpdate= in the Quadlet).

import type { ImageUpdate } from '~/shared/packages'
import { msg } from '~/shared/i18n'
import { run } from '../exec'
import { parseAutoUpdate } from './parse'

export async function imageUpdates(): Promise<ImageUpdate[]> {
  if (!Bun.which('podman')) throw new Error(msg('packages_podmanNotInstalled'))
  const r = await run(['podman', 'auto-update', '--dry-run', '--format', 'json'], { timeoutMs: 180_000 })
  if (r.code !== 0) throw new Error(`podman auto-update: ${(r.stderr || r.stdout).trim()}`)
  return parseAutoUpdate(r.stdout)
}
