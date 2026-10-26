import type { StorageAdapter } from "@tanstack/offline-transactions"
import type { BrowserEngine } from "@smthrs/platform-browser"
import type { Host } from "./boot"
import type { Endpoint } from "./flows/tabPort"

// Sign-out's device wipe as each page takes part in it (decision 0008 §4.6, docs/features/sign-in.md#signing-out). The
// device's data lives in two stores that open handles pin: the engine's OPFS directory, which the leading tab's engine
// worker holds open, and the outbox's IndexedDB database, which every tab holds open. So a page wipes nothing while
// another page still has them:
// - every page holds the `smithers-data` Web Lock, shared, from before its program starts until the page ends;
// - a sign-out marks the device and tells every page, its own included, on a BroadcastChannel; each page then stops its
//   program, which closes its stores and ends its engine worker, and loads again;
// - a marked page's boot takes `smithers-data` exclusively, so it waits until every page that had the data open is
//   gone and none can write a row back, then the engine's own lock, so no engine worker holds the directory, and only
//   then deletes, clears the mark and starts.
// A page whose delete still fails never opens the stores: it starts on `unwiped`'s, and the next boot deletes again.
// The browser's objects come in as `WipeHost`: main.tsx gives the browser's, a test gives Node's.

/** The mark's localStorage key, the wipe's exclusive Web Lock and the channel pages hear wipes on. */
export const WIPE = "smithers-wipe"

/** The Web Lock every page holds, shared, while its program may have the device's data open. */
export const DATA_LOCK = "smithers-data"

/** The OPFS directory `@smthrs/platform-browser`'s `BrowserRuntime.layerHost` keeps each engine's directory in. */
export const ENGINES_DIRECTORY = "smithers"

/** What a wipe deletes: the engine's directory (its store and the device store) and the outbox's database. */
export interface WipeTargets {
  /** The engine's name: its Web Lock and its directory under `smithers/`. */
  readonly engine: string
  /** The outbox's IndexedDB database. */
  readonly outbox: string
}

/** The page's browser: its Web Locks, localStorage, OPFS, IndexedDB and BroadcastChannel, and how it loads again. */
export interface WipeHost {
  readonly locks: Pick<LockManager, "request">
  readonly marks: Pick<Storage, "getItem" | "setItem" | "removeItem">
  readonly directory: () => Promise<Pick<FileSystemDirectoryHandle, "getDirectoryHandle" | "removeEntry">>
  readonly indexedDB: Pick<IDBFactory, "deleteDatabase">
  readonly channel: (name: string) => Pick<BroadcastChannel, "postMessage" | "close" | "onmessage">
  readonly reload: () => void
}

/** A page's part in the wipe. */
export interface PageWipe {
  /**
   * Before the program starts: finishes a wipe a sign-out marked, then holds the device's data, shared, until the page
   * ends. `true` when the device holds nothing of an ended session; `false` when a marked wipe couldn't delete, so the
   * page must start on `unwiped`'s stores.
   */
  readonly open: () => Promise<boolean>
  /** The running program's `stop`, which leaving calls before the page loads again. */
  readonly started: (stop: () => Promise<void>) => void
  /** `Host.wipe`: marks the device and tells every page, this one included, to leave. */
  readonly wipe: () => Promise<void>
  /**
   * Tells every page, this one included, to leave and load again without marking a wipe, so the next boot checks
   * the device's owner again (src/device/identity.ts). Nothing is deleted.
   */
  readonly reopen: () => void
  /** Stops hearing wipes and lets go of the data, as the page ending does. */
  readonly close: () => void
}

/** Removes `name` from `directory`; one already gone is fine. */
const removeEntry = async (directory: Pick<FileSystemDirectoryHandle, "removeEntry">, name: string) => {
  try {
    await directory.removeEntry(name, { recursive: true })
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error
  }
}

/** Deletes an IndexedDB database. `blocked` only says a connection is still open: the delete finishes once it closes. */
const deleteDatabase = (indexedDB: WipeHost["indexedDB"], name: string) =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })

/**
 * One page's part in the device wipe: it hears wipes from the moment it is made. On one, it stops its program
 * (`started`), then loads again, once, even if stopping fails.
 */
