# Installation

Quadeck is one static binary that runs directly on the host. There is no container image on
purpose: the dashboard needs the Podman socket, D-Bus, the journal, `/proc`, `/sys`, the package
manager and several config files, and mounting all of that into a container would give the
container more access than the two hardened services get.

## Requirements

- Linux on **x64 or arm64**, glibc 2.17+ or musl (Alpine needs `libstdc++` and `libgcc`; the
  install script adds them).
- **systemd** for services, timers, the journal and Quadlets. Without systemd (Alpine, Void,
  Devuan) the dashboard runs, but those parts stay empty and the install script sets up no service.
- **Podman** with its API socket for the container view: `systemctl enable --now podman.socket`.
  Quadeck works without it, you just do not see containers. **Quadlets need Podman 4.4** or newer.
- Optional: **Caddy** for automatic service URLs, **smartmontools** for SMART, **Samba** and the
  **NFS server** for shares, **OpenSSH** for the SSH page. The pages show an install button with
  the command for your distribution when a tool is missing.

## Supported distributions

| | Distribution | Package manager | What differs |
| --- | --- | --- | --- |
| ✅ | Arch Linux, Manjaro, EndeavourOS | pacman (+ AUR helper) | nothing – kernel install and removal are Arch-only |
| ✅ | Fedora 39+ | dnf5 / dnf | no kernel management |
| ✅ | RHEL, AlmaLinux, Rocky Linux 9.2+ | dnf | no kernel management |
| ✅ | Debian 13, Ubuntu 24.04+ | apt | no kernel management |
| ✅ | openSUSE Tumbleweed, Slowroll | zypper (`dup`) | no kernel management |
| 🟡 | Debian 12, Ubuntu 22.04, Raspberry Pi OS 64-bit | apt | Podman 4.3 / 3.4: containers are shown, Quadlets are not generated (needs 4.4) |
| 🟡 | Fedora Atomic: Silverblue, Kinoite, CoreOS, uCore | rpm-ostree | packages are layered and active after a reboot; packages can't be removed |
| 🟡 | openSUSE MicroOS, Aeon, Kalpa | transactional-update | installs, removals and upgrades go into a new snapshot, active after a reboot |
| 🟡 | Alpine, Devuan, other systems without systemd | apk / apt | no units, timers, journal or Quadlets; the file explorer copies without reflink |
| 🟡 | Void | – | as above, and no package updates: xbps is not supported |
| ❌ | NixOS | – | the binary needs the standard loader (`programs.nix-ld.enable`), `/etc` and packages are declarative |
| ❌ | 32-bit ARM, RISC-V, others | – | Bun has no build for them |

✅ full feature set (start-up tested in CI), 🟡 runs with the limits shown, ❌ not supported.

### Feature matrix

