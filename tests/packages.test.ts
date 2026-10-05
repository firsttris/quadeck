import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeSpec, encodeSpec, parseJobSpec } from '~/server/packages/job'
import { JobManager, lineSplitter, type JobSink } from '~/server/packages/jobs'
import { FixtureMaintenance, SystemMaintenance, findConfigFiles } from '~/server/packages/maintenance'
import * as p from '~/server/packages/parse'

const PACMAN_QI = `Name            : bash
Version         : 5.2.026-2
Description     : The GNU Bourne Again shell
Architecture    : x86_64
URL             : https://www.gnu.org/software/bash/bash.html
Licenses        : GPL-3.0-or-later
Groups          : None
Provides        : sh
Depends On      : readline  libreadline.so=8-64  glibc  ncurses
Optional Deps   : bash-completion: for tab completion
                  foo: other
Required By     : base  bzip2  gzip
                  sed
Optional For    : None
Installed Size  : 9.03 MiB
Install Date    : Tue 02 Jan 2024 10:00:00 AM CET
Install Reason  : Installed as a dependency for another package

Name            : python-old
Version         : 1.0-1
Description     : old
Depends On      : None
Required By     : None
Optional For    : None
Installed Size  : 512.00 KiB
Install Reason  : Installed as a dependency for another package

Name            : yay
Version         : 12.3.5-1
Description     : AUR helper
Depends On      : pacman
Required By     : None
Optional For    : None
Installed Size  : 8.90 MiB
Install Reason  : Explicitly installed
`

describe('pacman', () => {
  it('parses -Qi with continuation lines, sizes, reasons and orphans', () => {
    const recs = p.parsePacmanInfo(PACMAN_QI).map((r) => p.pacmanRecordToPackage(r, new Set(['yay'])))
    expect(recs).toHaveLength(3)
    const [bash, old, yay] = recs
    expect(bash).toMatchObject({ name: 'bash', version: '5.2.026-2', reason: 'dependency', orphan: false, foreign: false, size: Math.round(9.03 * 1024 * 1024) })
    expect(bash!.depends).toEqual(['readline', 'libreadline.so=8-64', 'glibc', 'ncurses'])
    expect(bash!.requiredBy).toEqual(['base', 'bzip2', 'gzip', 'sed'])
    expect(old).toMatchObject({ orphan: true, size: 512 * 1024, depends: [] })
    expect(yay).toMatchObject({ reason: 'explicit', foreign: true, orphan: false })
  })

  it('parses -Qu (skipping ignored) and -Sup print format', () => {
    expect(p.parsePacmanQu('linux 6.9.1.arch1-1 -> 6.9.2.arch1-1\nfoo 1-1 -> 2-1 [ignored]\n')).toEqual([{ name: 'linux', from: '6.9.1.arch1-1', to: '6.9.2.arch1-1' }])
    const m = p.parsePacmanPrint('core linux 6.9.2.arch1-1 143200000\nextra podman 5.2.1-1 18400000\n')
    expect(m.get('podman')).toEqual({ repo: 'extra', size: 18400000 })
  })

  it('finds the last full system upgrade in pacman.log', () => {
    const log = `[2024-05-01T10:00:00+0200] [PACMAN] starting full system upgrade
[2024-05-02T08:30:00+0200] [PACMAN] Running 'pacman -S htop'
[2024-05-03T09:15:00+0200] [PACMAN] starting full system upgrade
[2024-05-03T09:16:00+0200] [ALPM] upgraded linux (6.8-1 -> 6.9-1)`
    expect(p.lastPacmanUpgrade(log)).toBe(Date.parse('2024-05-03T09:15:00+02:00'))
    expect(p.lastPacmanUpgrade('')).toBeUndefined()
  })

  it('parses remove previews (name version)', () => {
    expect(p.parseNameVersion('tealdeer 1.6.1-6\ntealdeer-data 1.0-1\n')).toEqual([
      { name: 'tealdeer', version: '1.6.1-6' },
      { name: 'tealdeer-data', version: '1.0-1' },
    ])
  })
})

