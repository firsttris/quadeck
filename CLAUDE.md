# Notes for Claude

## Documentation

The documentation is in `docs/` (<https://firsttris.github.io/quadeck/>). Read the pages that touch
the change before starting: `development.md` for the architecture, the tests and the conventions,
`security.md` for the two processes and the unlock, and the page of the area you change
(`quadlets.md`, `backups.md`, `disks.md`, …). Links in the README and the docs point to the GitHub
Pages site, not to `docs/*.md`; a new page also goes into `nav` in `mkdocs.yml`.

## Reference implementations

Base details on the sources, not on memory: Podman's Quadlet man page
(`containers/podman`, `docs/source/markdown/podman-systemd.unit.5.md`) for Quadlet keys, the systemd
man pages (`systemd/systemd`, `man/`) for units, timers and D-Bus, Caddy (`caddyserver/caddy`) for
the Caddyfile, restic (`restic/restic`) for backups, smartmontools for SMART output. The look and the
motion follow the sibling apps `firsttris/snapraid-ui` and `firsttris/ccu-addon-mui`. Clone them
shallowly (`git clone --depth 1`) into the scratchpad and name the source file in comments and
commit messages where it settles a detail.

## With every change

Update what the change affects, in the same pull request, and only that:

- the tests for what changed: Vitest in `tests/`, Playwright in `e2e/` (German UI, demo fixtures);
- the docs in `docs/` that describe it;
- the README when a feature a user sees is added, changed or removed;
- both `messages/de.json` and `messages/en.json` for every UI text; the i18n test fails on a key
  that is missing in one language or used nowhere;
- the screenshots after a change to the look: **Actions → Update screenshots → Run workflow**, then
  look at the new pictures.

## Checks

Green before every push, then check CI:

```sh
bun run check:fix        # Biome: format, lint, sort imports (CI runs `biome ci`)
bun run typecheck
bun run test             # Vitest, under Bun because of bun:sqlite
CHROMIUM_PATH=/opt/pw-browsers/chromium bun run test:e2e   # builds and starts the demo itself
mkdocs build --strict    # when docs/ or mkdocs.yml changed
```

`e2e/dashboard.spec.ts` sets the password on a fresh database, so it runs first when running single
spec files.

## Pull requests

- One feature per pull request; it carries only its own commits.
- Before every push check whether the branch's pull request is still open. If it is merged, start
  again from the current `origin/main` and open a **new** pull request.
- Merge method: squash, with the title as `<title> (#N)`. Force-push only with `--force-with-lease`
  on the own branch after a merge.
- Releases only when the user says so; the user tags (Bump version button or
  `bun run release:patch|minor|major`).

## Working rules

- Commands as root (`sudo`, `pkexec`) are run by the user; don't work around that.
- The user's running processes are not stopped; use other ports for tests (E2E uses 8585, the
  screenshot demo 8686).
- Code, comments, docs, commits and pull requests in English; the app's interface in German and
  English. Talk to the user in German.

## Code style

Technology choices follow `tech-stack.md` in firsttris/workflows; where Quadeck differs, and why:

- No TanStack Query: live data comes as one snapshot over SSE (`useLive`), the rest through
  `api()` and `usePolling`.
- No Radix/shadcn components: own components on native elements (`<dialog>` for `Modal`, own
  menus and ARIA widgets), styled with Tailwind and the theme tokens in `src/styles.css`.
- Dark only, with five color themes (`html[data-theme]`) and three motion levels
  (`html[data-motion]`) instead of light and dark.
- Validation is hand-written per boundary (`validate*`/`parse*` functions next to their module), not
  Zod.
- Own `Glyph` icons and own SVG charts, as the tech stack allows.
- Delivered as one binary per platform with systemd units (it manages the host), not as a Docker
  image.

Clean Code, written functionally: clear names, small functions that do one thing, dependencies
passed in, no duplication or dead code, comments that say why; the ideas behind SOLID and the
design patterns are welcome as functions, data and closures, but not as classes, inheritance or
class hierarchies.

Functional, not object-oriented: pure functions that take data and return data, side effects at
the edges; function components and hooks, no classes; errors as values. A file does one thing:
split it past ~400 lines, a function past ~80. A refactor changes no behaviour. The existing
backends are classes behind interfaces (`SystemX`/`FixtureX`, the `Privileged` interface); new
code is functional, and large files are split when a change touches them anyway.

## Quadeck specifics

- **Two processes.** `quadeck` (web app, no root) and `quadeck-helper` (root, fixed list of
  actions over a Unix socket). Everything that changes the host goes through the `Privileged`
  interface in `src/server/privileged/actions.ts`, never arbitrary commands; a new action is
  implemented in `local.ts`, `helper-client.ts` and `helper-server.ts` and checked by the unlock
  gate (`gate.ts`).
- **Demo without a server:** `QUADECK_DATA_DIR=.data QUADECK_FIXTURES=fixtures/demo bun run dev`.
  The fixtures in `fixtures/demo` stand in for Podman, systemd, disks and the helper;
  `QUADECK_UNLOCK=quadeck` sets the unlock password. Only the backend reads the file system.
- **UI texts:** Paraglide (`m.key()` in components, `msg(m.key)` on the server, `pickMsg` for keys
  chosen at runtime); keys are `area_group_name`.
- **Look:** Tailwind v4 with the tokens in `@theme`; every color goes through a token so the
  themes follow. Animations obey `data-motion`: off stops everything but spinners, subtle pulses
  only warnings and errors, strong adds glow, lift and breathing lights.
- **Screenshots** come from `scripts/screenshots.mjs` against the demo, in English.
- **Browser in this environment:** Chromium at `/opt/pw-browsers/chromium`; don't run
  `playwright install`.
