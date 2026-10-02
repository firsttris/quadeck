// Which unlock token belongs to which login session. Kept in memory only:
// after a restart of the web app one unlocks again.

const tokens = new Map<string, string>()

export const unlockToken = (sessionId: string) => tokens.get(sessionId)
export const setUnlockToken = (sessionId: string, token: string) => tokens.set(sessionId, token)
export const clearUnlockToken = (sessionId: string) => tokens.delete(sessionId)
