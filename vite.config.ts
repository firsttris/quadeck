import { defineConfig, type Plugin } from 'vite'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { paraglideVitePlugin } from '@inlang/paraglide-js'

import pkg from './package.json' with { type: 'json' }

/**
 * Client assets get a .br and a .gz copy next to them, compressed once at build
 * time with the best settings; main.ts serves the one the browser accepts.
 */
function precompress(): Plugin {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
  return {
    name: 'quadeck:precompress',
    apply: 'build',
    applyToEnvironment: (env) => env.name === 'client',
    writeBundle(options) {
      for (const file of walk(options.dir!)) {
        if (!/\.(js|css|svg|json|txt|html)$/.test(file)) continue
        const raw = readFileSync(file)
        if (raw.length < 1024) continue
        const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
        const gz = gzipSync(raw, { level: 9 })
        if (br.length < raw.length * 0.9) writeFileSync(`${file}.br`, br)
        if (gz.length < raw.length * 0.9) writeFileSync(`${file}.gz`, gz)
      }
    },
  }
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 3000 },
  resolve: { tsconfigPaths: true },
  plugins: [
    // messages/{de,en}.json → src/paraglide (typed message functions)
    paraglideVitePlugin({ project: './project.inlang', outdir: './src/paraglide', strategy: ['cookie', 'baseLocale'], cookieName: 'qd_lang' }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    precompress(),
  ],
  ssr: { external: ['bun:sqlite'] },
  build: { rollupOptions: { external: [/^bun:/] } },
})