describe('apt', () => {
  it('parses dpkg-query output (installed only, KiB sizes)', () => {
    const out = 'bash\t5.2-1\t1900\tii \tGNU shell\nold\t1\t10\trc \tgone\nheld\t2\t1\thi \tx\n'
    expect(p.parseDpkgList(out)).toEqual([
      { name: 'bash', version: '5.2-1', size: 1900 * 1024, description: 'GNU shell' },
      { name: 'held', version: '2', size: 1024, description: 'x' },
    ])
  })

  it('parses simulated upgrades and removals', () => {
    const sim = `Reading package lists...
Inst libc6 [2.39-0ubuntu8.7] (2.39-0ubuntu8.9 Ubuntu:24.04/noble-updates [amd64])
Inst newpkg (1.0 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])
Conf libc6 (2.39-0ubuntu8.9 Ubuntu:24.04/noble-updates [amd64])
Remv htop [3.3.0-4build1]`
    const r = p.parseAptSim(sim)
    expect(r.inst).toEqual([
      { name: 'libc6', from: '2.39-0ubuntu8.7', to: '2.39-0ubuntu8.9', repo: 'noble-updates' },
      { name: 'newpkg', from: '', to: '1.0', repo: 'noble-updates' },
    ])
    expect(r.remv).toEqual([{ name: 'htop', version: '3.3.0-4build1' }])
  })

  it('parses control fields, depends and rdepends', () => {
    const c = p.parseControl('Package: curl\nVersion: 8.5\nDepends: libc6 (>= 2.34), libcurl4t64 (= 8.5) | libcurl4, zlib1g:any\nDescription: tool\n more text\n')
    expect(c.Description).toBe('tool\nmore text')
    expect(p.parseDebDepends(c.Depends)).toEqual(['libc6', 'libcurl4t64', 'zlib1g'])
    expect(p.parseRdepends('libtinfo6\nReverse Depends:\n  bash\n |less\n  bash\n')).toEqual(['bash', 'less'])
    expect(p.parseAptLocal('foo/now 1.0 amd64 [installed,local]\nbar/noble 2 amd64 [installed]\n')).toEqual(new Set(['foo']))
  })
})

describe('rpm family, apk, rpm-ostree', () => {
  it('parses rpm -qa and skips gpg-pubkey', () => {
    expect(p.parseRpmList('bash\t0:5.2.26-3.fc40\t8000000\tThe GNU Bourne Again shell\ngpg-pubkey\t0:abc-def\t0\tkey\nfoo\t1:2.0-1\t10\tx\n')).toEqual([
      { name: 'bash', version: '5.2.26-3.fc40', size: 8000000, description: 'The GNU Bourne Again shell' },
      { name: 'foo', version: '1:2.0-1', size: 10, description: 'x' },
    ])
  })

  it('parses dnf check-update incl. wrapped lines and obsoletes', () => {
    const out = `
kernel.x86_64                       6.10.3-200.fc40        updates
a-very-long-package-name-that-wraps.noarch
                                    1.2-3.fc40             updates
Obsoleting Packages
foo.x86_64  1-1  updates`
    expect(p.parseDnfCheckUpdate(out)).toEqual([
      { name: 'kernel', to: '6.10.3-200.fc40', repo: 'updates' },
      { name: 'a-very-long-package-name-that-wraps', to: '1.2-3.fc40', repo: 'updates' },
    ])
  })

  it('parses dnf transaction tables', () => {
    const out = ` Package        Arch     Version        Repository   Size
Removing:
 htop           x86_64   3.3.0-3.fc40   @updates     450 k
Removing unused dependencies:
 hwloc-libs     x86_64   2.10.0-3.fc40  @fedora      2.9 M
`
    expect(p.parseDnfTransaction(out)).toEqual([
      { name: 'htop', version: '3.3.0-3.fc40' },
      { name: 'hwloc-libs', version: '2.10.0-3.fc40' },
    ])
  })

  it('parses zypper tables and remove output', () => {
    const lu = `S | Repository | Name   | Current Version | Available Version | Arch
--+------------+--------+-----------------+-------------------+-------
v | repo-oss   | podman | 5.1.0-1.1       | 5.2.0-1.1         | x86_64`
    expect(p.parseZypperTable(lu)).toEqual([['v', 'repo-oss', 'podman', '5.1.0-1.1', '5.2.0-1.1', 'x86_64']])
    expect(p.parseZypperRemove('Reading...\nThe following 2 packages are going to be REMOVED:\n  htop libhwloc15\n\n2 packages to remove.')).toEqual(['htop', 'libhwloc15'])
  })

  it('parses apk lists and purge previews', () => {
    expect(p.splitApkPkg('py3-foo-bar-1.2.3-r0')).toEqual({ name: 'py3-foo-bar', version: '1.2.3-r0' })
    expect(p.parseApkList('curl-8.9.0-r0 x86_64 {curl} (curl) [upgradable from: curl-8.8.0-r0]\n')).toEqual([{ name: 'curl', version: '8.9.0-r0', from: '8.8.0-r0' }])
    expect(p.parseApkPurge('(1/2) Purging htop (3.3.0-r0)\n(2/2) Purging ncurses-libs (6.4-r2)\n')).toEqual([
      { name: 'htop', version: '3.3.0-r0' },
      { name: 'ncurses-libs', version: '6.4-r2' },
    ])
  })

  it('parses rpm-ostree diffs and rpm requires', () => {
    expect(p.parseOstreeDiff('Upgraded:\n  bash 5.1-1.fc36 -> 5.2-1.fc37\n')).toEqual([{ name: 'bash', from: '5.1-1.fc36', to: '5.2-1.fc37' }])
    expect(p.parseRpmRequires('/bin/sh\nglibc >= 2.34\nlibc.so.6()(64bit)\nrpmlib(PayloadIsZstd) <= 5.4\nncurses-libs\n')).toEqual(['glibc', 'ncurses-libs'])
  })
})

