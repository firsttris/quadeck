# Overview and services

The overview (**Overview**) is the start page: gauges for the host, failed units, the service
tiles, storage, the next timers and your shares. Everything on it is discovered; the layout, the
tiles and the links are the only things you edit.

<img src="screenshot-dashboard.png" alt="Overview with failed units, gauges and service tiles" width="900">

## How services are discovered

A service tile needs a name, a URL, an icon and a health state. Quadeck collects them from several
places and merges them in a fixed order; later sources override earlier ones.

1. **Caddy** supplies the public URL of every service. Quadeck reads Caddy's configuration from the
   admin API (`GET /config/` on `http://localhost:2019`), otherwise through `caddy adapt`, otherwise
   with its own Caddyfile reader (for Caddy inside a container, where the admin API is not reachable
   from the host). Every route with a host and a reverse proxy becomes a candidate.
2. **Containers**: the upstream of the route (`jellyfin:8096`, `localhost:8096`, `10.88.0.5:8096`)
   is matched to a Podman container by container name, network alias, container IP or published
   port. Targets that do not match a container stay as external tiles; nothing is guessed.
3. **Unit**: the label `PODMAN_SYSTEMD_UNIT` that Quadlet sets on every container links it to its
   unit, so the tile knows its journal and can be restarted through systemd.
4. **Labels in the Quadlet file** refine or override the discovery:

   ```ini
   [Container]
   Label=quadeck.name=Jellyfin
   Label=quadeck.group=Media
   Label=quadeck.icon=jellyfin          # slug from dashboard-icons, or glyph:play
   Label=quadeck.url=https://jf.example.de
   Label=quadeck.hidden=true
   ```

   A container with `quadeck.url` but no Caddy route gets a tile too. Only `http(s)` URLs are
   accepted.
5. **Overrides** from the UI (name, group, URL, icon, pinned, hidden) have the highest priority.
   Empty fields keep following the discovery.

Names come from the label, the container name or the Caddy host, in title case. Groups come from
`quadeck.group`, otherwise from a built-in list of known applications (media, downloads, home
automation, …); everything else lands in *Apps*, manual links in *Links*.

### Manual links

Devices without a Quadlet (router, printer, another host, a NAS) are added with **Add link**
on the services card: name, URL, group, icon (with the same search over dashboard-icons as when editing) and whether the URL is health-checked. They live in
the same card as the discovered services and are edited in the same dialog.

### Editing a service

In edit mode (**Edit** or the `E` key) a click on a tile opens **Edit <name>**: name,
group, URL and icon (with a search over the dashboard-icons collection) override the discovery,
empty fields follow it. Tiles can be pinned (always first in their group) and hidden; hidden
services are listed in the edit bar so they can be shown again.

### Icons

Icons come from [dashboard-icons](https://github.com/homarr-labs/dashboard-icons). Candidates are
built from the image name, the unit name and the Caddy host, including aliases such as `ha` →
`home-assistant`. Icons are cached under `/var/lib/quadeck/icons`, so the dashboard works offline
after the first load. Without a hit, the favicon of the service is used, then a neutral category
glyph. `quadeck.icon=glyph:name` forces one of the built-in glyphs.

### Health

A running container with a Podman healthcheck shows that result (healthy, unhealthy, starting).
Without a healthcheck, Quadeck sends `HEAD` to the service URL every 60 seconds; when the public
URL is not reachable from the server itself (split DNS), the direct upstream from the Caddy route is
probed instead. Manual links are probed unless health checking is switched off for them. A stopped
container is "bad" regardless of the probe.

## Gauges and history

CPU, RAM, CPU temperature, network and GPU show the current value in a ring and the last hour as
a sparkline. A click opens the detail view with 1 h, 6 h, 24 h or 7 days, values under the mouse
and min/average/max. Samples are stored every 30 seconds in SQLite and kept for seven days; gaps
show when Quadeck was not running.

### GPU

The GPU card appears when a graphics card is detected; no root is needed for it.

| GPU | Source | Values |
|---|---|---|
| NVIDIA | `nvidia-smi` | utilisation, VRAM, temperature, power, clock |
| AMD (amdgpu) | sysfs | utilisation, VRAM, temperature, power |
| Intel (i915, xe) | sysfs | clock relative to the maximum clock (a real utilisation is only readable by root), VRAM on Arc |

### Temperature

The CPU temperature comes from hwmon (`coretemp`, `k10temp`, `cpu_thermal` on ARM). Without a
sensor the card says so instead of showing zero.

## Failed units

Units in the `failed` state appear at the top of the overview with the reason systemd recorded:
OOM kill with the memory limit that was hit, exit code, signal, timeout, start limit. **Restart**
restarts the unit through systemd after a confirmation; **Show journal** opens its journal.

## Storage card

Every mounted data file system with usage, and for every disk the SMART verdict as a dot (green,
yellow, red; grey for disks without SMART). The dot links to the [disks page](disks.md).

## Timers card

The next six active timers with their schedule in plain words and the time until the next run; a
red dot means the last run of the triggered service failed. **All** opens the timer editor on the
[units page](systemd.md#timers).

## Layout editing

The overview starts with a finished layout. **Edit** (or `E`) edits it on two levels:

- **Cards** (CPU, RAM, temperature, network, GPU, services, storage, timers, shares): drag by the
  handle, resize at the bottom-right corner, hide and show again. The metric cards (CPU, RAM,
  temperature, network, GPU) can be made as small as two columns and square: the ring and the
  text get more compact in narrow cards, and the history chart fills whatever height the card has.
- **Tiles** inside the services card: move and resize within their group, for example Jellyfin
  as a 2×2 tile. The group of a tile is set by the `quadeck.group` label or the override.

The layout is stored per screen width (desktop from 960 px content width with 12 columns, tablet
with 6, phone with 1) in SQLite. Metric cards start at a fixed height; the other cards size their
height to their content until you resize them yourself. **Reset to auto layout** restores the
default.

## Command palette

**Ctrl+K** (⌘K) or **Search** in the sidebar: open services, jump to pages, restart or stop units
(with the usual confirmation) and open their journal. Typing filters across all of it.

## Journal

The **Journal** page streams `journalctl` live: filter by unit (the units of the overview are
offered as chips), by priority (errors, warnings, everything) and by text. The journal link on a
unit, a tile or a failed unit opens the page already filtered.
