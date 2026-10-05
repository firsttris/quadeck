import { useState, type Dispatch, type SetStateAction } from 'react'

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * What a draft becomes when the server value may have changed: it follows the new value only
 * while it still equals the previous one (nothing edited). Undefined when nothing changes.
 */
export function followServer<T>(base: T, server: T, draft: T, same: (a: T, b: T) => boolean = sameJson): { base: T; draft: T } | undefined {
  if (same(base, server)) return undefined
  return { base: server, draft: same(draft, base) ? server : draft }
}

/**
 * A form draft of a value that keeps arriving from the server (polling, live updates, a save in
 * another tab). The draft follows a new server value only while the user has not changed anything,
 * so a poll never throws away unsaved edits. Compares by content, not identity: a poll that
 * returns the same settings as a fresh object changes nothing.
 */
export function useDraft<T>(server: T, same: (a: T, b: T) => boolean = sameJson): [T, Dispatch<SetStateAction<T>>] {
  const [draft, setDraft] = useState(server)
  const [base, setBase] = useState(server)
  const next = followServer(base, server, draft, same)
  if (next) {
    // adjusting state while rendering (react.dev "storing information from previous renders")
    setBase(next.base)
    if (next.draft !== draft) setDraft(next.draft)
  }
  return [draft, setDraft]
}