describe('podman auto-update and news', () => {
  it('parses podman auto-update --dry-run --format json', () => {
    const out = JSON.stringify([{ Unit: 'jellyfin.service', Container: '3fe1 (jellyfin)', ContainerName: 'jellyfin', Image: 'docker.io/jellyfin/jellyfin:latest', Policy: 'registry', Updated: 'pending' }])
    expect(p.parseAutoUpdate(out)).toEqual([{ unit: 'jellyfin.service', container: 'jellyfin', image: 'docker.io/jellyfin/jellyfin:latest', policy: 'registry', updated: 'pending' }])
    expect(p.parseAutoUpdate('null')).toEqual([])
  })

  it('parses the Arch news feed and drops non-https links', () => {
    const xml = `<rss><channel><item><title>Manual intervention &amp; more</title><link>https://archlinux.org/news/x/</link><pubDate>Mon, 01 Jul 2024 10:00:00 +0000</pubDate></item>
<item><title><![CDATA[evil]]></title><link>javascript:alert(1)</link><pubDate>Mon, 01 Jul 2024 10:00:00 +0000</pubDate></item></channel></rss>`
    expect(p.parseRss(xml)).toEqual([{ title: 'Manual intervention & more', link: 'https://archlinux.org/news/x/', date: Date.parse('2024-07-01T10:00:00Z') }])
  })

  it('parses sizes', () => {
    expect(p.parseSize('1.5 GiB')).toBe(1.5 * 1024 ** 3)
    expect(p.parseSize('12 B')).toBe(12)
    expect(p.parseSize('n/a')).toBeUndefined()
  })
})

