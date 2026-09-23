/**
 * Hot reload for repository flows: one recursive watch of `<cwd>/flows`, and
 * one refresh per burst of changes. Descriptors are metadata only, so a
 * refresh re-lists the registry and never imports repository code.
 */
import { existsSync, type FSWatcher, watch } from "node:fs"
import { join } from "node:path"

export interface Watcher {
  readonly dispose: () => void
}

export const debounceMs = 300

/** Calls `refresh` once per burst of changes under `<cwd>/flows`, including its creation. */
export const flows = (cwd: string, refresh: () => void, debounce = debounceMs): Watcher => {
  const directory = join(cwd, "flows")
  let timer: ReturnType<typeof setTimeout> | undefined
  let tree: FSWatcher | undefined
  let parent: FSWatcher | undefined
  let closed = false
  const changed = () => {
    if (closed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (!closed) refresh()
    }, debounce)
  }
  const open = () => {
    if (tree !== undefined || closed || !existsSync(directory)) return
    try {
      tree = watch(directory, { recursive: true }, changed)
      // A deleted `flows/` ends this watch; the parent watch opens the next one.
      tree.on("error", () => {
        tree?.close()
        tree = undefined
      })
    } catch { /* Unwatchable: the listing still refreshes when `/flows` opens. */ }
  }
  try {
    // `flows/` itself appearing or disappearing.
    parent = watch(cwd, (_, name) => {
      if (name !== "flows") return
      if (!existsSync(directory)) {
        tree?.close()
        tree = undefined
      } else open()
      changed()
    })
    parent.on("error", () => parent?.close())
  } catch { /* The directory is gone; nothing to watch. */ }
  open()
  return {
    dispose: () => {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      tree?.close()
      parent?.close()
    }
  }
}
