import { chownSync, existsSync, lstatSync, statSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, linkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { archiveFormat, archiveStem, checkEntries, extractBlocked, packName, parseTarList, parseZipInfo } from '~/shared/archives'
import { asOwnerOf, extractArgv, gnuTar, packArgv, preparePack, previewExtract, systemArchiveHost } from '~/server/files/archives'
import { FixtureFiles } from '~/server/files/backend'
import { jobTitle, parseJobSpec } from '~/server/packages/job'

const sh = (argv: string[], cwd?: string, stdin?: string) => {
  const r = Bun.spawnSync(argv, { cwd, stdin: stdin ? Bun.file(stdin) : 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LC_ALL: 'C' } })
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString()
}
/** Runs an extractArgv() result like the job does. */
const unpack = (x: { argv: string[]; stdin?: string }) => sh(x.argv, undefined, x.stdin)
const hasZip = !!Bun.which('zip') && !!Bun.which('unzip')

/** A data area with a source folder to build archives from. */
function area() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qd-arch-')))
  const src = join(root, 'src')
  mkdirSync(join(src, 'fotos', 'urlaub'), { recursive: true })
  writeFileSync(join(src, 'fotos', 'urlaub', 'a.jpg'), 'A'.repeat(1000))
  writeFileSync(join(src, 'fotos', 'liste mit leerzeichen.txt'), 'hallo\n')
  symlinkSync('urlaub/a.jpg', join(src, 'fotos', 'link-innen'))
  return { root, src }
}

describe('archive names', () => {
  it('knows the formats and the folder name they unpack into', () => {
    expect(archiveFormat('x.ZIP')).toBe('zip')
    expect(archiveFormat('fotos.tgz')).toBe('tar.gz')
    expect(archiveFormat('a.tar.zst')).toBe('tar.zst')
    expect(archiveFormat('a.tar.xz')).toBe('tar.xz')
    expect(archiveFormat('a.tbz2')).toBe('tar.bz2')
    expect(archiveFormat('film.mkv')).toBeNull()
    expect(archiveFormat('a.gz')).toBeNull() // a single compressed file is not an archive
    expect(archiveStem('fotos-2019.tar.gz')).toBe('fotos-2019')
    expect(archiveStem('.tar')).toBe('.tar')
    expect(packName('Fotos', 'zip')).toBe('Fotos.zip')
    expect(packName('Fotos.tar.gz', 'tar.gz')).toBe('Fotos.tar.gz')
  })
})

