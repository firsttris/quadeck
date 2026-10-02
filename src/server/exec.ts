// Subprocess helper. Always takes an argv array (never a shell string), so no
// argument can be interpreted by a shell.

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export async function run(argv: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<ExecResult> {
  let proc
  try {
    proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: { ...process.env, LC_ALL: 'C', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: '', ...opts.env } })
  } catch (e) {
    return { code: 127, stdout: '', stderr: (e as Error).message }
  }
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 15_000)
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { code, stdout, stderr }
}

export async function runOk(argv: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<string> {
  const r = await run(argv, opts)
  if (r.code !== 0) throw new Error(`${argv[0]} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)
  return r.stdout
}
