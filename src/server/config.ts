// Runtime configuration. Everything has a working default (zero-config);
// environment variables only override.

const env = (k: string) => process.env[k]?.trim() || undefined

export interface Config {
  host: string
  port: number
  dataDir: string
  readonly: boolean
  podmanSocket: string
  caddyAdmin: string
  caddyfile: string
  iconsBase: string
  smbConf: string
  exports: string
  exportsDir: string
  trustedProxies: string[]
  publicHost?: string
  fixturesDir?: string
}

let cached: Config | undefined

export function config(): Config {
  if (cached) return cached
  cached = {
    host: env('QUADECK_HOST') ?? '0.0.0.0',
    port: Number(env('QUADECK_PORT') ?? 8484),
    dataDir: env('QUADECK_DATA_DIR') ?? env('STATE_DIRECTORY') ?? '/var/lib/quadeck',
    readonly: /^(1|true|yes)$/i.test(env('QUADECK_READONLY') ?? ''),
    podmanSocket: env('QUADECK_PODMAN_SOCKET') ?? '/run/podman/podman.sock',
    caddyAdmin: env('QUADECK_CADDY_ADMIN') ?? 'http://localhost:2019',
    caddyfile: env('QUADECK_CADDYFILE') ?? '/etc/caddy/Caddyfile',
    iconsBase: env('QUADECK_ICONS_BASE') ?? 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons',
    smbConf: env('QUADECK_SMB_CONF') ?? '/etc/samba/smb.conf',
    exports: env('QUADECK_EXPORTS') ?? '/etc/exports',
    exportsDir: '/etc/exports.d',
    // Reverse proxies whose X-Forwarded-For is trusted (IP prefixes), e.g. "10.88." for Caddy in rootful Podman.
    trustedProxies: (env('QUADECK_TRUSTED_PROXIES') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    // Public URL when a proxy rewrites the Host header (for the same-origin check).
    publicHost: env('QUADECK_PUBLIC_URL') ? new URL(env('QUADECK_PUBLIC_URL')!).host : undefined,
    // Development/E2E only: read host data from JSON fixtures instead of the host.
    fixturesDir: env('QUADECK_FIXTURES'),
  }
  return cached
}
