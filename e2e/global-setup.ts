import { readFileSync } from 'node:fs'
import type { FullConfig } from '@playwright/test'

// The first start (setup token, password) is tested by e2e/dashboard.spec.ts, the first file, and
// every other file only logs in. In CI the files are split across runners (--shard), each with its
// own server and data directory; on every shard after the first, dashboard.spec.ts is not there,
// so the password is set here the way the setup page does it.
export default async function globalSetup(config: FullConfig) {
  if (!config.shard || config.shard.current === 1) return
  const baseURL = config.projects[0].use.baseURL
  const token = readFileSync('.e2e-data/setup-token', 'utf8').trim()
  const response = await fetch(`${baseURL}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password: 'e2e-password-123' }),
  })
  if (!response.ok) throw new Error(`Setup for this shard failed: ${response.status} ${await response.text()}`)
}
