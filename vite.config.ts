import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { paraglideVitePlugin } from '@inlang/paraglide-js'

import pkg from './package.json' with { type: 'json' }

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
  ],
  ssr: { external: ['bun:sqlite'] },
  build: { rollupOptions: { external: [/^bun:/] } },
})
