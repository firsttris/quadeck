# Development

Requires [Bun](https://bun.sh/) 1.3 or newer. Everything else is installed with `bun install`.

```bash
git clone https://github.com/firsttris/quadeck
cd quadeck
bun install
QUADECK_DATA_DIR=.data QUADECK_FIXTURES=fixtures/demo bun run dev   # http://localhost:3000
bun run typecheck
bun run test          # Vitest, under the Bun runtime because of bun:sqlite
bun run test:e2e      # Playwright against the production build with the demo fixtures
bun run build         # Vite build into dist/
bun run start         # run dist/ without compiling
bun run compile       # single binary for this platform into release/
```

With `QUADECK_FIXTURES=fixtures/demo` every collector and every helper backend reads the host from
JSON files instead of the machine: a Fedora NAS with eight containers, failed units, timers, SMART
data, shares, SSH keys and a network. Changes you make (a new timer, a share, a notification
channel) live in memory until the process restarts. `QUADECK_UNLOCK=quadeck` makes the unlock use
the Quadeck password, so no root is needed anywhere. Without fixtures, `bun run dev` reads the real
host and needs root for the helper parts (or run `sudo quadeck helper` from a compiled binary next
to it).

The first start prints the setup link; the setup token is in `.data/setup-token`.

## Architecture

```
src/main.ts                   binary entry: CLI (serve, helper, job, update, …), Bun.serve, static assets
src/unit-file.ts              the two systemd units printed by `quadeck print-unit`
src/server/
  hub.ts                      runs the collectors on their intervals, builds the Snapshot, pushes it over SSE
  collectors/                 system, gpu, disks, podman, systemd, shares: read-only host data
  registry.ts                 merge: Caddy route → container → unit → labels → overrides → service tiles
  providers/caddy.ts          service discovery from Caddy (admin API, caddy adapt, Caddyfile reader)
  metrics.ts                  metric history in SQLite (30 s samples, 7 days; SMART hourly, 1 year)
  health.ts                   HTTP probes
  notify.ts                   notification evaluation and delivery
  auth.ts, http.ts, guard.ts  login, sessions, CSRF, rate limit, read-only guard
  privileged/                 the Privileged interface: LocalPrivileged (root / fixtures), HelperClient (socket),
                              helper-server.ts (routes), gate.ts (unlock), crypt.ts (shadow check)
  packages/                   package managers, AUR, image updates, jobs (systemd-run or spawn), `quadeck job`
  quadlets/                   Quadlet files, generator dry run, git history, Podman settings, compose import
  systemd/editor.ts           unit files, overrides, systemd-analyze verify, history
  timers/backend.ts           timers list, own timers, schedule overrides
  shares/, ssh/, smart/, files/, network/   one backend each, System* for the host and Fixture* for demo data
  db/                         Drizzle schema, generated migrations
src/shared/                   types and pure logic used by server and UI: ini editing, quadlet keys,
                              timers (schedule builder, cron), unit-files, notify, network, smart assessment
src/routes/_app/*.tsx         pages; src/routes/api/**  server routes (TanStack Start)
src/components/               UI: editors, dialogs, charts, grid, jobs, unlock
src/lib/                      client helpers: api, formatting, diff, palette
fixtures/demo/                the demo host
tests/                        Vitest;  e2e/  Playwright
scripts/                      compile.ts (binaries), start.ts, gen-migrations.ts
```

### The Privileged interface

Every root action is a method on `Privileged` (`src/server/privileged/actions.ts`). Two
implementations: `LocalPrivileged` does the work in-process (when Quadeck runs as root, or with
fixtures) and `HelperClient` sends the same call over the Unix socket to `quadeck helper`, which
runs `LocalPrivileged` behind `helper-server.ts`. Adding an action means: a method on the interface,
the implementation in a backend (`System*` and `Fixture*`), a route in `HELPER_ROUTES` with input
validation, the client method, and `this.gate.check(token)` for anything that writes.

### Snapshot and live updates

`hub.ts` runs each collector on its own interval (system every 2 s, Podman and systemd every 5 s,
disks, Caddy and shares every 30 s, SMART every 30 min), merges the results into one `Snapshot`
and pushes changes to the browser over Server-Sent Events (`/api/events`). Pages that need more
than the snapshot (packages, SMART details, timers, network) fetch their own `/api/*` route.

### Database

SQLite through `bun:sqlite` and Drizzle, in `QUADECK_DATA_DIR/quadeck.db` (WAL). It stores only
what you decided (password, sessions, layout, overrides, links, settings, notification state) and
the metric history; everything discovered is recomputed live. Schema changes: edit
`src/server/db/schema.ts`, then `bun run db:generate`; migrations run at startup.

## Tests

| Area | What is tested |
|---|---|
| parsers | `busctl`/`systemctl show`, Podman API, Caddy configs, `/proc` and sysfs, `smartctl --json`, `ss`, `ip`, firewalld/ufw, pacman/apt/dnf/… output, `systemd-analyze` output |
| pure logic | service merge and overrides, layout merge, INI editing, Quadlet lint, compose import, schedule builder and cron conversion, unit file rendering and quoting, SMART assessment, notification rules, firewall verdicts |
| backends | fixture backends end to end; real `systemd-analyze verify`/`calendar` and `smartctl` where installed; shares with `testparm`/`exportfs` in a temp dir; SSH keys and drop-ins; file jobs with real `cp`/`mv`/`rm` |
| helper | socket server with the unlock gate and the system password check |
| auth | setup token, argon2 login, sessions, CSRF, rate limit |
| E2E | Playwright against the production build with fixtures: setup and login, dashboard, units and actions, Quadlet editor, system page and jobs, disks and files, shares, SSH, timers, unit editor, network, notifications |

`bun run test` runs the unit tests (about 215), `bun run test:e2e` the Playwright suite (about 40
tests). CI runs both plus the four binary builds and a smoke test of the musl binary on Alpine.

## Releases

A release is a tag. Set the version in `package.json`, commit, tag `vX.Y.Z` with the same number
and push the tag:

```bash
git tag v0.4.0 && git push origin v0.4.0
```

The release workflow checks that the tag matches `package.json`, runs typecheck and tests, builds
`quadeck-linux-x64-baseline`, `-arm64`, `-x64-musl` and `-arm64-musl` with `bun build --compile`,
writes `SHA256SUMS` and publishes everything together with `install.sh` as a GitHub release with
generated notes. `quadeck update` and `install.sh` pick the newest release from there.

## Conventions

- Strict TypeScript, no `any`; shared logic goes to `src/shared` so the UI and the server use the
  same validation.
- Processes are started with `run([...argv])` from `src/server/exec.ts`, never through a shell.
- Everything a backend writes is validated with the tool that will read it (`testparm`,
  `exportfs`, `sshd -t`, `systemd-analyze verify`, the Quadlet generator), keeps a backup or a
  history, and is rolled back when the tool refuses.
- Every feature has a `Fixture*` backend so it can be seen and tested without the real host.
- UI texts exist in German and English; code comments and documentation are English.
  - Components take their texts from `useT()` (`src/i18n`): one namespace file per area
    (`src/i18n/units.ts` …) with `de` defining the shape and `en: typeof de` – tsc reports a
    missing translation. Interpolations are functions (`removed: (n: string) => …`).
  - Code outside of components (`src/shared`, `src/server`, `src/lib`) uses
    `tr('Deutsch', 'English')` from `src/shared/i18n.ts`. In a request it answers in the
    viewer's language (cookie `qd_lang`, else `Accept-Language`); in the root helper and in
    background work it returns both, marked, and JSON responses, the event stream and
    notifications pick the language at the end. Never call `tr()` at module top level.
  - `e2e/i18n.spec.ts` walks every page in English and fails on German leftovers.
