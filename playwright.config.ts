import { defineConfig } from '@playwright/test'

const PORT = 8585

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
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
