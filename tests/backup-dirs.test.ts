import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dirsWithVolumes, listDirs, systemDirFs, treeDirFs } from '~/server/backup/dirs'

const tree = treeDirFs(['/home/tristan/docker/immich/library', '/home/tristan/.config', '/etc', '/mnt/backup/old', '/mnt/media/movies', '/proc/1', '/srv/b2', '/srv/a10', '/srv/a9'], {
  '/': { size: 500, free: 200 },
  '/mnt/backup': { size: 4000, free: 2600 },
  '/mnt/media': { size: 8000, free: 1100 },
})

describe('folder browser', () => {
  it('lists sub-folders sorted, hidden ones last, kernel views left out at the root', () => {
    expect(listDirs(tree, '/').dirs).toEqual(['etc', 'home', 'mnt', 'srv'])
    expect(listDirs(tree, '/home/tristan').dirs).toEqual(['docker', '.config'])
    expect(listDirs(tree, '/srv').dirs).toEqual(['a9', 'a10', 'b2'])
  })

  it('a folder that does not exist shows its closest existing parent', () => {
    const l = listDirs(tree, '/mnt/backup/restic/server')
    expect(l).toMatchObject({ path: '/mnt/backup', missing: true, dirs: ['old'] })
    expect(listDirs(tree, '/mnt/backup').missing).toBeUndefined()
  })

  it('the disk: its mount point and space, and which compared paths are on it', () => {
    const l = listDirs(tree, '/mnt/backup/restic', ['/home/tristan/docker/immich/library', '/mnt/backup/old', '/mnt/media/movies', '/mnt/backup/not/there', 'relative', '/etc/'])
    expect(l.disk).toEqual({ mount: '/mnt/backup', size: 4000, free: 2600 })
    expect(l.sameDisk).toEqual(['/mnt/backup/old', '/mnt/backup/not/there'])
    const root = listDirs(tree, '/srv', ['/home/tristan/docker/immich/library', '/mnt/media/movies'])
    expect(root.disk).toEqual({ mount: '/', size: 500, free: 200 })
    expect(root.sameDisk).toEqual(['/home/tristan/docker/immich/library'])
  })

  it('refuses paths that are not absolute and normalized', () => {
    for (const bad of ['', 'etc', '/etc/', '/a/../b', '/a//b', '/a\nb']) expect(() => listDirs(tree, bad), JSON.stringify(bad)).toThrow()
  })

  it('volumes are compared by their folder on the host', async () => {
    const l = await dirsWithVolumes(tree, '/mnt/backup', ['volume:db', 'volume:gone', '/etc'], async (c) => (c === 'volume:db' ? '/mnt/backup/old' : c === 'volume:gone' ? undefined : c))
    expect(l.sameDisk).toEqual(['volume:db'])
  })

  it('the real file system: folders and symlinks to folders, no files, a missing folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qd-dirs-'))
    mkdirSync(join(dir, 'b'))
    mkdirSync(join(dir, 'a'))
    mkdirSync(join(dir, '.hidden'))
    writeFileSync(join(dir, 'file.txt'), 'x')
    symlinkSync(join(dir, 'a'), join(dir, 'link-to-a'))
    symlinkSync(join(dir, 'file.txt'), join(dir, 'link-to-file'))
    const l = listDirs(systemDirFs, dir, [join(dir, 'a'), '/proc'])
    expect(l.dirs).toEqual(['a', 'b', 'link-to-a', '.hidden'])
    expect(l.sameDisk).toContain(join(dir, 'a'))
    expect(l.disk!.size).toBeGreaterThan(0)
    expect(listDirs(systemDirFs, join(dir, 'new', 'deeper'))).toMatchObject({ path: dir, missing: true })
  })
})
