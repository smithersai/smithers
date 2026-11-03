import type { Outbox } from "@smthrs/effect-tanstack-db"
import { Effect, Semaphore } from "effect"
import type { BrowserEngine } from "@smthrs/platform-browser"
import type { Host } from "./boot"
import type { Endpoint } from "./flows/tabPort"
import type { AppReloadReason } from "./reloadReason"

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

/** Held exclusively by a signing-out page until it marks the wipe, fails, or closes. The browser releases it on a crash. */
export const SIGN_OUT_LOCK = "smithers-sign-out"

/** The OPFS directory `@smthrs/platform-browser`'s `BrowserRuntime.layerHost` keeps each engine's directory in. */
export const ENGINES_DIRECTORY = "smithers"

/** What a wipe deletes: the engine's directory (its store and the device store) and the outbox's database. */
export interface WipeTargets {
  /** The engine's name: its Web Lock and its directory under `smithers/`. */
  readonly engine: string
  /** The outbox's IndexedDB database. */
  readonly outbox: string
}

/** Why a page leaving on the wipe channel loads again: the sender's reason, else the message's own. */
export type WipeReason = Extract<AppReloadReason, "wipe" | "wipe_channel_reopen" | "identity_reopen" | "older_leader">

/** Why a page reopens every page: the device's owner changed, or an older build's tab leads the store. */
export type ReopenReason = Extract<WipeReason, "identity_reopen" | "older_leader">

/**
 * What a page hears on the wipe channel, and why it loads again: `wipe` a sign-out's; `reopen:<reason>` a reopen whose
 * sender named its reason; any other message, such as a bare `reopen` from a build that names none, another page asking
 * every page to load again. Every build loads again on any message, so a reason in the message reaches older builds
 * unharmed.
 */
export const leaveReason = (message: unknown): WipeReason =>
  message === "wipe"
    ? "wipe"
    : message === "reopen:identity_reopen"
    ? "identity_reopen"
    : message === "reopen:older_leader"
    ? "older_leader"
    : "wipe_channel_reopen"

export type LifecycleOutcome = "sign_out_pending" | "sign_out_answered" | "sign_out_failed" | "sign_out_released" | "reopen_held"

/** The page's browser: its Web Locks, localStorage, OPFS, IndexedDB and BroadcastChannel, and how it loads again. */
export interface WipeHost {
  readonly record?: (outcome: LifecycleOutcome) => void
  /** Shows a retry action after the program has stopped and the page has sealed its stores. */
  readonly failed?: () => void
  readonly locks: Pick<LockManager, "request"> | undefined
  readonly marks: Pick<Storage, "getItem" | "setItem" | "removeItem">
  readonly directory: () => Promise<Pick<FileSystemDirectoryHandle, "getDirectoryHandle" | "removeEntry">>
  readonly indexedDB: Pick<IDBFactory, "deleteDatabase">
  readonly channel: (name: string) => Pick<BroadcastChannel, "postMessage" | "close" | "onmessage">
  readonly reload: (reason: WipeReason) => void
}

/** A page's part in the wipe. */
export interface PageWipe {
  /**
   * Before the program starts: finishes a wipe a sign-out marked, then holds the device's data, shared, until the page
   * ends. `true` when the device holds nothing of an ended session; `false` when a marked wipe couldn't delete, so the
   * page must start on `unwiped`'s stores. `unsupported` opens nothing when Web Locks are absent. With `adopted`, the
   * first paint's shell's own `smithers-data` hold, which it hands over only while it holds the lock and the mark is
   * absent (src/firstPaint/shell.ts `handOver`): the page keeps that hold as its own, with no gap, and lets go of it as it
   * would of its own.
   */
  readonly open: (adopted?: () => void) => Promise<boolean | "unsupported">
  /** The running program's `stop`, which leaving calls before the page loads again. */
  readonly started: (stop: () => Promise<void>) => void
  /** `Host.wipe`: marks the device and tells every page, this one included, to leave. */
  readonly wipe: () => Promise<void>
  /**
   * Tells every page, this one included, to leave and load again without marking a wipe, so the next boot checks
   * the device's owner again (src/device/identity.ts). Nothing is deleted. Returns false while sign-out owns the guard.
   */
  readonly reopen: (reason: ReopenReason) => Promise<boolean>
  /** Releases the guard from the whole sign-out action's finalizer, after wipe marking or safe sealing. */
  readonly finishSignOut: () => Promise<void>
  /** Publishes sign-out intent before the request, retaining it until the whole action ends or the page closes. */
  readonly signOut: (send: () => Promise<Response>) => Promise<Response>
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
  let stopping: Promise<void> | undefined
  let sealed = false
  let leaving: Promise<void> | undefined
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  // How this page lets go of `smithers-data`: its own hold's release, or the adopted shell's.
  let letGo = () => release()
  const signOutReleases = new Set<() => void>()
  const signOutGuards = new Set<Promise<unknown>>()
  let closed = false
  const reopening = new AbortController()
  // Reopens share a guard so receivers cannot exclude one another. Sign-out owns it exclusively through its wipe.
  const unlessSigningOut = (action: () => void) => host.locks === undefined ? Promise.resolve(false) : host.locks.request(SIGN_OUT_LOCK, { mode: "shared", ifAvailable: true }, (lock) => {
    if (lock === null) { host.record?.("reopen_held"); return false }
    action()
    return true
  })

