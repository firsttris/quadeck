import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FixtureFiles, fileRootPaths, resolveInRoots, SystemFiles } from '~/server/files/backend'
import { fsJobSteps, prepareFsJob, systemFsOps } from '~/server/files/transfer'
import { encodeSpec, parseJobSpec, runJobCommand } from '~/server/packages/job'
import { validateName, validatePath } from '~/shared/files'

function tree() {
  const base = mkdtempSync(join(tmpdir(), 'qd-files-'))
  const root = join(base, 'data')
  mkdirSync(join(root, 'Filme', 'Alt'), { recursive: true })
  mkdirSync(join(root, 'Backup'))
  writeFileSync(join(root, 'Filme', 'a.mkv'), 'film a')
  writeFileSync(join(root, 'Filme', 'b.mkv'), 'film b')
  writeFileSync(join(root, 'Backup', 'a.mkv'), 'old a')
  mkdirSync(join(base, 'secret'))
  writeFileSync(join(base, 'secret', 'key'), 'x')
  // A link pointing out of the root must not be a way out.
  symlinkSync(join(base, 'secret'), join(root, 'escape'))
  return { base, root }
}

describe('names and paths', () => {
  it('validates', () => {
    expect(validateName('Neuer Ordner')).toBeUndefined()
    for (const n of ['', '.', '..', 'a/b', 'x\ny']) expect(validateName(n), n).toBeDefined()
    expect(validatePath('/mnt/a b')).toBeUndefined()
    for (const p of ['rel', '/mnt/../etc', '/mnt/./x', '/mnt/a\0b']) expect(validatePath(p), p).toBeDefined()
  })
})

describe('roots', () => {
  it('takes data mounts, never the system', () => {
    const base = mkdtempSync(join(tmpdir(), 'qd-mounts-'))
    mkdirSync(join(base, 'storage'))
    const mounts = [`/dev/sda1 / ext4 rw 0 0`, `proc /proc proc rw 0 0`, `/dev/sdb1 ${join(base, 'storage')} xfs rw 0 0`, `/dev/sdc1 /boot vfat rw 0 0`, `tmpfs /tmp tmpfs rw 0 0`].join('\n')
    writeFileSync(join(base, 'mounts'), mounts)
    const roots = fileRootPaths(undefined, join(base, 'mounts'))
    expect(roots).toContain(join(base, 'storage'))
    expect(roots.some((r) => r === '/' || r.startsWith('/boot') || r.startsWith('/proc') || r.startsWith('/etc'))).toBe(false)
    expect(fileRootPaths(`${base}/storage, /etc, /`, join(base, 'mounts'))).toEqual([join(base, 'storage')])
  })

  it('resolves symlinks before checking the root', () => {
    const { root } = tree()
    expect(resolveInRoots(join(root, 'Filme'), [root]).real).toBe(join(root, 'Filme'))
    expect(() => resolveInRoots(join(root, 'escape', 'key'), [root])).toThrow('außerhalb')
    expect(() => resolveInRoots(root, [root])).toThrow('selbst')
    expect(resolveInRoots(root, [root], { allowRoot: true }).real).toBe(root)
    expect(() => resolveInRoots('/etc/passwd', [root])).toThrow('außerhalb')
  })
})

describe('SystemFiles', () => {
  it('lists, creates folders with the parent owner, renames', async () => {
    const { root } = tree()
    const f = new SystemFiles(() => [root])
    const l = await f.listDir(join(root, 'Filme'))
    expect(l.entries.map((e) => `${e.type}:${e.name}`).sort()).toEqual(['dir:Alt', 'file:a.mkv', 'file:b.mkv'])
    expect(l.entries.find((e) => e.name === 'a.mkv')!.size).toBe(6)
    const top = await f.listDir(root)
    expect(top.entries.find((e) => e.name === 'escape')).toMatchObject({ type: 'link' })
    await expect(f.listDir(join(root, 'escape'))).rejects.toMatchObject({ status: 403 })

    await f.makeDir(join(root, 'Neu'))
    expect(statSync(join(root, 'Neu')).uid).toBe(statSync(root).uid)
    await expect(f.makeDir(join(root, 'Neu'))).rejects.toMatchObject({ status: 409 })
    await expect(f.makeDir(join(root, 'escape', 'boom'))).rejects.toMatchObject({ status: 403 })
    await f.renamePath(join(root, 'Neu'), 'Umbenannt')
    expect(existsSync(join(root, 'Umbenannt'))).toBe(true)
    await expect(f.renamePath(join(root, 'Umbenannt'), '../etc')).rejects.toMatchObject({ status: 400 })
    // Renaming the link renames the link, not its target outside the root.
    await f.renamePath(join(root, 'escape'), 'link2')
    expect(existsSync(join(root, 'link2'))).toBe(true)
  })
})