| | Arch | Fedora, RHEL 9.2+ | Debian 13, Ubuntu 24.04+ | Tumbleweed | Fedora Atomic | MicroOS, Aeon | Debian 12, Ubuntu 22.04 | Alpine | Void |
|---|---|---|---|---|---|---|---|---|---|
| Overview, disks, files, network, users, SSH, terminal | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Containers (Podman) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Quadlets | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ ¹ | ❌ ² | ❌ ² |
| Units, timers, journal | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ ² | ❌ ² |
| System updates | ✅ | ✅ | ✅ | ✅ | 🟡 ³ | 🟡 ³ | ✅ | ✅ | ❌ |
| Remove packages | ✅ | ✅ | ✅ | ✅ | ❌ | 🟡 ³ | ✅ | ✅ | ❌ |
| AUR updates | ✅ | – | – | – | – | – | – | – | – |
| Install and remove kernels | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Clean up the [package cache](updates.md#package-cache) | ✅ | ✅ | ✅ | ✅ | – | – | ✅ | 🟡 ⁴ | ❌ |
| [Explained update errors](updates.md#when-a-job-fails) | ✅ | 🟡 ⁵ | 🟡 ⁵ | 🟡 ⁵ | 🟡 ⁵ | 🟡 ⁵ | 🟡 ⁵ | 🟡 ⁵ | – |
| [Boot entries](updates.md#boot-and-reboot) | 🟡 ⁶ | 🟡 ⁶ | 🟡 ⁶ | 🟡 ⁶ | 🟡 ⁶ | 🟡 ⁶ | 🟡 ⁶ | – | – |

¹ Podman older than 4.4 · ² no systemd · ³ goes into a new snapshot or deployment, active after a
reboot · ⁴ only with a local apk cache (`/etc/apk/cache`) · ⁵ full explanations for pacman and
yay/paru, for apt the lock and an interrupted dpkg; otherwise the error lines are marked and the
terminal is offered · ⁶ with systemd-boot; with GRUB the boot tab shows the reboot and the kernel
parameters only · – not applicable

Limits on every distribution:

- **Rootful Podman only.** Quadeck talks to the system socket `/run/podman/podman.sock` and edits
  Quadlets in `/etc/containers/systemd`. Rootless containers and user Quadlets
  (`~/.config/containers/systemd`) are not shown.
- **Boot entries need systemd-boot.** With GRUB the boot tab shows the reboot and the kernel
  parameters only.
- The package manager is detected from the installed tools; `QUADECK_PACKAGE_MANAGER` (`pacman`,
  `apt`, `dnf`, `zypper`, `transactional-update`, `apk`, `rpm-ostree`) overrides it.

`quadeck doctor` prints what Quadeck finds and what that means:

```text
$ quadeck doctor
System:          Debian GNU/Linux 12 (bookworm)
Architecture:    x64 (glibc)
Package manager: apt
Init:            systemd
Podman:          4.3.1  – Quadlets need Podman 4.4 or newer
Coreutils:       gnu
Boot loader:     other  – boot entries need systemd-boot (reboot and kernel parameters work)
```

CI starts the release binary in a bare container of Fedora, Debian 12 and 13, Ubuntu 22.04 and
24.04, Arch, openSUSE Tumbleweed, Rocky Linux 9, a simulated MicroOS and Alpine, and checks that it
finds the distribution and package manager and serves the web app.

## Install script

```bash
sudo systemctl enable --now podman.socket
curl -fsSL https://raw.githubusercontent.com/firsttris/quadeck/main/install.sh | sudo sh
```

The script

1. detects architecture and libc and downloads the matching binary from the latest GitHub release
   to `/usr/local/bin/quadeck`,
2. verifies its SHA-256 checksum against the `SHA256SUMS` of the release,
3. creates the system group and user `quadeck` (no home, no shell) and adds it to
   `systemd-journal` so the web app can read the journal,
4. writes `quadeck-helper.service` and `quadeck.service` to `/etc/systemd/system` (from
   `quadeck print-unit`), enables and starts both,
5. prints the setup link `http://<host>:8484/setup?token=…`.

Open the link and set the admin password. That is the Quadeck login; the unlock for server changes
uses your Linux administrator password, not this one (see [Security](security.md)).

Variables for the script: `QUADECK_VERSION=v0.3.0` installs a specific release,
`QUADECK_BIN_DIR` changes the binary location.

Running the script again on an existing installation updates the binary and the unit files and
migrates installations from before the root helper (everything ran as root then) to the two
services; the data directory is handed over to the `quadeck` user.

## Manual installation

```bash
curl -fsSLo /usr/local/bin/quadeck https://github.com/firsttris/quadeck/releases/latest/download/quadeck-linux-x64-baseline
chmod +x /usr/local/bin/quadeck
groupadd --system quadeck
useradd --system --gid quadeck --home-dir /var/lib/quadeck --no-create-home --shell /usr/sbin/nologin quadeck
usermod -aG systemd-journal quadeck
quadeck print-unit helper > /etc/systemd/system/quadeck-helper.service
quadeck print-unit web > /etc/systemd/system/quadeck.service
systemctl daemon-reload
systemctl enable --now quadeck-helper.service quadeck.service
quadeck setup-token
```

| Binary | For |
|---|---|
| `quadeck-linux-x64-baseline` | every x86-64 server, including NAS CPUs without AVX2 |
| `quadeck-linux-arm64` | Raspberry Pi 4/5, ARM servers |
| `quadeck-linux-x64-musl` | Alpine and other musl distributions |
| `quadeck-linux-arm64-musl` | Alpine on ARM |

Without systemd, start it by hand: `QUADECK_DATA_DIR=/var/lib/quadeck quadeck serve`.

## Commands

```
quadeck [serve]                 start the web app (default)
quadeck helper                  start the root helper (as root, Unix socket)
quadeck setup-token             print the token for the first setup
quadeck passwd                  reset the admin password; set a new one via /setup
quadeck update [--force]        download the newest release, verify, swap in, restart
quadeck doctor [--json]         show what Quadeck finds: distribution, package manager, Podman, init, boot loader
quadeck print-unit web|helper   print a systemd unit (used by install.sh)
quadeck version
quadeck help
```

`setup-token` and `passwd` touch the database and therefore switch to the owner of the data
directory (the `quadeck` user) when run as root, so root never creates files the web app cannot
open.

`quadeck job …` exists too; it is started by the helper for updates, installs, removals, image updates,
kernel and file jobs and not meant to be called by hand.

## Services

`quadeck print-unit web` and `quadeck print-unit helper` print the two units. In short:

| | `quadeck.service` | `quadeck-helper.service` |
|---|---|---|
| runs as | user `quadeck`, group `quadeck`, plus `systemd-journal` | root, group `quadeck` |
| state | `/var/lib/quadeck` (0700) | `/var/lib/quadeck-helper` (0700), cache in `/var/cache/quadeck` |
| socket | – | `/run/quadeck/helper.sock`, `root:quadeck` 0660 |
| hardening | `ProtectSystem=strict`, `ProtectHome=read-only`, `NoNewPrivileges`, `PrivateTmp`, kernel and cgroup protection | `PrivateTmp`, kernel protection; it must write to `/etc` and run package managers |
| environment | `/etc/quadeck/quadeck.env` (optional) | the same file |

Both restart on failure. The web app waits for the helper (`After=quadeck-helper.service`), the
helper for `podman.socket`.

## Environment variables

Put them in `/etc/quadeck/quadeck.env`, one `KEY=value` per line, then
`systemctl restart quadeck-helper quadeck`. Everything has a working default.

### Web app

| Variable | Default | Meaning |
|---|---|---|
| `QUADECK_HOST` / `QUADECK_PORT` | `0.0.0.0` / `8484` | address and port |
| `QUADECK_DATA_DIR` | `/var/lib/quadeck` | SQLite database, icon cache, setup token |
| `QUADECK_READONLY` | `false` | no changes to the server at all (units, packages, files, …); dashboard layout and links stay editable |
| `QUADECK_PODMAN_SOCKET` | `/run/podman/podman.sock` | Podman API |
| `QUADECK_CADDY_ADMIN` | `http://localhost:2019` | Caddy admin API |
| `QUADECK_CADDYFILE` | `/etc/caddy/Caddyfile` | Caddyfile for service discovery when the admin API is not reachable, and the file the reverse-proxy editor edits (otherwise detected from the Caddy Quadlet or `caddy.service`) |
| `QUADECK_ICONS_BASE` | jsDelivr CDN of dashboard-icons | where icons are fetched from |
| `QUADECK_SMB_CONF` | `/etc/samba/smb.conf` | SMB shares |
| `QUADECK_EXPORTS` | `/etc/exports` | NFS exports (plus `/etc/exports.d/*.exports`) |
| `QUADECK_TRUSTED_PROXIES` | `127.,::1` | IP prefixes of reverse proxies whose `X-Forwarded-For` is trusted, e.g. `10.88.` for Caddy in rootful Podman |
| `QUADECK_PUBLIC_URL` | – | public URL when a proxy rewrites the `Host` header (same-origin check) |
| `QUADECK_HELPER_SOCKET` | `/run/quadeck/helper.sock` | where the helper listens |

### Helper

| Variable | Default | Meaning |
|---|---|---|
| `QUADECK_UNLOCK` | `system` | `system`: Linux admin password · `none`: no unlock · `quadeck`: the Quadeck password (only when everything runs as root in one process) |
| `QUADECK_UNLOCK_MINUTES` | `15` | how long an unlock lasts |
| `QUADECK_PACKAGE_MANAGER` | detected | force `pacman`, `apt`, `dnf`, `zypper`, `transactional-update`, `apk` or `rpm-ostree` |
| `QUADECK_AUR_USER` | first member of `wheel`/`sudo` | user that runs `yay`/`paru` |
| `QUADECK_QUADLET_DIR` | `/etc/containers/systemd` | Quadlet files |
| `QUADECK_UNIT_DIR` | `/etc/systemd/system` | where own units, timers and overrides are written |
| `QUADECK_UNIT_HISTORY` | `/var/lib/quadeck-helper/unit-history` | earlier versions of edited unit files |
| `QUADECK_BOOT_HISTORY` | `/var/lib/quadeck-helper/boot-history` | earlier versions of edited boot entries |
| `QUADECK_CADDY_HISTORY` | `/var/lib/quadeck-helper/caddy-history` | earlier versions of the edited Caddyfile |
| `QUADECK_CADDY_STATE` | `/var/lib/quadeck-helper/caddy.json` | Caddyfile path picked in the UI |
| `QUADECK_FSTAB` | `/etc/fstab` | the fstab the mount editor works on |
| `QUADECK_FSTAB_HISTORY` | `/var/lib/quadeck-helper/fstab-history` | earlier versions of `/etc/fstab` |
| `QUADECK_FILE_ROOTS` | `/mnt,/srv,/media,/home,/data` + data mounts | areas the file explorer may show, comma-separated |
| `QUADECK_JOB_LAUNCHER` | `systemd-run` when available | `spawn`: run jobs as child processes instead of transient units |
| `QUADECK_HELPER_GROUP` | `quadeck` | group that may open the socket |

`QUADECK_FIXTURES` is for development only: it reads host data from JSON files instead of the host
(see [Development](development.md)).

## Updating

```bash
sudo quadeck update
```

Fetches the latest release from GitHub, compares versions, downloads the binary for this
platform, verifies the SHA-256 checksum, replaces the binary atomically and restarts the services.
`--force` reinstalls the same version. The install script does the same and additionally refreshes
the unit files, so run it after a release that changed them (the release notes say so).

## Behind a reverse proxy

Quadeck works fine behind Caddy, nginx or Traefik on your LAN. Two things to set:

- `QUADECK_TRUSTED_PROXIES`: the IP prefixes of the proxy, so the login rate limit sees the real
  client address instead of the proxy. For Caddy in rootful Podman that is the Podman network, e.g.
  `10.88.`; for a proxy on the host the default `127.,::1` is right.
- `QUADECK_PUBLIC_URL=https://quadeck.home.example`: only when the proxy changes the `Host`
  header. Quadeck compares the origin of every write request with its own host; a rewritten
  header would otherwise look like a cross-site request.

The session cookie is marked `Secure` automatically when the request arrived over HTTPS
(`X-Forwarded-Proto: https`).

> [!WARNING]
> Do not expose Quadeck to the internet without a VPN or a proxy with its own authentication. It
> controls your server; one password between the internet and `systemctl` is not enough.

## Read-only mode

`QUADECK_READONLY=true` turns off every action on the server: no unit actions, no package jobs,
no file changes, no editors. The dashboard itself (layout, links, overrides) stays editable. Useful
for a screen in the hallway or a second, unprivileged instance.

## Uninstall

```bash
systemctl disable --now quadeck quadeck-helper
rm /etc/systemd/system/quadeck.service /etc/systemd/system/quadeck-helper.service
systemctl daemon-reload
rm /usr/local/bin/quadeck
rm -r /var/lib/quadeck /var/lib/quadeck-helper /var/cache/quadeck /etc/quadeck   # data, histories, env
userdel quadeck && groupdel quadeck
```

Quadeck leaves behind what you created with it: timers and units in `/etc/systemd/system`,
overrides in `*.d/` directories, drop-ins `50-quadeck.conf` for timer schedules,
`/etc/ssh/sshd_config.d/01-quadeck.conf`, `/etc/exports.d/quadeck.exports`, your Quadlet
files, mount entries in `/etc/fstab`, boot entries it created and the edits to your Caddyfile. They keep working without Quadeck; delete what you no longer want.

## Troubleshooting

| Symptom | What to check |
|---|---|
| "Podman not reachable" | `systemctl enable --now podman.socket`; `QUADECK_PODMAN_SOCKET` if the socket lives elsewhere |
| "systemd not reachable" | the web app needs D-Bus: `busctl` must work for the `quadeck` user; inside a container this cannot work |
| no journal entries | the `quadeck` user must be in `systemd-journal` (`install.sh` does that); `systemctl restart quadeck` after changing groups |
| "Root helper not reachable" | `systemctl status quadeck-helper`; the socket must be `root:quadeck` 0660 |
| unlock refuses the password | the user must be root or in `wheel`/`sudo`; the helper reads `/etc/shadow`, so it must run as root |
| no icons | the CDN is not reachable; icons are cached in `/var/lib/quadeck/icons`, favicons and glyphs are used meanwhile |
| login blocked | after 5 failed attempts the client waits 30 s, doubling up to 15 min; the limit is per client IP (see trusted proxies) |
| forgot the password | `sudo quadeck passwd`, then open the printed `/setup` link |
