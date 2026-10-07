# Quadeck documentation

Quadeck is a dashboard for a Podman home server that runs Quadlets. It runs directly on the host as
two systemd services (an unprivileged web app and a small root helper) and shows containers, units,
disks, shares and the host itself, with the actions you need day to day.

| | |
|---|---|
| [Installation](installation.md) | install script, binaries, commands, environment variables, services, updates, reverse proxy, uninstall |
| [Overview and services](dashboard.md) | how services are discovered, labels, overrides, manual links, icons, health, layout editing, the widget catalog, metrics history, GPU, command palette |
| [Units and Quadlets](quadlets.md) | units page, actions, journal, Quadlet editor, validation, history, templates, compose import, Podman settings |
| [systemd editor and timers](systemd.md) | unit files and overrides, form and text, verification, history, new units, timers, schedule builder, cron import |
| [Updates and packages](updates.md) | package managers, AUR, reboot hints, jobs, installed packages, removal, container images, boot and reboot (systemd-boot) |
| [Hardware](hardware.md) | CPU, memory slots, GPUs, USB paths, sensors, PCIe and SATA links, warnings |
| [Users](users.md) | accounts, groups, passwords, lock, Samba password, keys, login history, lock-out guard |
| [Disks and files](disks.md) | SMART verdicts and advice, history, self-tests, usage and trend per disk, energy saving, fstab configurator and its checks, file explorer with two panes and archives, data areas |
| [Backups](backups.md) | restic: targets, what is suggested from the Quadlets, exclusions, stopping databases, schedule and retention, the password, browsing and restoring; the rest-server as backup target for clients |
| [Shares](shares.md) | SMB shares, NFS exports, services, what is checked, what is never touched |
| [SSH](ssh.md) | keys, hardening, lock-out guard, logins, connecting a new device |
| [Terminal](terminal.md) | shell on the server and in containers in the browser, off by default, home network only, what is logged |
| [Network](network.md) | interfaces, ports, firewall verdicts, routes and DNS, reverse proxy (Caddy), speed test |
| [Notifications](notifications.md) | channels, rules, how spam is avoided, retries |
| [Security](security.md) | the two processes, unlock, authentication, hardening, data and secrets |
| [Development](development.md) | setup with demo data, checks, architecture, tests, releases |

## How Quadeck works, in one minute

- **Two processes.** `quadeck.service` is the web app, running as the system user `quadeck` without
  root. `quadeck-helper.service` is a root helper with a fixed list of actions, reachable only over a
  Unix socket that the `quadeck` group can open. Everything that changes the server goes through the
  helper. See [Security](security.md).
- **Reading is free, writing needs an unlock.** Looking at units, disks, packages or shares works
  right after login. Starting, stopping, saving, installing or deleting anything first asks for the
  password of a Linux administrator (root or a member of `wheel`/`sudo`) and stays unlocked for
  15 minutes.
- **systemd is the truth.** A container that belongs to a Quadlet unit is controlled through
  systemd, never behind its back. Quadeck reads systemd over D-Bus and the journal through the
  `systemd-journal` group.
- **Zero config.** Services, their URLs and icons are discovered from Caddy, Podman and the Quadlet
  files. Labels in the Quadlet file and overrides in the UI only refine what was found.
- **Nothing is deleted silently.** Config files Quadeck edits (`smb.conf`, `exports`, `sshd` drop-ins,
  unit files, Quadlet files, `/etc/fstab`, the Caddyfile, boot entries) are checked with the respective tool before they are written, keep a
  backup or a history, and are rolled back when the tool refuses.

## Which page does what

The navigation is grouped into *Services*, *Storage* and *Server*. On a
phone it folds into a menu behind the button at the top left; the bar keeps search, a running job
and the unlock countdown in reach.

| Page | Group | Content |
|---|---|---|
| **Hardware** | host card in the sidebar | CPU, memory, GPUs, USB, sensors, PCIe/SATA links |
| **Overview** | | gauges with history, failed units, services, storage, timers, shares |
| **Units** | Services | services, timers and containers with actions; the *Timers* filter is the schedule editor; from here the Quadlet and systemd editors open |
| **Journal** | Services | `journalctl` live, per unit and priority, searchable |
| **Disks** | Storage | SMART verdicts, history, self-tests; mounting disks via `/etc/fstab` |
| **Files** | Storage | file explorer for the data areas |
| **Shares** | Storage | SMB and NFS |
| **Network** | Server | interfaces, ports, firewall, reverse proxy (Caddyfile), speed test |
| **Users** | Server | accounts, groups, passwords, Samba, keys |
| **SSH** | Server | keys, hardening, logins |
| **System** | Server | updates, installed packages, Podman settings, boot and reboot |
| **Notifications** | Server | channels and rules |

The UI is in German and English. It follows the browser's language; the switch at the bottom of
the sidebar (and on the login page) overrides it and is remembered in a cookie. E-mails and push
messages use the language last picked there. The documentation uses the English labels.

**Animations** at the bottom of the sidebar (also in the command palette) set how much moves, per
browser, like in SnapRAID UI and the CCU add-on:

| | |
|---|---|
| **Off** | nothing moves; spinners still turn |
| **Subtle** (default) | the page fades in, the marker of the current page slides in, dialogs open softly, gauges and bars glide to new values, charts draw in; only warnings and errors pulse |
| **Strong** | everything rises in one after the other, the current page glows in the navigation and entries move on hover, widgets and tiles light up and lift on hover, bars shimmer, status lights breathe, a running job glows |

Without a choice, the system's *reduce motion* setting means **Off**. In the overview's edit mode
widgets never move by themselves, so dragging and resizing stay precise.