describe('copy/move/delete jobs', () => {
  const env = process.env.QUADECK_FILE_ROOTS
  afterEach(() => {
    process.env.QUADECK_FILE_ROOTS = env
  })

  it('refuses conflicts, copying into itself and paths outside', () => {
    const { root, base } = tree()
    const ops = systemFsOps([root])
    expect(() => prepareFsJob({ kind: 'fs-copy', paths: [join(root, 'Filme', 'a.mkv')], toDir: join(root, 'Backup'), overwrite: false }, ops)).toThrow('Gibt es im Ziel schon: a.mkv')
    expect(prepareFsJob({ kind: 'fs-copy', paths: [join(root, 'Filme', 'a.mkv')], toDir: join(root, 'Backup'), overwrite: true }, ops).toDir).toBe(join(root, 'Backup'))
    expect(() => prepareFsJob({ kind: 'fs-copy', paths: [join(root, 'Filme')], toDir: join(root, 'Filme', 'Alt'), overwrite: false }, ops)).toThrow('in sich selbst')
    expect(() => prepareFsJob({ kind: 'fs-move', paths: [join(root, 'Filme', 'b.mkv')], toDir: join(root, 'Filme'), overwrite: false }, ops)).toThrow('schon in diesem Ordner')
    expect(() => prepareFsJob({ kind: 'fs-delete', paths: [join(base, 'secret')] }, ops)).toThrow('außerhalb')
    expect(() => prepareFsJob({ kind: 'fs-delete', paths: [root] }, ops)).toThrow('selbst')
    expect(fsJobSteps({ kind: 'fs-delete', paths: ['/x'] }, { sources: ['/x'] })).toEqual([['rm', '-r', '-f', '-v', '--one-file-system', '--', '/x']])
    expect(() => parseJobSpec({ kind: 'fs-copy', paths: ['/a/../etc'], toDir: '/mnt' })).toThrow()
    expect(() => parseJobSpec({ kind: 'fs-copy', paths: ['/a'], toDir: 'relative' })).toThrow()
  })

  it.skipIf(process.getuid?.() !== 0)('runs real cp, mv and rm through `quadeck job`', async () => {
    const { root } = tree()
    process.env.QUADECK_FILE_ROOTS = root
    const run = (spec: Parameters<typeof encodeSpec>[0]) => runJobCommand(encodeSpec(spec))
    expect(await run({ kind: 'fs-copy', paths: [join(root, 'Filme', 'a.mkv'), join(root, 'Filme', 'Alt')], toDir: join(root, 'Backup'), overwrite: true })).toBe(0)
    expect(readFileSync(join(root, 'Backup', 'a.mkv'), 'utf8')).toBe('film a')
    expect(statSync(join(root, 'Backup', 'Alt')).isDirectory()).toBe(true)
    expect(await run({ kind: 'fs-move', paths: [join(root, 'Filme', 'b.mkv')], toDir: join(root, 'Backup'), overwrite: false })).toBe(0)
    expect(existsSync(join(root, 'Filme', 'b.mkv'))).toBe(false)
    expect(await run({ kind: 'fs-delete', paths: [join(root, 'Backup')] })).toBe(0)
    expect(existsSync(join(root, 'Backup'))).toBe(false)
    // Outside the roots: the job itself refuses (exit 1), nothing happens.
    expect(await run({ kind: 'fs-delete', paths: ['/etc/hostname'] })).toBe(1)
    expect(existsSync('/etc/hostname')).toBe(true)
  })
})

describe('fixture files', () => {
  it('applies copy, move and delete in memory', async () => {
    const f = new FixtureFiles()
    expect(f.apply('copy', ['/mnt/disk1/Downloads/alt.zip'], '/mnt/disk2/Backup')).toEqual(["'/mnt/disk1/Downloads/alt.zip' -> '/mnt/disk2/Backup/alt.zip'"])
    f.apply('move', ['/mnt/disk1/Downloads/ubuntu-24.04.iso'], '/mnt/disk2/Backup')
    f.apply('delete', ['/mnt/disk1/Downloads/alt.zip'])
    expect((await f.listDir('/mnt/disk1/Downloads')).entries).toEqual([])
    expect((await f.listDir('/mnt/disk2/Backup')).entries.map((e) => e.name).sort()).toEqual(['alt.zip', 'ubuntu-24.04.iso'])
    await expect(f.listDir('/etc')).rejects.toMatchObject({ status: 403 })
  })
})
