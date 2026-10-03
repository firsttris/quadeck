import { describe, expect, it } from 'vitest'
import { commitLabel } from '~/server/quadlets/backend'
import { setLangResolver } from '~/shared/i18n'
import { LEGACY_MANAGED_HEADER, MANAGED_HEADER, emptySpec, renderService, renderTimer, specFromService } from '~/shared/timers'
import { kernelEntry } from '~/shared/boot'
import { overrideTemplate } from '~/shared/unit-files'

// What Quadeck writes into files is English, whatever language the UI is in;
// files written by older (German) versions are still recognised.

describe('file content', () => {
  const spec = { ...emptySpec(), name: 'backup', description: 'Backup', command: '/usr/local/bin/backup', calendar: '*-*-* 03:00:00' }

  it('writes English in every UI language', () => {
    for (const lang of ['de', 'en'] as const) {
      setLangResolver(() => lang)
      expect(renderService(spec)).toContain(MANAGED_HEADER)
      expect(renderTimer(spec)).toContain('Description=Schedule: Backup')
      expect(overrideTemplate('x.service')).toBe('# Override for x.service\n# Only enter changed settings.\n[Service]\n')
    }
    delete (globalThis as { __quadeckLang?: unknown }).__quadeckLang
  })

  it('still reads timers written by older versions', () => {
    const legacy = renderService(spec, true)
    expect(legacy).toContain(LEGACY_MANAGED_HEADER)
    expect(renderTimer(spec, true)).toContain('Description=Zeitplan: Backup')
    expect(specFromService(legacy)).toEqual(specFromService(renderService(spec)))
  })

  it('labels old German and new English history entries alike', () => {
    expect(commitLabel('web.container changed')).toBe('web.container geändert')
    expect(commitLabel('web.container angelegt')).toBe('web.container angelegt')
    expect(commitLabel('Initial state')).toBe('Ausgangszustand')
    expect(commitLabel('Auto-update for all containers off')).toBe('Auto-Update für alle Container aus')
    setLangResolver(() => 'en')
    expect(commitLabel('web.container gelöscht')).toBe('web.container deleted')
    expect(commitLabel('Ausgangszustand')).toBe('Initial state')
    delete (globalThis as { __quadeckLang?: unknown }).__quadeckLang
  })

  it('marks boot entries in English', () => {
    expect(kernelEntry('title   Arch Linux\nlinux   /vmlinuz-linux\n', 'linux-lts').split('\n')[0]).toBe('# Created by Quadeck')
  })
})
