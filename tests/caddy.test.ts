import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { candidatesFromCaddyfile, candidatesFromConfig } from '~/server/providers/caddy'

const read = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')

describe('caddy JSON config', () => {
  const c = candidatesFromConfig(JSON.parse(read('caddy-config.json')))

  it('finds reverse proxies inside subroutes and keeps path prefixes', () => {
    expect(c.map((x) => x.url).sort()).toEqual(['http://lan.box:8081', 'https://fotos.example.de', 'https://fotos.example.de/api', 'https://jellyfin.example.de', 'https://namarr.example.de'])
    expect(c.find((x) => x.host === 'jellyfin.example.de')!.upstreams).toEqual(['jellyfin:8096'])
  })

  it('skips wildcard hosts and non-proxy handlers', () => {
    expect(c.some((x) => x.host.includes('*') || x.host === 'static.example.de')).toBe(false)
  })

  it('copes with an empty config', () => {
    expect(candidatesFromConfig({})).toEqual([])
  })
})

describe('Caddyfile fallback', () => {
  process.env.QD_TEST_DOMAIN = 'env.example.de'
  const c = candidatesFromCaddyfile(read('Caddyfile'))
  const by = (url: string) => c.find((x) => x.url === url)

  it('reads simple site blocks and ignores global options and snippets', () => {
    expect(by('https://jellyfin.example.de')?.upstreams).toEqual(['jellyfin:8096'])
    expect(c.some((x) => x.host === 'admin@example.de' || x.host.startsWith('('))).toBe(false)
  })

  it('handles multiple addresses, path matchers and option blocks', () => {
    expect(by('https://fotos.example.de')?.upstreams).toEqual(['immich-server:2283'])
    expect(by('https://photos.example.de')?.upstreams).toEqual(['immich-server:2283'])
    expect(by('https://fotos.example.de/api')?.upstreams).toEqual(['immich-server:2283'])
  })

  it('handles explicit scheme/port and handle_path', () => {
    expect(by('http://router.lan:8080')?.upstreams).toEqual(['192.168.1.1:80'])
    expect(by('https://apps.example.de/ha')?.upstreams).toEqual(['homeassistant:8123'])
  })

  it('skips wildcards', () => {
    expect(c.some((x) => x.host.includes('*'))).toBe(false)
  })

  it('scopes handle paths to their block (also on one line)', () => {
    expect(by('https://bar.example.com/api')?.upstreams).toEqual(['api:3000'])
    expect(by('https://bar.example.com')?.upstreams).toEqual(['web:80'])
  })

  it('resolves named host matchers in wildcard sites and {$ENV} addresses', () => {
    expect(by('https://cloud.home.example')?.upstreams).toEqual(['nextcloud:80'])
    expect(by('https://env.example.de')?.upstreams).toEqual(['envapp:1'])
    expect(c.some((x) => x.upstreams.includes('nope:1'))).toBe(false)
  })
})
