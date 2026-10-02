// Discovery providers (Caddy today; Traefik and others later) return
// candidates: a public URL plus the upstreams it proxies to.

export interface ServiceCandidate {
  host: string // jellyfin.example.de
  url: string // https://jellyfin.example.de/optional-path
  upstreams: string[] // dial addresses: "jellyfin:8096", "localhost:8096"
  provider: string
}

export interface DiscoveryProvider {
  name: string
  discover(): Promise<ServiceCandidate[]>
}
