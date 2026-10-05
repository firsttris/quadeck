import { readdirSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

// Most test files are pure: they share one module graph per worker (isolate: false), which saves
// re-evaluating thousands of modules per file (~70 s → ~30 s). Files that touch process-wide
// state (env such as QUADECK_DATA_DIR read once by config(), mocks, globals) keep their own.
const files = readdirSync('tests').filter((f) => f.endsWith('.test.ts'))
const isolated = files.filter((f) => /process\.env|vi\.(mock|stubEnv|stubGlobal)|globalThis/.test(readFileSync(`tests/${f}`, 'utf8'))).map((f) => `tests/${f}`)

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    server: { deps: { external: [/^bun:/] } },
    projects: [
      { extends: true, test: { name: 'isolated', include: isolated } },
      { extends: true, test: { name: 'shared', include: ['tests/**/*.test.ts'], exclude: isolated, isolate: false } },
    ],
  },
})
