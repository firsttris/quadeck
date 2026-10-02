// Runs the production build from ./dist without compiling (bun run start).
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import pkg from '../package.json'
import { main } from '../src/main'

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
const assets = new Map(walk('dist/client').map((f) => [`/${relative('dist/client', f)}`, resolve(f)]))
const { default: server } = await import(resolve('dist/server/server.js'))
await main(process.argv.slice(2), { server, assets, version: pkg.version })