describe('listings', () => {
  it('reads GNU tar -tv, including links, setuid and escaped names', () => {
    const { root, src } = area()
    writeFileSync(join(src, 'tool'), '#!/bin/sh\n')
    sh(['chmod', '4755', join(src, 'tool')]) // Bun's chmodSync drops the setuid bit
    linkSync(join(src, 'tool'), join(src, 'tool-hard'))
    symlinkSync('/etc', join(src, 'evil'))
    const tar = join(root, 'a.tar')
    sh(['tar', '-cf', tar, 'fotos', 'tool', 'tool-hard', 'evil'], src)
    const entries = parseTarList(sh(['tar', '-tvf', tar]))
    expect(entries.find((e) => e.path === 'fotos/liste mit leerzeichen.txt')).toMatchObject({ type: 'file', size: 6 })
    expect(entries.find((e) => e.path === 'fotos/link-innen')).toMatchObject({ type: 'link', target: 'urlaub/a.jpg' })
    expect(entries.find((e) => e.path === 'evil')).toMatchObject({ type: 'link', target: '/etc' })
    expect(entries.find((e) => e.path === 'tool')).toMatchObject({ special: true })
    expect(entries.find((e) => e.path === 'tool-hard')).toMatchObject({ type: 'hardlink', target: 'tool' })
    const check = checkEntries(entries)
    expect(check.problems.map((p) => [p.path, p.reason])).toEqual([
      ['tool', 'special'],
      ['tool-hard', 'special'], // a hard link to a setuid file is as bad
      ['evil', 'linkOutside'],
    ])
    expect(check.tops).toEqual(['evil', 'fotos', 'tool', 'tool-hard'])
  })

  it('finds "../" and absolute paths that a crafted tar carries', () => {
    const { root, src } = area()
    const bad = join(root, 'bad.tar')
    sh(['tar', '--transform', 's,^,../../,', '-cf', bad, 'fotos/urlaub/a.jpg'], src)
    sh(['tar', '-P', '-rf', bad, join(src, 'fotos', 'urlaub', 'a.jpg')]) // absolute name
    const problems = checkEntries(parseTarList(sh(['tar', '-tvf', bad]))).problems
    expect(problems.map((p) => p.reason)).toEqual(['parent', 'absolute'])
  })

  it('reads BusyBox tar -tv lines too', () => {
    const out = ['-rw-r--r-- 1000/1000      1234 2024-01-01 12:00:00 docs/a.txt', 'lrwxrwxrwx 0/0         0 2024-01-01 12:00:00 docs/b -> a.txt', 'crw-r--r-- 0/0      1,3 2024-01-01 12:00:00 null'].join('\n')
    const entries = parseTarList(out)
    expect(entries).toEqual([
      { path: 'docs/a.txt', type: 'file', size: 1234 },
      { path: 'docs/b', type: 'link', size: 0, target: 'a.txt' },
      { path: 'null', type: 'other', size: 0 },
    ])
    expect(checkEntries(entries).problems).toEqual([{ path: 'null', reason: 'device' }])
  })

  it('links: inside the archive fine, leaving it is refused', () => {
    const e = (path: string, target: string) => ({ path, type: 'link' as const, size: 0, target })
    expect(checkEntries([e('a/b/c', '../d')]).problems).toEqual([])
    expect(checkEntries([e('a/b', '../../x')]).problems).toHaveLength(1)
    expect(checkEntries([e('a', '/etc/passwd')]).problems).toHaveLength(1)
    expect(checkEntries([{ path: 'x', type: 'link', size: 0 }]).problems).toHaveLength(1) // unknown target
  })

  it.skipIf(!hasZip)('reads unzip -Z -T and the link targets zip keeps as content', async () => {
    const { root, src } = area()
    symlinkSync('/root', join(src, 'fotos', 'home'))
    const zip = join(root, 'a.zip')
    sh(['zip', '-q', '-r', '-y', zip, 'fotos'], src)
    const entries = parseZipInfo(sh(['unzip', '-Z', '-T', zip]))
    expect(entries.find((e) => e.path === 'fotos/urlaub/a.jpg')).toMatchObject({ type: 'file', size: 1000 })
    expect(entries.find((e) => e.path === 'fotos/')).toMatchObject({ type: 'dir' })
    const listed = await systemArchiveHost([root]).list(zip, 'zip')
    if (listed === 'zip') throw new Error('unzip missing')
    expect(listed.find((e) => e.path === 'fotos/home')).toMatchObject({ type: 'link', target: '/root' })
    expect(listed.find((e) => e.path === 'fotos/link-innen')).toMatchObject({ type: 'link', target: 'urlaub/a.jpg' })
    expect(checkEntries(listed).problems).toEqual([{ path: 'fotos/home', reason: 'linkOutside', target: '/root' }])
  })
})

