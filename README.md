<div align="center">

<img src="docs/banner.png" alt="Quadeck: the dashboard for a Podman home server" width="900">

**The dashboard for a Podman home server.**<br>
See and run your containers, Quadlets, systemd, disks, shares and updates in one place.<br>
One binary on the host. No container, no socket mounts, nothing to configure.

[![CI](https://github.com/firsttris/quadeck/actions/workflows/ci.yml/badge.svg)](https://github.com/firsttris/quadeck/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/firsttris/quadeck?logo=github&label=release)](https://github.com/firsttris/quadeck/releases/latest)
[![Platforms](https://img.shields.io/badge/platform-x64%20%7C%20arm64%20%7C%20musl-lightgrey)](https://github.com/firsttris/quadeck/releases/latest)
[![Bun](https://img.shields.io/badge/built%20with-Bun-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![Podman](https://img.shields.io/badge/Podman-Quadlets-892ca0?logo=podman&logoColor=white)](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)

```bash
curl -fsSL https://raw.githubusercontent.com/firsttris/quadeck/main/install.sh | sudo sh
```

[Install](#-install) •
[Features](#-features) •
[Screenshots](#-screenshots) •
[Documentation](docs/README.md) •
[Development](#️-development)

<img src="docs/screenshot-dashboard.png" alt="Quadeck overview: CPU, RAM, temperature and network with history, the services discovered from Caddy and Quadlets, storage with SMART status" width="900">

</div>

## 💡 Why Quadeck?

Cockpit is a full server console, Portainer wants Docker, and most homelab dashboards are link
pages that know nothing about the machine behind them. A Podman server with Quadlets already has
what it needs: systemd runs the containers, Caddy publishes them, the package manager updates the
host. Quadeck puts all of it in one place where you can also act on it.

- **Zero config**: install, open the page, and the dashboard is already filled. Services, URLs and
  icons come from Caddy, Podman and your Quadlet files.
- **systemd stays in charge**: a container with a Quadlet unit is always started and stopped
  through systemd, never behind its back.
- **Root in a separate process**: the web app runs unprivileged. A small root helper with a fixed
  list of actions does the rest, and only after you unlock it with your password.

## 🚀 Install

On the server (x64 or arm64, glibc or musl):

```bash
sudo systemctl enable --now podman.socket
curl -fsSL https://raw.githubusercontent.com/firsttris/quadeck/main/install.sh | sudo sh
```

The script downloads the right binary, verifies its checksum, sets up the two systemd services and
prints a link like **http://\<host\>:8484/setup?token=…**. Open it and set your admin password.
That's it.

Update later with `sudo quadeck update`. Manual installation, environment variables, running behind
a reverse proxy and uninstalling are in the [installation guide](docs/installation.md).

> [!WARNING]
> Quadeck is made for your LAN. Do not expose it to the internet without a VPN or a reverse proxy
> with its own authentication in front of it.

## ✨ Features

| | |
|---|---|
| 📊 **Overview** | CPU, RAM, temperature, network and GPU with history; failed units with the reason and a restart button; service tiles with health checks |
| 📦 **Containers & Quadlets** | Units with status and journal, a Quadlet editor (form or text) checked by the real generator, templates, docker-compose import |
| ⚙️ **systemd & timers** | Edit any unit through overrides, verified before saving; timers with a schedule builder as the cron replacement |
| ⬆️ **Updates** | pacman (with AUR), apt, dnf, zypper, apk, rpm-ostree and container images as live jobs; reboot hints and Arch news |
| 🥾 **Boot** | Reboot, boot once into another entry, edit systemd-boot entries safely (copy, test once, then make it the default), second kernel on Arch |
| 💽 **Disks** | SMART health with plain advice and a year of history, an fstab editor that checks every change, a small file explorer |
| 🌐 **Network & reverse proxy** | Interfaces, ports with the container behind them, firewall; Caddy domains added and changed from a list |
| 🔐 **Users, shares & SSH** | Accounts and groups, SMB and NFS shares, SSH keys and hardening with a lock-out guard |
| 🔔 **Notifications** | ntfy, Gotify, Telegram, e-mail or webhook when something fails, a disk fills up or updates are waiting |

Plus: hardware details (memory slots, GPU passthrough lines, stable USB paths), a command palette
(<kbd>Ctrl</kbd>+<kbd>K</kbd>), English and German, a read-only mode and an unlock that expires after
15 minutes. Every page is described in the [documentation](docs/README.md).

## 📸 Screenshots

<table>
  <tr>
    <td width="50%"><a href="docs/quadlets.md"><img src="docs/screenshot-quadlets.png" alt="Quadlet editor: jellyfin.container as a form with image, ports, volumes and environment"></a><br><sub><b>Quadlet editor</b> – form and text on the same file</sub></td>
    <td width="50%"><a href="docs/updates.md"><img src="docs/screenshot-system.png" alt="Updates: Arch news, pacman and AUR updates with a reboot hint, container images"></a><br><sub><b>Updates</b> – packages, AUR and container images</sub></td>
  </tr>
  <tr>
    <td><a href="docs/updates.md"><img src="docs/screenshot-boot.png" alt="Boot and reboot: systemd-boot entries, boot loader, kernels"></a><br><sub><b>Boot</b> – entries, one-time boot, kernels</sub></td>
    <td><a href="docs/network.md"><img src="docs/screenshot-proxy.png" alt="Reverse proxy: Caddy domains and their targets"></a><br><sub><b>Reverse proxy</b> – Caddy domains as a list</sub></td>
  </tr>
  <tr>
    <td><a href="docs/disks.md"><img src="docs/screenshot-disks.png" alt="Disks: SMART verdict and advice per disk"></a><br><sub><b>Disks</b> – SMART with advice</sub></td>
    <td><a href="docs/systemd.md"><img src="docs/screenshot-timers.png" alt="Timers: schedule, next and last run, result and command"></a><br><sub><b>Timers</b> – the cron replacement</sub></td>
  </tr>
</table>

## 🛠️ Development

Requires [Bun](https://bun.sh/) 1.3 or newer.

```bash
git clone https://github.com/firsttris/quadeck && cd quadeck
bun install
QUADECK_DATA_DIR=.data QUADECK_FIXTURES=fixtures/demo bun run dev   # http://localhost:3000 with demo data
```

Bun, TanStack Start (React), Tailwind, SQLite with Drizzle, Vitest and Playwright; one binary per
platform through `bun build --compile`. Architecture, tests and releases:
[docs/development.md](docs/development.md).

## 🤝 Contributing

Issues and pull requests are welcome. If your distribution, package manager, GPU or firewall is
handled wrong, include the output of the command Quadeck ran (the error names it). Please run
`bun run typecheck`, `bun run test` and `bun run test:e2e` before opening a pull request.

---

<div align="center">
<sub>Quadeck is not affiliated with Podman, Red Hat, systemd or Caddy. Icons come from the
<a href="https://github.com/homarr-labs/dashboard-icons">dashboard-icons</a> collection.</sub>
</div>
