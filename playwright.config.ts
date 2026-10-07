import { defineConfig } from '@playwright/test'

const PORT = 8585

export default defineConfig({
  testDir: 'e2e',
  // Sets the password on every shard but the first (CI splits the files across runners)
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    // The specs check the German texts; e2e/zz-i18n.spec.ts switches to English.
    locale: 'de-DE',
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : undefined,
  },
  webServer: {
    // Production build, host data from fixtures, fresh data dir per run.
    command: 'rm -rf .e2e-data && bun run build && bun scripts/start.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { QUADECK_PORT: String(PORT), QUADECK_HOST: '127.0.0.1', QUADECK_DATA_DIR: '.e2e-data', QUADECK_FIXTURES: 'fixtures/demo', QUADECK_UNLOCK: 'quadeck' },
  },
})