describe('jobs', () => {
  it('validates job specs', () => {
    expect(parseJobSpec({ kind: 'upgrade', extra: 1 })).toEqual({ kind: 'upgrade' })
    expect(parseJobSpec({ kind: 'remove', names: ['a', 'a', 'b+c'] })).toEqual({ kind: 'remove', names: ['a', 'b+c'] })
    expect(() => parseJobSpec({ kind: 'remove', names: ['-Rdd'] })).toThrow()
    expect(() => parseJobSpec({ kind: 'remove', names: ['a b'] })).toThrow()
    expect(() => parseJobSpec({ kind: 'remove', names: [] })).toThrow()
    expect(() => parseJobSpec({ kind: 'image-update', unit: '--now.service' })).toThrow()
    expect(() => parseJobSpec({ kind: 'shell', cmd: 'rm -rf /' })).toThrow()
    const spec = { kind: 'image-update', unit: 'jellyfin.service' } as const
    expect(decodeSpec(encodeSpec(spec))).toEqual(spec)
    expect(encodeSpec(spec)).toMatch(/^[A-Za-z0-9_-]+$/) // safe for systemd-run (no % or $)
  })

  it('splits lines, strips ANSI and keeps the last carriage-return segment', () => {
    const got: string[] = []
    const s = lineSplitter((l) => got.push(l))
    s.push('a\x1b[1mb\x1b[0m\npro')
    s.push('gress 10%\rprogress 100%\nend')
    s.flush()
    expect(got).toEqual(['ab', 'progress 100%', 'end'])
  })

  it('drops lines that are only progress control codes and collapses empty lines', () => {
    const got: string[] = []
    const s = lineSplitter((l) => got.push(l))
    // pacman -Syu without a terminal: one line of erase codes per download step
    s.push(':: Retrieving packages...\n' + '\x1b[K\r\x1b[1A\n'.repeat(40) + '\r \r\n')
    s.push('\n\n\n(31/31) checking keys in keyring\n\nend\n')
    s.flush()
    expect(got).toEqual([':: Retrieving packages...', '', '(31/31) checking keys in keyring', '', 'end'])
  })

  it('runs one job at a time and stops at the exit marker', async () => {
    let sink: JobSink | undefined
    const m = new JobManager({ start: async (_id, _spec, s) => void (sink = s) })
    const j = await m.start({ kind: 'upgrade' })
    expect(j.title).toBe('Systemupdate')
    await expect(m.start({ kind: 'upgrade' })).rejects.toMatchObject({ status: 409 })
    sink!.line('hello')
    sink!.line('::quadeck-exit 3')
    sink!.line('ignored')
    const st = m.get(j.id, 0)!
    expect(st).toMatchObject({ status: 'failed', exitCode: 3, lines: ['hello'], total: 1 })
    expect(m.get(j.id, 1)!.lines).toEqual([])
    await m.start({ kind: 'images-update' }) // free again
    expect(m.list()).toHaveLength(2)
  })

  it('drops the update list the moment the upgrade ends, also against a check that was still running', async () => {
    let sink: JobSink | undefined
    const m = new SystemMaintenance({ start: async (_id, _spec, s) => void (sink = s) })
    let pending = [{ name: 'linux', from: '6.1', to: '6.2' }]
    let release: (() => void) | undefined
    let slow = false
    const provider = {
      id: 'apt',
      updates: async () => {
        const result = pending
        if (slow) await new Promise<void>((r) => (release = r))
        return result
      },
    }
    Object.assign(m as unknown as { provider: unknown }, { provider })
    expect((await m.updates(false)).repo).toHaveLength(1)

    // The page reloads right when it sees the job end: the list must be fresh at once.
    await m.startJob({ kind: 'upgrade' })
    pending = []
    sink!.line('::quadeck-exit 0')
    expect((await m.updates(false)).repo).toEqual([])

    // A check that started before a job ended must not store its old result.
    pending = [{ name: 'podman', from: '5.5', to: '5.6' }]
    Object.assign(m as unknown as { updatesCache: unknown }, { updatesCache: undefined })
    slow = true
    const stale = m.updates(false)
    await m.startJob({ kind: 'upgrade' })
    pending = []
    sink!.line('::quadeck-exit 0')
    release!()
    expect((await stale).repo).toHaveLength(1) // the caller that asked before still gets its answer
    slow = false
    expect((await m.updates(false)).repo).toEqual([])
  })

  it('marks a job failed when the launcher throws', async () => {
    const m = new JobManager({ start: async () => Promise.reject(new Error('kein systemd-run')) })
    const j = await m.start({ kind: 'upgrade' })
    expect(j.status).toBe('failed')
    expect(m.get(j.id, 0)!.lines).toEqual(['Fehler: kein systemd-run'])
  })
})

describe('maintenance', () => {
  it('finds .pacnew & co. below /etc', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qd-etc-'))
    mkdirSync(join(dir, 'pacman.d'))
    writeFileSync(join(dir, 'pacman.d', 'mirrorlist.pacnew'), '')
    writeFileSync(join(dir, 'pacman.conf'), '')
    writeFileSync(join(dir, 'smb.conf.pacsave'), '')
    expect(findConfigFiles(dir, /\.(pacnew|pacsave)$/)).toEqual([join(dir, 'pacman.d', 'mirrorlist.pacnew'), join(dir, 'smb.conf.pacsave')])
  })

  it('fixture backend refuses protected packages and removes orphaned deps along', async () => {
    const m = new FixtureMaintenance('fixtures/demo')
    expect((await m.removePreview(['systemd'])).blocked).toEqual(['systemd'])
    await expect(m.startJob({ kind: 'remove', names: ['systemd'] })).rejects.toMatchObject({ status: 403 })
    const prev = await m.removePreview(['tealdeer'])
    expect(prev.packages.map((x) => x.name)).toEqual(['tealdeer', 'tealdeer-data'])
    const j = await m.startJob({ kind: 'remove', names: ['tealdeer'] })
    await expect.poll(async () => (await m.job(j.id, 0))?.status, { timeout: 3000 }).toBe('ok')
    expect((await m.installed()).some((x) => x.name.startsWith('tealdeer'))).toBe(false)
  })
})

describe('job refusal', () => {
  it('drops the record when the launcher refuses with an HTTP error', async () => {
    const { HttpError } = await import('~/server/auth')
    const m = new JobManager({ start: async () => Promise.reject(new HttpError(409, 'läuft schon')) })
    await expect(m.start({ kind: 'upgrade' })).rejects.toMatchObject({ status: 409 })
    expect(m.list()).toEqual([])
  })
})
