import { describe, expect, it } from 'vitest'
import type { JobSink, Launcher } from '~/server/packages/jobs'
import { imagesAfterJob, single, SystemMaintenance } from '~/server/packages/maintenance'
import type { ImageUpdatesReport } from '~/shared/packages'

const report = (): ImageUpdatesReport => ({
  checkedAt: Date.now(),
  items: [
    { unit: 'jellyfin.service', container: 'jellyfin', image: 'docker.io/jellyfin/jellyfin:latest', policy: 'registry', updated: 'pending' },
    { unit: 'immich.service', container: 'immich', image: 'ghcr.io/immich-app/immich-server:release', policy: 'registry', updated: 'pending' },
  ],
})

describe('image list after an image job', () => {
  it('a single image that was updated is current at once, the others stay pending', () => {
    const before = report()
    const after = imagesAfterJob(before, { spec: { kind: 'image-update', unit: 'jellyfin.service' }, status: 'ok' })!
    expect(after.items.map((i) => [i.unit, i.updated])).toEqual([
      ['jellyfin.service', 'false'],
      ['immich.service', 'pending'],
    ])
    expect(after.checkedAt).toBe(before.checkedAt)
    expect(before.items[0]!.updated).toBe('pending') // not changed in place
  })

  it('everything else is checked again: a failed job, all images (may roll back), an unknown unit, no list, a list with an error', () => {
    const one = { kind: 'image-update', unit: 'jellyfin.service' } as const
    expect(imagesAfterJob(report(), { spec: one, status: 'failed' })).toBeUndefined()
    expect(imagesAfterJob(report(), { spec: { kind: 'images-update' }, status: 'ok' })).toBeUndefined()
    expect(imagesAfterJob(report(), { spec: { kind: 'image-update', unit: 'gone.service' }, status: 'ok' })).toBeUndefined()
    expect(imagesAfterJob(undefined, { spec: one, status: 'ok' })).toBeUndefined()
    expect(imagesAfterJob({ ...report(), error: 'podman: timeout' }, { spec: one, status: 'ok' })).toBeUndefined()
  })
})

describe('one refresh at a time', () => {
  it('callers share a run of the same generation; after a job ended a new run starts', async () => {
    let gen = 0
    let runs = 0
    const pending: ((v: number) => void)[] = []
    const refresh = single(
      () =>
        new Promise<number>((resolve) => {
          runs++
          pending.push(resolve)
        }),
      () => gen,
    )
    const a = refresh()
    const b = refresh()
    expect(a).toBe(b)
    expect(runs).toBe(1)
    gen++ // a job ended while the first check was still running
    const c = refresh()
    expect(c).not.toBe(a)
    expect(runs).toBe(2)
    pending[0]!(1) // the old run ends: it must not drop the newer one
    await a
    expect(refresh()).toBe(c)
    pending[1]!(2)
    expect(await c).toBe(2)
    await Promise.resolve()
    refresh()
    expect(runs).toBe(3) // done: the next call checks again
  })
})

describe('SystemMaintenance after a single image update', () => {
  it('the list it returns right after the job shows the image as current, without a new registry check', async () => {
    let sink: JobSink | undefined
    const launcher: Launcher = {
      start: async (_id, _spec, s) => {
        sink = s
      },
    }
    const maint = new SystemMaintenance(launcher)
    const cached = report()
    ;(maint as unknown as { imagesCache: ImageUpdatesReport }).imagesCache = cached
    expect((await maint.imageUpdates(false)).items[0]!.updated).toBe('pending')
    await maint.startJob({ kind: 'image-update', unit: 'jellyfin.service' })
    sink!.exit(0)
    const after = await maint.imageUpdates(false)
    expect(after.items.map((i) => i.updated)).toEqual(['false', 'pending'])
    expect(after.checkedAt).toBe(cached.checkedAt)
  })
})
