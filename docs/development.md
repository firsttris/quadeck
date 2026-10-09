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
data, shares, SSH keys and a network. Changes to the host (a new timer, a share) live in memory
until the process restarts; what Quadeck stores itself (layout, links, notification channels, speed
tests) goes to the database in `.data`. `QUADECK_UNLOCK=quadeck` makes the unlock use
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
  shares/, ssh/, smart/, files/, network/, fstab/, boot/, users/, hardware/, caddy/
                              one backend each, System* for the host and Fixture* for demo data
  speedtest.ts                speed test (Cloudflare), automatic runs, history
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
| E2E | Playwright against the production build with fixtures: setup and login, dashboard, units and actions, Quadlet editor, system page and jobs, disks and files, shares, SSH, timers, unit editor, network, notifications, reverse proxy, mounts, boot, users, hardware, metrics, speed test, English scan |

`bun run test` runs the unit tests (about 320), `bun run test:e2e` the Playwright suite (about 60
tests). CI runs both plus the four binary builds and smoke tests of the glibc binary and of the musl
binary on Alpine. The E2E files share one server and run one after the other, so CI splits them by
file across three runners (`--shard`), each with its own server; `e2e/global-setup.ts` sets the
password on the shards that do not start with `dashboard.spec.ts`, which tests the first start.

## Releases

A release is a tag `vX.Y.Z`, as in the other projects
([firsttris/workflows](https://github.com/firsttris/workflows)). Either way creates it:

- without a checkout: Actions → *Bump version* → patch, minor or major (`bump.yml`) raises the
  version in `package.json`, commits it as `Release vX.Y.Z` on `main`, tags it and starts the
  release workflow on the tag;
- on a checkout: `bun run release:patch` (or `:minor`, `:major`) does the same and pushes commit and
  tag.

The release workflow runs typecheck and tests, builds
`quadeck-linux-x64-baseline`, `-arm64`, `-x64-musl` and `-arm64-musl` with `bun build --compile`,
writes `SHA256SUMS` and publishes everything together with `install.sh` as a GitHub release with
generated notes, after checking that the tag matches `package.json`. `quadeck update` and `install.sh` pick the newest release from there.

## Screenshots

The pictures in `docs/` come from the demo data, in English, through `scripts/screenshots.mjs`.
It sets the password, restarts the two failed demo units for a healthy overview, and writes
`docs/screenshot-*.png` and the social preview. `bun run screenshots` (`scripts/screenshots.sh`)
builds, starts the demo with a fresh data directory, runs the script and stops the demo again;
`CHROMIUM_PATH=/usr/bin/chromium bun run screenshots` uses a local Chromium.

After a change to the look, run **Update screenshots** (Actions → Run workflow,
`.github/workflows/screenshots.yml`) on the branch: it takes the pictures in the official
Playwright image and commits the ones that changed.

## Documentation website

`docs/` is also published as a website at <https://firsttris.github.io/quadeck/>, built with
MkDocs Material (`mkdocs.yml`) by `.github/workflows/docs.yml` on every push to `main` that touches
the docs. The pages stay plain Markdown that reads the same on GitHub: relative links, images as
`<img>` with relative paths. A new page also goes into `nav` in `mkdocs.yml`. Locally:

```sh
pip install -r requirements-docs.txt
mkdocs serve          # http://127.0.0.1:8000, reloads on save
mkdocs build --strict # what CI runs: broken links fail the build
```

## Conventions

- Strict TypeScript, no `any`; shared logic goes to `src/shared` so the UI and the server use the
  same validation.
- Processes are started with `run([...argv])` from `src/server/exec.ts`, never through a shell.
- Everything a backend writes is validated with the tool that will read it (`testparm`,
  `exportfs`, `sshd -t`, `systemd-analyze verify`, the Quadlet generator), keeps a backup or a
  history, and is rolled back when the tool refuses.
- Every feature has a `Fixture*` backend so it can be seen and tested without the real host.
- Colors come from the theme variables in `src/styles.css`, never as fixed values: `bg-panel`,
  `border-rim`, `text-accent`, `bg-accent/10` in classes, `var(--color-accent)` in inline styles
  and SVG attributes. The themes (`src/lib/theme.ts`) redefine surfaces, borders, accent, the
  second chart color (`accent-2`) and glow; ok, warning and error (`ok`, `warn`, `bad`) stay the
  same in every theme. `tests/theme.test.ts` fails on a default palette color in a component and
  checks the contrast of every theme; a new theme needs a block in `styles.css` and a swatch.
- UI texts exist in German and English ([Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs));
  code comments and documentation are English.
  - All texts live in `messages/de.json` and `messages/en.json` (inlang message format).
    `bun run i18n` compiles them to typed functions in `src/paraglide` (git-ignored; the Vite
    plugin, `typecheck` and `test` do it too). Keys are `area_group_name` in lowerCamelCase
    segments (`fstab_error_deviceMissing`, `proxy_confirm_save`), placeholders say what goes in
    (`{path}`, `{reason}`, `{count}`);
    plurals use `plural` variants, yes/no variants a selector on an input passed as `'true'`/`'false'`,
    numbers can be formatted per language (`local x = value: number …`).
  - Components call the messages directly: `m.units_title()`, `m.proxy_errors_exists({ a, line })`
    (`import { m } from '~/paraglide/messages'`). A key chosen at runtime goes through
    `pickMsg({ ok: m.x_ok, failed: m.x_failed }, status)`, text around React elements through
    `rich(m.key, { file: <code>…</code> })`.
  - Code outside of components (`src/shared`, `src/server`, `src/lib`) uses
    `msg(m.proxy_errors_exists, { a, line })` from `src/shared/i18n.ts`. Messages are always
    named statically (`m.key`, never by a key string), so the browser bundle carries only the
    messages its pages use; the table from key to message is registered on the server only
    (`src/server/lang.ts`). In a request it answers in the viewer's language (cookie `qd_lang`, else
    `Accept-Language`); in the root helper and in background work it returns the key and its
    inputs (marked), and JSON responses, the event stream and notifications render it in the
    right language at the end – inputs can be messages themselves. Never call `msg()` at module
    top level.
  - `tests/i18n.test.ts` checks that both files have the same keys and placeholders, nothing is
    empty, every message is used and every key used exists.
  - `e2e/zz-i18n.spec.ts` walks every page in English and fails on German leftovers.
  - Only the UI is bilingual. Everything Quadeck writes for the system is English: comments and
    headers in files it writes (drop-ins, timers, boot entries, exports, sudoers), Git messages of
    the Quadlet history, systemd descriptions, log lines and the CLI. Where Quadeck recognises its
    own files again, it also accepts the German markers older versions wrote.
