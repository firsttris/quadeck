# Terminal

**Terminal** (in the sidebar under *Server*) is a shell on the server in the browser – like SSH,
without a client – and a shell inside running containers (`podman exec`). It is the most powerful
thing Quadeck can do, so it is **off by default** and bound to the unlock.

## Switching it on

The page shows a settings card while it is off:

- **Switch the terminal on.** Opening a session needs the [unlock](security.md#unlock) like every
  change; saving the settings does too.
- **Home network only** (on by default): requests from public addresses are refused – also typing
  into a session that is already open. Loopback, private IPv4 (10/8, 172.16/12, 192.168/16),
  100.64/10 (CGNAT, Tailscale), link-local and IPv6 ULA (fc00::/7) count as home network, so a VPN
  like WireGuard or Tailscale works. Behind a reverse proxy the address comes from
  `X-Forwarded-For`, but only from a [trusted proxy](security.md#requests).
- **End after time without input**: 15 minutes, 1 hour or 4 hours. Only typing counts – a running
  `htop` alone does not keep a session open.

Switching it off ends every open session.

## Sessions

- **+ New session** opens a shell **as the account that unlocked** (with `runuser -l`, so with that
  account's login shell and environment, as after an SSH login). Root only through `sudo`. In the
  unlock modes without a system account (Quadeck password, no unlock) it is the first administrator
  account.
- **Shell in the container** in a running container's **⋯** menu on the [Units page](quadlets.md)
  opens a tab with `podman exec -it <container>` – `bash` if the image has it, else `sh`. Container
  shells run through the root helper (rootful Podman). `Ctrl-P Ctrl-Q` is passed to the program
  instead of detaching.
- Tabs keep running when you switch tabs or leave the page; coming back reattaches them with the
  last 128 KiB of their screen. A lost connection shows **reconnect**.
- Font size, full screen; copy by selecting, paste with Ctrl+Shift+V.
- On a phone a bar adds **Esc, Ctrl, Tab and the arrow keys** that phone keyboards lack (Ctrl applies
  to the next key).
- At most 8 sessions per unlock.

A session ends when its program exits (`exit`), when it is closed (×), after the time without
input, when the terminal is switched off, and when you **lock** – locking ends all sessions of
that unlock. The unlock simply running out does not end a session that is in use.

## What is logged

The helper writes to the journal (`journalctl -u quadeck-helper`) who opened which terminal, when it
ended and why (exit code, time without input). **What is typed is never logged or stored** – the
128 KiB of screen live only in memory for reconnecting and are gone with the session.

## How it works

The root helper runs the shell in a pseudo terminal (Bun's built-in PTY support). Its output goes
to the web app as server-sent events over the helper's Unix socket and on to the browser
([xterm.js](https://xtermjs.org)); keystrokes go back in small batches as ordinary POST requests with
the CSRF token. A terminal can only be read, typed into or closed by the login session that opened
it, and its id is a random 192-bit value.

The [demo](development.md) never starts a process: it answers with a pretend shell.

## Not for the internet

If Quadeck is reachable from the internet, leave the terminal off or keep *home network only* on
and reach it through a VPN. Anyone with your Quadeck login **and** an administrator password could
otherwise get a shell.
