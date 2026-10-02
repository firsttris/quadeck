// Container image updates via `podman auto-update` (containers with the
// io.containers.autoupdate label / AutoUpdate= in the Quadlet).

import type { ImageUpdate } from '~/shared/packages'
import { tr } from '~/shared/i18n'
import { run } from '../exec'
import { parseAutoUpdate } from './parse'

export async function imageUpdates(): Promise<ImageUpdate[]> {
  if (!Bun.which('podman')) throw new Error(tr('podman ist nicht installiert', 'podman is not installed'))
  const r = await run(['podman', 'auto-update', '--dry-run', '--format', 'json'], { timeoutMs: 180_000 })
  if (r.code !== 0) throw new Error(`podman auto-update: ${(r.stderr || r.stdout).trim()}`)
  return parseAutoUpdate(r.stdout)
}
