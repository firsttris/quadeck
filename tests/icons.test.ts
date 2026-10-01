import { describe, expect, it } from 'vitest'
import { imageSlug, matchIcon, parseIconIndex, slugCandidates } from '~/server/icons'

describe('icons', () => {
  it('derives slugs from image names', () => {
    expect(imageSlug('docker.io/jellyfin/jellyfin:latest')).toBe('jellyfin')
    expect(imageSlug('ghcr.io/immich-app/immich-server:release')).toBe('immich-server')
    expect(imageSlug('lscr.io/linuxserver/qbittorrent@sha256:abc')).toBe('qbittorrent')
    expect(imageSlug('registry:5000/team/app:1.2')).toBe('app')
  })

  it('builds candidates incl. aliases and stripped suffixes', () => {
    expect(slugCandidates({ image: 'ghcr.io/immich-app/immich-server:release' })).toContain('immich')
    expect(slugCandidates({ host: 'ha.example.de' })[0]).toBe('home-assistant')
    expect(slugCandidates({ host: 'bitwarden.example.de' })[0]).toBe('vaultwarden')
    expect(slugCandidates({ host: '192.168.1.1' })).toEqual([])
    expect(slugCandidates({ unit: 'paperless.service' })[0]).toBe('paperless-ngx')
  })

  it('matches against the collection index and its aliases', () => {
    const idx = parseIconIndex({ svg: ['jellyfin.svg', 'immich.svg'], png: ['foo.png'] }, { immich: { aliases: ['Immich Photos'] }, bar: { aliases: 'x' } })
    expect(matchIcon(idx, ['immich-server', 'immich'])).toBe('immich')
    expect(matchIcon(idx, ['immich-photos'])).toBe('immich')
    expect(matchIcon(idx, ['foo'])).toBe('foo')
    expect(matchIcon(idx, ['nope'])).toBeUndefined()
    expect(parseIconIndex(null).svg.size).toBe(0)
  })
})
