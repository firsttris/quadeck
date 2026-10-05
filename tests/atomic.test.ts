import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeFileAtomic } from '~/server/atomic'

describe('writeFileAtomic', () => {
  it('replaces the file with the asked mode whatever the umask, leaves no temp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qd-atomic-'))
    const file = join(dir, 'fstab')
    writeFileSync(file, 'old\n')
    const old = process.umask(0o077)
    try {
      writeFileAtomic(file, 'new\n')
      writeFileAtomic(join(dir, 'sub', 'x.container'), '[Container]\n', { mkdir: 0o755 })
    } finally {
      process.umask(old)
    }
    expect(readFileSync(file, 'utf8')).toBe('new\n')
    expect(statSync(file).mode & 0o777).toBe(0o644)
    expect(statSync(join(dir, 'sub', 'x.container')).mode & 0o777).toBe(0o644)
    expect(readdirSync(dir).sort()).toEqual(['fstab', 'sub'])
  })

  it('never writes through a temp-file link planted in the folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qd-atomic-link-'))
    const victim = join(dir, 'shadow')
    writeFileSync(victim, 'root:secret\n', { mode: 0o600 })
    const home = join(dir, 'home')
    mkdirSync(home)
    writeFileSync(join(home, 'notes.txt'), 'hello\n', { mode: 0o640 })
    symlinkSync(victim, join(home, 'notes.txt.quadeck-tmp'))
    writeFileAtomic(join(home, 'notes.txt'), 'edited\n', { mode: 0o640, owner: process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : undefined })
    expect(readFileSync(victim, 'utf8')).toBe('root:secret\n')
    expect(statSync(victim).uid).toBe(process.getuid?.() ?? statSync(victim).uid)
    expect(readFileSync(join(home, 'notes.txt'), 'utf8')).toBe('edited\n')
    expect(lstatSync(join(home, 'notes.txt')).isSymbolicLink()).toBe(false)
    expect(statSync(join(home, 'notes.txt')).mode & 0o777).toBe(0o640)
    if (process.getuid?.() === 0) expect(statSync(join(home, 'notes.txt')).uid).toBe(65534)
  })
})