export const pageWipe = (host: WipeHost, targets: WipeTargets): PageWipe => {
  let stop: (() => Promise<void>) | undefined
  let leaving: Promise<void> | undefined
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))

  const leave = () =>
    (leaving ??= Promise.resolve().then(() => stop?.())
      // expected: the page reloads whether its program stopped or not
      .catch(() => undefined)
      .then(() => host.reload()))
  const hearing = host.channel(WIPE)
  hearing.onmessage = () => void leave()

  const marked = () => {
    try {
      return host.marks.getItem(WIPE) !== null
    } catch {
      // recorded: an unreadable mark starts the page unwiped, browser.engine.unavailable WipeUnfinished
      return undefined
    }
  }

  // Every page that had the data open is gone, and no engine worker holds the directory: delete, then clear the mark.
  const remove = async () => {
    const root = await host.directory()
    const engines = await root.getDirectoryHandle(ENGINES_DIRECTORY).catch((error) => {
      if (error instanceof DOMException && error.name === "NotFoundError") return undefined
      throw error
    })
    if (engines !== undefined) await removeEntry(engines, targets.engine)
    await deleteDatabase(host.indexedDB, targets.outbox)
    host.marks.removeItem(WIPE)
  }

  const finish = async (): Promise<boolean> => {
    const pending = marked()
    if (pending === undefined) return false
    if (!pending) return true
    return host.locks.request(WIPE, { mode: "exclusive" }, async () => {
      // Another page finished it while this one waited. An unreadable mark proves nothing.
      const pending = marked()
      if (pending === undefined) return false
      if (!pending) return true
      try {
        await host.locks.request(DATA_LOCK, { mode: "exclusive" }, () =>
          host.locks.request(targets.engine, { mode: "exclusive" }, remove))
        return true
      } catch {
        // recorded: a wipe that failed starts the page unwiped, browser.engine.unavailable WipeUnfinished
        return false
      }
    })
  }

  // Every page hears it on its own channel, this one's included, and leaves.
  const tell = (message: "wipe" | "reopen") => {
    const telling = host.channel(WIPE)
    telling.postMessage(message)
    telling.close()
  }

  const hold = () =>
    new Promise<void>((granted) => {
      void host.locks.request(DATA_LOCK, { mode: "shared" }, () => {
        granted()
        return released
      })
    })

  return {
    open: async () => {
      const clean = await finish()
      await hold()
      return clean
    },
    started: (running) => {
      stop = running
    },
    wipe: async () => {
      host.marks.setItem(WIPE, "1")
      tell("wipe")
    },
    reopen: () => tell("reopen"),
    close: () => {
      hearing.close()
      release()
    },
  }
}

/** The page's wipe couldn't delete the device's stores, so the page never opens them. */
export class WipeUnfinished extends Error {
  override readonly name = "WipeUnfinished"
}

/** An outbox storage in memory: what a page whose wipe failed keeps its writes in, never the stale database. */
export const memoryStorage = (): StorageAdapter => {
  const entries = new Map<string, string>()
  return {
    get: async (key) => entries.get(key) ?? null,
    set: async (key, value) => void entries.set(key, value),
    delete: async (key) => void entries.delete(key),
    keys: async () => [...entries.keys()],
    clear: async () => entries.clear(),
  }
}

const nothing = () => {}

/** An engine worker that fails as it starts, with `error`: the tab's engine is unavailable, and says why. */
export const failedWorker = (error: () => Error) => (): BrowserEngine.WorkerLike & Endpoint => ({
  terminate: nothing,
  postMessage: nothing,
  removeEventListener: nothing,
  addEventListener: (type: string, listener: (event: never) => void) => {
    if (type === "error") queueMicrotask(() => listener({ error: error() } as never))
  },
})

/**
 * A host that opens nothing of the device's, failing with `error`: the device store can't open, so its rows stay in
 * memory (`persistence unavailable`); the outbox keeps its writes in memory, so no ask the device queued is sent; and
 * the engine is unavailable, so none of its runs resumes (`browser.engine.unavailable`).
 */
export const inMemory = (host: Host, error: () => Error): Host => ({
  ...host,
  persistence: { ...host.persistence, open: () => Promise.reject(error()) },
  outbox: { ...host.outbox, storage: memoryStorage() },
  engineWorker: failedWorker(error),
})

/**
 * The host a page starts on when its wipe couldn't delete the device's stores: `inMemory`, with `WipeUnfinished`, so
 * no ask a previous session queued is sent and none of its runs resumes, and the pill offers Reload, whose boot
 * deletes again.
 */
export const unwiped = (host: Host): Host => inMemory(host, () => new WipeUnfinished())