  // A failed stop cannot keep a sign-out guard held or prevent the page from leaving.
  const stopOnce = () => stopping ??= Promise.resolve().then(() => stop?.()).catch(() => undefined)
  const leave = (reason: WipeReason) =>
    (leaving ??= stopOnce()
      .then(() => host.reload(reason)))
  const hearing = host.channel(WIPE)
  hearing.onmessage = (event: MessageEvent) => {
    const reason = leaveReason(event.data)
    if (reason === "wipe") void leave(reason)
    // Delivery can follow a sign-out that started after the broadcast. Retain that request until its guard releases.
    else if (host.locks !== undefined) void host.locks.request(SIGN_OUT_LOCK, { mode: "shared", signal: reopening.signal }, () => {
      if (!closed && !sealed) return leave(reason)
    }).catch(() => undefined)
  }

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

  const finish = async (locks: NonNullable<WipeHost["locks"]>): Promise<boolean> => {
    const pending = marked()
    if (pending === undefined) return false
    if (!pending) return true
    return locks.request(WIPE, { mode: "exclusive" }, async () => {
      // Another page finished it while this one waited. An unreadable mark proves nothing.
      const pending = marked()
      if (pending === undefined) return false
      if (!pending) return true
      try {
        await locks.request(DATA_LOCK, { mode: "exclusive" }, () =>
          locks.request(targets.engine, { mode: "exclusive" }, remove))
        return true
      } catch {
        // recorded: a wipe that failed starts the page unwiped, browser.engine.unavailable WipeUnfinished
        return false
      }
    })
  }

  // Every page hears it on its own channel, this one's included, and leaves.
  const tell = (message: "wipe" | `reopen:${ReopenReason}`) => {
    const telling = host.channel(WIPE)
    telling.postMessage(message)
    telling.close()
  }

  const hold = (locks: NonNullable<WipeHost["locks"]>) =>
    new Promise<void>((granted) => {
      void locks.request(DATA_LOCK, { mode: "shared" }, () => {
        granted()
        return released
      })
    })

  return {
    open: async (adopted) => {
      if (sealed) return false
      if (adopted !== undefined) {
        // Held since before the shell's read, and the mark was absent under the hold: there is nothing to finish, and a
        // wipe marked from now on waits for this hold, as it waits for any running page's.
        letGo = adopted
        return true
      }
      const locks = host.locks
      if (locks === undefined) return "unsupported"
      const clean = await finish(locks)
      await hold(locks)
      return clean
    },
    started: (running) => {
      stop = running
    },
    wipe: async () => {
      try {
        host.marks.setItem(WIPE, "1")
        tell("wipe")
      } catch (error) {
        // Without a durable mark, reloading could reopen the ended session's stores. Stop here until wipe is retried.
        sealed = true
        host.record?.("sign_out_failed")
        // The sign-out's uninterruptible finalizer is awaiting this wipe. Let it finish before shutdown
        // waits for that fiber; keep the data sealed and its lock held until shutdown completes.
        void stopOnce().then(() => {
          letGo()
          host.failed?.()
        })
        throw error
      }
    },
    finishSignOut: async () => {
      for (const releaseSignOut of signOutReleases) releaseSignOut()
      await Promise.all(signOutGuards)
    },
    reopen: (reason) => sealed ? Promise.resolve(false) : unlessSigningOut(() => tell(`reopen:${reason}`)),
    signOut: async (send) => {
      const locks = host.locks
      if (locks === undefined) throw new Error("Web Locks unavailable")
      let letGo!: () => void
      let held!: Promise<unknown>
      await new Promise<void>((resolve, reject) => {
        held = locks.request(SIGN_OUT_LOCK, { mode: "exclusive" }, () => {
          if (closed) { reject(new Error("Page closed")); return }
          return new Promise<void>((released) => {
            letGo = () => { if (!signOutReleases.delete(letGo)) return; host.record?.("sign_out_released"); released() }
            signOutReleases.add(letGo)
            host.record?.("sign_out_pending")
            resolve()
          })
        })
        void held.catch(reject)
      })
      signOutGuards.add(held)
      void held.then(() => signOutGuards.delete(held), () => signOutGuards.delete(held))
      try {
        const response = await send()
        host.record?.(response.ok ? "sign_out_answered" : "sign_out_failed")
        if (!response.ok) { letGo(); await held }
        return response
      } catch (error) {
        host.record?.("sign_out_failed")
        letGo()
        await held
        throw error
      }
    },
    close: () => {
      closed = true
      reopening.abort()
      hearing.close()
      for (const releaseSignOut of signOutReleases) releaseSignOut()
      letGo()
    },
  }
}

/** The page's wipe couldn't delete the device's stores, so the page never opens them. */
export class WipeUnfinished extends Error {
  override readonly name = "WipeUnfinished"
}

/** An outbox storage in memory: what a page whose wipe failed keeps its writes in, never the stale database. */
export const memoryStorage = (): Outbox.Options<never>["storage"] => {
  const entries = new Map<string, string>()
  const locks = new Map<string, { readonly permit: Semaphore.Semaphore; users: number }>()
  return {
    withLock: (name, action) => {
      const lock = locks.get(name) ?? { permit: Semaphore.makeUnsafe(1), users: 0 }
      locks.set(name, lock)
      lock.users++
      return Effect.runPromise(lock.permit.withPermit(Effect.promise(action))).finally(() => {
        if (--lock.users === 0) locks.delete(name)
      })
    },
    get: async (key) => entries.get(key) ?? null,
    setMany: async (rows) => { for (const [key, value] of rows) entries.set(key, value) },
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