describe('preview and unpacking on a real file system', () => {
  it('new folder by default; conflicts, links in the target and space are checked', async () => {
    const { root, src } = area()
    const tgz = join(root, 'fotos.tar.gz')
    sh(['tar', '-czf', tgz, 'fotos'], src)
    const host = systemArchiveHost([root])

    const fresh = await previewExtract(tgz, join(root, 'fotos-neu'), host)
    expect(fresh).toMatchObject({ format: 'tar.gz', create: true, files: 3, dirs: 2, size: 1006, problems: [], conflicts: [] })
    expect(fresh.free).toBeGreaterThan(0)
    expect(extractBlocked(fresh, false)).toBe(false)

    // into the folder that already has "fotos": a conflict, refused unless overwriting
    const here = await previewExtract(tgz, src, host)
    expect(here.conflicts).toEqual(['fotos'])
    expect(extractBlocked(here, false)).toBe(true)
    expect(extractBlocked(here, true)).toBe(false)

    // a symlink in the target where the archive writes: refused
    const t = join(root, 'ziel')
    mkdirSync(t)
    symlinkSync('/tmp', join(t, 'fotos'))
    const linked = await previewExtract(tgz, t, host)
    expect(linked.linkInTarget).toBe(join(t, 'fotos'))
    expect(extractBlocked(linked, true)).toBe(true)

    // outside the areas: refused
    await expect(previewExtract(tgz, '/etc/x', host)).rejects.toMatchObject({ status: 403 })
    await expect(previewExtract(join(root, 'nope.tar'), src, host)).rejects.toMatchObject({ status: 404 })
  })

  it('unpacks with tar: keeps existing files unless overwriting, never takes over owners', async () => {
    const { root, src } = area()
    const tgz = join(root, 'fotos.tgz')
    sh(['tar', '-czf', tgz, 'fotos'], src)
    const dest = join(root, 'dest')
    mkdirSync(dest)
    unpack(extractArgv('tar.gz', tgz, dest, false, gnuTar()))
    expect(readFileSync(join(dest, 'fotos', 'urlaub', 'a.jpg'), 'utf8')).toHaveLength(1000)
    expect(lstatSync(join(dest, 'fotos', 'link-innen')).isSymbolicLink()).toBe(true)
    if (gnuTar()) expect(extractArgv('tar', 'a', 'b', false, true).argv).toEqual(expect.arrayContaining(['--no-same-owner', '--no-same-permissions', '--keep-old-files']))
    writeFileSync(join(dest, 'fotos', 'urlaub', 'a.jpg'), 'changed')
    expect(() => unpack(extractArgv('tar.gz', tgz, dest, false, gnuTar()))).toThrow() // keep-old-files: refuses to replace
    expect(readFileSync(join(dest, 'fotos', 'urlaub', 'a.jpg'), 'utf8')).toBe('changed')
    unpack(extractArgv('tar.gz', tgz, dest, true, gnuTar()))
    expect(readFileSync(join(dest, 'fotos', 'urlaub', 'a.jpg'), 'utf8')).toHaveLength(1000)
  })

  it.skipIf(!hasZip)('packs and unpacks zip and tar.gz', async () => {
    const { root, src } = area()
    const host = systemArchiveHost([root])
    for (const format of ['zip', 'tar.gz'] as const) {
      const prepared = preparePack({ kind: 'fs-pack', paths: [join(src, 'fotos')], format, name: 'Sicherung' }, host)
      expect(prepared.out).toBe(join(src, `Sicherung.${format}`))
      const { argv, cwd } = packArgv(format, prepared.dir, prepared.out, prepared.names)
      sh(argv, cwd)
      const p = await previewExtract(prepared.out, join(root, `aus-${format}`), host)
      expect(p).toMatchObject({ files: 3, problems: [], create: true })
      mkdirSync(p.toDir)
      unpack(extractArgv(format, prepared.out, p.toDir, false, gnuTar()))
      expect(existsSync(join(p.toDir, 'fotos', 'liste mit leerzeichen.txt'))).toBe(true)
      // the same name again: refused
      expect(() => preparePack({ kind: 'fs-pack', paths: [join(src, 'fotos')], format, name: 'Sicherung' }, host)).toThrow(/gibt es schon/)
    }
    expect(() => preparePack({ kind: 'fs-pack', paths: [join(src, 'fotos'), join(root, 'x')], format: 'zip', name: 'x' }, host)).toThrow(/einem Ordner/)
    expect(() => preparePack({ kind: 'fs-pack', paths: [join(src, 'fotos')], format: 'zip', name: '../x' }, host)).toThrow()
  })
})

