// Subprocess helper. Always takes an argv array (never a shell string), so no
// argument can be interpreted by a shell.

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** `input` goes to stdin – for secrets, which never belong in argv. */
export async function run(argv: string[], opts: { timeoutMs?: number; env?: Record<string, string>; input?: string } = {}): Promise<ExecResult> {
  let proc
  try {
    proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : 'ignore', env: { ...process.env, LC_ALL: 'C', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: '', ...opts.env } })
  } catch (e) {
    return { code: 127, stdout: '', stderr: (e as Error).message }
  }
  const timeoutMs = opts.timeoutMs ?? 15_000
  const timers: ReturnType<typeof setTimeout>[] = []
  // SIGTERM first; SIGKILL for a process that ignores it.
  timers.push(
    setTimeout(() => {
      proc.kill()
      timers.push(setTimeout(() => proc.kill('SIGKILL'), KILL_GRACE_MS))
    }, timeoutMs),
  )
  const result = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(([stdout, stderr, code]): ExecResult => ({ code, stdout, stderr }))
  // A grandchild that keeps the pipes open, or a process stuck in the kernel (a hung disk) that
  // not even SIGKILL ends, must not hang the caller (and with it a collector or a job) forever.
  const deadline = new Promise<ExecResult>((resolve) => {
    timers.push(setTimeout(() => resolve({ code: 124, stdout: '', stderr: `${argv[0]}: no result ${Math.round((timeoutMs + GIVE_UP_MS) / 1000)} s after start` }), timeoutMs + GIVE_UP_MS))
  })
  try {
    return await Promise.race([result, deadline])
  } finally {
    for (const t of timers) clearTimeout(t)
  }
}

/** After the timeout: SIGKILL follows SIGTERM after this long, and the caller gives up after GIVE_UP_MS. */
export const KILL_GRACE_MS = 3_000
export const GIVE_UP_MS = 5_000

export async function runOk(argv: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<string> {
  const r = await run(argv, opts)
  if (r.code !== 0) throw new Error(`${argv[0]} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)
  return r.stdout
}
