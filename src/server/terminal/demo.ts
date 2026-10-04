// The demo's terminal: a pretend shell in JavaScript – no process is ever started, so the public
// demo and the E2E tests never hand out a real shell. It echoes, edits the line and answers a
// few commands.

import type { Spawner } from './sessions'

const ANSWERS: Record<string, string> = {
  help: 'Demo – kein echtes Terminal / not a real terminal. Try: ls, uptime, whoami, podman ps, df -h, exit',
  ls: 'Dokumente  Downloads  docker-compose.yml  notes.txt',
  whoami: '',
  uptime: ' 09:41:07 up 3 days,  4:12,  1 user,  load average: 0.42, 0.37, 0.31',
  'podman ps': 'CONTAINER ID  IMAGE                                     NAMES     STATUS\n1a2b3c4d5e6f  docker.io/jellyfin/jellyfin:latest        jellyfin  Up 26 hours (healthy)\n2b3c4d5e6f7a  ghcr.io/immich-app/immich-server:release  immich    Up 26 hours',
  'df -h': 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        11T  7.9T  3.0T  73% /mnt/disk1',
}

export const demoSpawner: Spawner = (spec, onData) => {
  const enc = new TextEncoder()
  const out = (s: string) => setTimeout(() => onData(enc.encode(s)), 0)
  const prompt = spec.kind === 'container' ? `${spec.label}:/# ` : `\x1b[32m${spec.label}\x1b[0m:\x1b[34m~\x1b[0m$ `
  let line = ''
  let done: (code: number) => void = () => {}
  const exited = new Promise<number>((r) => (done = r))
  let open = true
  const exit = (code: number) => {
    if (!open) return
    open = false
    setTimeout(() => done(code), 10)
  }
  out(`\x1b[2mQuadeck demo – ${spec.kind === 'container' ? `container ${spec.label}` : `shell as ${spec.user}`} (pretend, type help)\x1b[0m\r\n${prompt}`)
  return {
    exited,
    kill: () => exit(129),
    term: {
      resize: () => {},
      close: () => {},
      write: (data) => {
        if (!open) return
        for (const ch of typeof data === 'string' ? data : new TextDecoder().decode(data)) {
          if (ch === '\r') {
            const cmd = line.trim()
            line = ''
            if (cmd === 'exit') {
              out('\r\nexit\r\n')
              exit(0)
              return
            }
            const answer = cmd === 'whoami' ? spec.user : cmd ? (ANSWERS[cmd] ?? `${cmd.split(' ')[0]}: demo only – try help`) : ''
            out(`\r\n${answer ? answer.replace(/\n/g, '\r\n') + '\r\n' : ''}${prompt}`)
          } else if (ch === '\x7f') {
            if (line) {
              line = line.slice(0, -1)
              out('\b \b')
            }
          } else if (ch === '\x03') {
            line = ''
            out(`^C\r\n${prompt}`)
          } else if (ch >= ' ') {
            line += ch
            out(ch)
          }
        }
      },
    },
  }
}
