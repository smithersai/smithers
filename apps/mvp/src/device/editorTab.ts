// A flow editor's row belongs to one browser tab. Session storage survives its reload; a Web Lock makes a duplicated
// tab choose a new id instead of writing the first tab's form or code. The lock ends when the page ends.

const KEY = "smithers-flow-editor-tab"
const valid = (id: string | null): id is string => id !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

export interface EditorTabHost {
  readonly storage: Pick<Storage, "getItem" | "setItem">
  readonly locks: Pick<LockManager, "request"> | undefined
  readonly page: Pick<Window, "addEventListener">
  readonly randomId: () => string
}

/**
 * Why this page's editor id can't survive its reload, so its editors refuse writes: the browser has no Web Locks
 * (`locks_unavailable`) or refused the lock request (`lock_refused`); another live page holds the id (`lock_held`);
 * session storage threw (`storage_failed`) or didn't keep the id (`storage_unread`).
 */
export type EditorTabRefusal = "locks_unavailable" | "lock_refused" | "lock_held" | "storage_failed" | "storage_unread"

/**
 * Claims this page's stable editor id; a second live page with a copied session-storage id receives its own. An id that
 * can't survive reload says why (`reason`), for the editor store to log.
 */
export const claimEditorTabId = async (
  host: EditorTabHost,
): Promise<{ readonly id: string; readonly persistent: boolean; readonly reason?: EditorTabRefusal }> => {
  const reserve = (id: string): Promise<"claimed" | "lock_held" | "lock_refused" | "locks_unavailable"> => {
    const locks = host.locks
    if (locks === undefined) return Promise.resolve("locks_unavailable")
    return new Promise<"claimed" | "lock_held">((resolve, reject) => {
      void locks.request(`${KEY}:${id}`, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve("lock_held")
          return
        }
        resolve("claimed")
        // A page in the back/forward cache can resume with this editor. Keep its claim until it really leaves.
        return new Promise<void>((release) => host.page.addEventListener("pagehide", (event) => {
          if (!event.persisted) release()
        }))
      }).catch(reject)
      // expected: a refused lock request is returned as the reason
    }).catch(() => "lock_refused" as const)
  }
  let stored: string | null = null
  // expected: unavailable session storage reads as no stored id
  try { stored = host.storage.getItem(KEY) } catch { /* Session storage may be unavailable. */ }
  if (valid(stored) && await reserve(stored) === "claimed") return { id: stored, persistent: true }
  const id = host.randomId()
  const claimed = await reserve(id)
  if (claimed !== "claimed") return { id, persistent: false, reason: claimed }
  try {
    host.storage.setItem(KEY, id)
    return host.storage.getItem(KEY) === id ? { id, persistent: true } : { id, persistent: false, reason: "storage_unread" }
    // expected: returned as the reason its editors refuse writes
  } catch {
    // A reload could not reclaim this row. The editor must refuse writes rather than strand a person's work.
    return { id, persistent: false, reason: "storage_failed" }
  }
}
