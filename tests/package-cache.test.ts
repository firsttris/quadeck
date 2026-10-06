import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cachePlans, dirUsage, pacmanCacheDir } from '~/server/packages/cache'
import { parseJobSpec } from '~/server/packages/job'

const tmp = () => mkdtempSync(join(tmpdir(), 'qd-cache-'))
const yes = () => true
const no = () => false

describe('package cache', () => {
  it('pacman: CacheDir from pacman.conf, paccache keeps two versions, pacman -Sc without it', () => {
    expect(pacmanCacheDir('[options]\n#CacheDir = /x\n')).toBe('/var/cache/pacman/pkg')
    expect(pacmanCacheDir('[options]\nCacheDir    = /srv/pkgcache/\nCacheDir = /other\n')).toBe('/srv/pkgcache')
    const [withTool] = cachePlans('pacman', {}, yes)
    expect(withTool).toMatchObject({ id: 'packages', keep: 'two' })
    expect(withTool!.steps.map((s) => s.argv.join(' '))).toEqual([`paccache -r -k2 -c ${withTool!.path}`, `paccache -r -u -k0 -c ${withTool!.path}`])
    const [plain] = cachePlans('pacman', {}, no)
    expect(plain).toMatchObject({ keep: 'installed', steps: [{ argv: ['pacman', '-Sc', '--noconfirm'] }] })
  })

  it('every package manager with its own tool; none for image-based systems', () => {
    expect(cachePlans('apt', {}, yes)).toMatchObject([{ path: '/var/cache/apt/archives', keep: 'none', steps: [{ argv: ['apt-get', 'clean'] }] }])
    expect(cachePlans('dnf', {}, yes)[0]!.steps[0]!.argv.slice(1)).toEqual(['clean', 'packages'])
    expect(cachePlans('zypper', {}, yes)).toMatchObject([{ path: '/var/cache/zypp/packages', steps: [{ argv: ['zypper', '--non-interactive', 'clean'] }] }])
    expect(cachePlans('rpm-ostree', {}, yes)).toEqual([])
    expect(cachePlans('transactional-update', {}, yes)).toEqual([])
    expect(cachePlans(null, {}, yes)).toEqual([])
  })

  it('the AUR cache: yay and paru folders, only on Arch, only with a user', () => {
    const yay = cachePlans('pacman', { helper: 'yay', user: 'tristan', home: '/home/tristan' }, yes)[1]!
    expect(yay).toMatchObject({ id: 'aur', path: '/home/tristan/.cache/yay', owner: 'tristan', keep: 'files', helper: 'yay' })
    expect(cachePlans('pacman', { helper: 'paru', user: 'tristan', home: '/home/tristan' }, yes)[1]!.path).toBe('/home/tristan/.cache/paru/clone')
    expect(cachePlans('pacman', { helper: 'yay', home: '/home/x' }, yes)).toHaveLength(1)
    expect(cachePlans('apt', { helper: 'yay', user: 'tristan', home: '/home/tristan' }, yes)).toHaveLength(1)
  })

  it('cleaning the AUR cache removes the build folders and keeps the helper files', async () => {
    const home = tmp()
    const dir = join(home, '.cache/yay')
    mkdirSync(join(dir, 'lib32-libpaper/src/libpaper-2.2.6'), { recursive: true })
    writeFileSync(join(dir, 'lib32-libpaper/src/libpaper-2.2.6/big.o'), 'x'.repeat(10_000))
    mkdirSync(join(dir, 'visual-studio-code-bin'))
    writeFileSync(join(dir, 'vcs.json'), '{}')
    // a link to elsewhere is not followed (find -type d does not match it)
    const outside = tmp()
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    symlinkSync(outside, join(dir, 'link-out'))
    const plan = cachePlans('pacman', { helper: 'yay', user: 'me', home }, yes)[1]!
    const proc = Bun.spawn(plan.steps[0]!.argv, { stdout: 'pipe', stderr: 'pipe' })
    expect(await proc.exited).toBe(0)
    expect(existsSync(join(dir, 'lib32-libpaper'))).toBe(false)
    expect(existsSync(join(dir, 'visual-studio-code-bin'))).toBe(false)
    expect(existsSync(join(dir, 'vcs.json'))).toBe(true)
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
  })

  it('usage: allocated size and files, links not followed, missing folder is empty, a cap', () => {
    const d = tmp()
    mkdirSync(join(d, 'a/b'), { recursive: true })
    writeFileSync(join(d, 'a/b/f1'), 'x'.repeat(100_000))
    writeFileSync(join(d, 'f2'), 'y')
    const big = tmp()
    writeFileSync(join(big, 'huge'), 'z'.repeat(500_000))
    symlinkSync(big, join(d, 'link'))
    const u = dirUsage(d)
    expect(u.files).toBe(3) // f1, f2 and the link itself
    expect(u.size).toBeGreaterThanOrEqual(100_000)
    expect(u.size).toBeLessThan(400_000)
    expect(dirUsage(join(d, 'nope'))).toEqual({ size: 0, files: 0 })
    expect(dirUsage(d, 2).truncated).toBe(true)
  })

  it('job spec: known targets only', () => {
    expect(parseJobSpec({ kind: 'cache-clean', targets: ['packages', 'aur', 'aur'] })).toEqual({ kind: 'cache-clean', targets: ['packages', 'aur'] })
    expect(() => parseJobSpec({ kind: 'cache-clean', targets: [] })).toThrow()
    expect(() => parseJobSpec({ kind: 'cache-clean', targets: ['/etc'] })).toThrow()
  })
})