describe('as the folder owner', () => {
  const root = process.getuid?.() === 0 && !!Bun.which('setpriv')
  it.skipIf(!root)('unpacks as the owner of the target folder, not as root – even when that owner cannot read the archive', () => {
    const { root: base, src } = area()
    sh(['chmod', '755', base])
    const secret = join(base, 'nur-root')
    mkdirSync(secret, { mode: 0o700 })
    const tgz = join(secret, 'fotos.tgz')
    sh(['tar', '-czf', tgz, 'fotos'], src)
    const dest = join(base, 'nutzer')
    mkdirSync(dest)
    chownSync(dest, 1000, 1000)
    const x = extractArgv('tar.gz', tgz, dest, false, gnuTar())
    const argv = asOwnerOf(dest, x.argv)
    expect(argv.slice(0, 4)).toEqual(['setpriv', '--reuid=1000', '--regid=1000', '--clear-groups'])
    sh(argv, undefined, x.stdin)
    expect(statSync(join(dest, 'fotos', 'urlaub', 'a.jpg')).uid).toBe(1000)
    // a root-owned folder: no setpriv (root writes, owners from the archive are not taken over)
    expect(asOwnerOf(base, ['tar'])).toEqual(['tar'])
  })
})

describe('jobs and the demo', () => {
  it('validates extract and pack jobs', () => {
    expect(parseJobSpec({ kind: 'fs-extract', archive: '/mnt/a.zip', toDir: '/mnt/a', overwrite: 'yes' })).toEqual({ kind: 'fs-extract', archive: '/mnt/a.zip', toDir: '/mnt/a', overwrite: false })
    expect(() => parseJobSpec({ kind: 'fs-extract', archive: 'relative.zip', toDir: '/mnt' })).toThrow()
    expect(() => parseJobSpec({ kind: 'fs-pack', paths: ['/mnt/a'], format: 'rar', name: 'x' })).toThrow(/Format/)
    expect(jobTitle({ kind: 'fs-pack', paths: ['/mnt/a'], format: 'zip', name: 'x' })).toBe('Packen: x')
  })

  it('demo: the crafted archive is refused, the photo archive unpacks and packs again', async () => {
    const f = new FixtureFiles()
    const evil = await f.archivePreview('/mnt/disk2/Archiv/fremd.tar.gz', '/mnt/disk2/Archiv/fremd', false)
    expect(evil.problems.map((p) => p.reason).sort()).toEqual(['linkOutside', 'parent', 'special'])
    await expect(f.extract({ kind: 'fs-extract', archive: '/mnt/disk2/Archiv/fremd.tar.gz', toDir: '/mnt/disk2/Archiv/fremd', overwrite: true })).rejects.toThrow(/nicht sicher/)

    const ok = await f.archivePreview('/mnt/disk2/Archiv/fotos-2019.tar.gz', '/mnt/disk2/Archiv/fotos-2019', false)
    expect(ok).toMatchObject({ create: true, files: 3, problems: [], conflicts: [] })
    await f.extract({ kind: 'fs-extract', archive: '/mnt/disk2/Archiv/fotos-2019.tar.gz', toDir: '/mnt/disk2/Archiv/fotos-2019', overwrite: false })
    expect((await f.listDir('/mnt/disk2/Archiv/fotos-2019/fotos-2019/urlaub')).entries.map((e) => e.name).sort()).toEqual(['IMG_2019_001.jpg', 'IMG_2019_002.jpg'])
    expect((await f.archivePreview('/mnt/disk2/Archiv/fotos-2019.tar.gz', '/mnt/disk2/Archiv/fotos-2019', false)).conflicts).toEqual(['fotos-2019'])

    await f.pack({ kind: 'fs-pack', paths: ['/mnt/disk2/Archiv/fotos-2019'], format: 'zip', name: 'nochmal' })
    expect((await f.archivePreview('/mnt/disk2/Archiv/nochmal.zip', '/mnt/disk2/Backup', false)).files).toBe(3)
  })
})
