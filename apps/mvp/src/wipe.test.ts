import { Worker } from "node:worker_threads"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { boundFetch } from "./device/identity"
import { BrowserEngine } from "@smthrs/platform-browser"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { signOut } from "./features/auth/actions"
import { AuthClient } from "./features/auth/api"
import { DeviceWipe } from "./features/auth/device"
import { AuthStore, SESSION } from "./features/auth/store"
import { afterEach, expect, test, vi } from "vitest"
import { tabEngine } from "./flows/engine"
import { nodeDevice } from "./test/chatApi"
import { DATA_LOCK, ENGINES_DIRECTORY, inMemory, leaveReason, memoryStorage, pageWipe, unwiped, WIPE, SIGN_OUT_LOCK, type WipeHost, WipeUnfinished } from "./wipe"

// Sign-out's device wipe across pages (src/wipe.ts, docs/features/sign-in.md#signing-out), on Node's own Web Locks and
// BroadcastChannel. Node has no OPFS and no IndexedDB, so those two are stand-ins that keep what was deleted, and a
// database delete that a still-open connection holds off until it closes, as the browser's does.

const targets = { engine: "smithers-engine", outbox: "smithers-outbox" }
const until = (assertion: () => void | Promise<void>) => vi.waitFor(assertion, { timeout: 10_000, interval: 10 })

const closing: Array<() => void> = []
afterEach(() => {
  for (const close of closing.splice(0)) close()
})

/** One browser profile: its locks and channels apart from every other test's, its mark, OPFS and IndexedDB. */
const browser = () => {
  const profile = `wipe-${crypto.randomUUID()}`
  const marks = new Map<string, string>()
  const markReads = { refused: false, writeRefused: false }
  // OPFS: `smithers/<engine>` until removed; `fail` makes a removal throw, as a handle another worker holds does.
  const entries = new Set([targets.engine])
  const removed: Array<string> = []
  const opfs = { parent: true, lookupFailure: undefined as Error | undefined, fail: undefined as Error | undefined }
  // IndexedDB: a delete waits while `connections` is above zero, and fails with `failDelete` when set.
  const deleted: Array<string> = []
  const idb = { connections: 0, failDelete: false, waiting: [] as Array<() => void> }
  const directory: Awaited<ReturnType<WipeHost["directory"]>> = {
    getDirectoryHandle: async (name: string) => {
      if (opfs.lookupFailure !== undefined) throw opfs.lookupFailure
      if (name !== ENGINES_DIRECTORY || !opfs.parent) throw new DOMException("no such directory", "NotFoundError")
      return {
        removeEntry: async (entry: string) => {
          if (opfs.fail !== undefined) throw opfs.fail
          if (!entries.delete(entry)) throw new DOMException("no such entry", "NotFoundError")
          removed.push(entry)
        },
      } as unknown as FileSystemDirectoryHandle
    },
    removeEntry: async () => {},
  }
  const indexedDB: WipeHost["indexedDB"] = {
    deleteDatabase: (name: string) => {
      const request = { onsuccess: null, onerror: null, error: null } as unknown as IDBOpenDBRequest
      const finish = () => {
        if (idb.failDelete) {
          Object.assign(request, { error: new DOMException("refused", "UnknownError") })
          return void request.onerror?.(new Event("error"))
        }
        deleted.push(name)
        request.onsuccess?.(new Event("success"))
      }
      queueMicrotask(() => (idb.connections > 0 ? idb.waiting.push(finish) : finish()))
      return request
    },
  }
  const scoped = (name: string) => `${profile}/${name}`
  const locks: WipeHost["locks"] = {
    request: ((name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) =>
      navigator.locks.request(scoped(name), options, callback)) as NonNullable<WipeHost["locks"]>["request"],
  }
  const page = (stop?: () => Promise<void>) => {
    const events: Array<string> = []
    const reasons: Array<string> = []
    const records: Array<string> = []
    const failures: Array<() => Promise<void>> = []
    const wipe = pageWipe(
      {
        locks,
        record: (outcome) => { records.push(outcome) },
        failed: () => { failures.push(() => wipe.wipe()) },
        marks: {
          getItem: (key) => {
            if (markReads.refused) throw new DOMException("blocked", "SecurityError")
            return marks.get(key) ?? null
          },
          setItem: (key, value) => {
            if (markReads.writeRefused) throw new DOMException("blocked", "SecurityError")
            marks.set(key, value)
          },
          removeItem: (key) => void marks.delete(key),
        },
        directory: async () => directory,
        indexedDB,
        channel: (name) => new BroadcastChannel(scoped(name)),
        reload: (reason) => {
          events.push("reload")
          reasons.push(reason)
        },
      },
      targets,
    )
    if (stop !== undefined) {
      wipe.started(() => {
        events.push("stop")
        return stop()
      })
    }
    closing.push(wipe.close)
    return { ...wipe, events, reasons, records, failures }
  }
  /** Locks of this profile requested and not yet granted, as `name mode`. */
  const pending = async () =>
    ((await navigator.locks.query()).pending ?? [])
      .filter((lock) => lock.name!.startsWith(`${profile}/`))
      .map((lock) => `${lock.name!.slice(profile.length + 1)} ${lock.mode}`)
  /** Holds `name`, exclusively as an engine worker that leads holds the engine's lock, or shared; `release` lets go. */
  const holdLock = async (name: string, mode: LockMode = "exclusive") => {
    let release = () => {}
    await new Promise<void>((granted) => {
      void navigator.locks.request(scoped(name), { mode }, () => {
        granted()
        return new Promise<void>((resolve) => (release = resolve))
      })
    })
    return () => release()
  }
  const closeConnection = () => {
    idb.connections--
    for (const finish of idb.waiting.splice(0)) finish()
  }
  return { marks, markReads, entries, removed, deleted, opfs, idb, page, pending, holdLock, closeConnection, scoped, released: (name: string) => navigator.locks.request(scoped(name), () => {}) }
}

test("a page that still holds the device's data holds a sign-out's wipe off until it ends; the wipe then deletes both stores and clears the mark", async () => {
  const device = browser()
  // Tab 2 has the data open: its program runs, holding the outbox's database open.
  const two = device.page(async () => {})
  expect(await two.open()).toBe(true)
  device.idb.connections++
  // Tab 1 signs out: the mark, then every page hears it, its own included, and leaves: its program stops, then it
  // loads again.
  const one = device.page(async () => {})
  await one.wipe()
  expect(device.marks.get(WIPE)).toBe("1")
  await until(() => {
    expect(one.events).toEqual(["stop", "reload"])
    expect(two.events).toEqual(["stop", "reload"])
  })
  expect([...one.reasons, ...two.reasons]).toEqual(["wipe", "wipe"])

  // Tab 1 loads again while tab 2 is still unloading: its boot waits for the data, and deletes nothing yet.
  const again = device.page()
  const opened = again.open()
  await until(async () => expect(await device.pending()).toContain(`${DATA_LOCK} exclusive`))
  expect(device.removed).toEqual([])
  expect(device.deleted).toEqual([])

  // Tab 2 ends and its hold goes. The engine's directory goes at once; a connection still open to the outbox's
  // database holds that delete off, as `blocked` does in a browser, and the wipe waits for it rather than failing.
  two.close()
  await until(() => expect(device.removed).toEqual([targets.engine]))
  expect(device.idb.waiting).toHaveLength(1)
  expect(device.marks.get(WIPE)).toBe("1")
  // The connection closes: the wipe deletes, clears the mark, and the page opens on an empty device, holding the data
  // in turn.
  device.closeConnection()
  expect(await opened).toBe(true)
  expect(device.removed).toEqual([targets.engine])
  expect(device.deleted).toEqual([targets.outbox])
  expect(device.marks.has(WIPE)).toBe(false)

  // Tab 2 loads again: nothing is marked, so it opens at once and deletes nothing more; both hold the data together.
  const twoAgain = device.page()
  expect(await twoAgain.open()).toBe(true)
  expect(device.removed).toEqual([targets.engine])
  expect(await device.pending()).toEqual([])
})

test("a page adopts the first paint's shared hold as its own: no gap, and a wipe waits until the page lets go", async () => {
  const device = browser()
  // The shell's hold (src/firstPaint/shell.ts): smithers-data, shared, from before its read.
  const releaseShell = await device.holdLock(DATA_LOCK, "shared")
  const page = device.page(async () => {})
  expect(await page.open(releaseShell)).toBe(true)
  // The page asked for no hold of its own: the shell's is the only one.
  expect(await device.pending()).toEqual([])
  // Another page's sign-out marks the device; a boot after it waits for the adopted hold.
  await device.page().wipe()
  const again = device.page()
  const opened = again.open()
  await until(async () => expect(await device.pending()).toContain(`${DATA_LOCK} exclusive`))
  expect(device.removed).toEqual([])
  // The page ends: the adopted hold goes, and the wipe deletes.
  page.close()
  expect(await opened).toBe(true)
  expect(device.removed).toEqual([targets.engine])
})

test("the wipe waits for the engine worker that leads to let go of the directory", async () => {
  const device = browser()
  device.marks.set(WIPE, "1")
  const leading = await device.holdLock(targets.engine)
  const page = device.page()
  const opened = page.open()
  await until(async () => expect(await device.pending()).toContain(`${targets.engine} exclusive`))
  expect(device.removed).toEqual([])
  leading()
  expect(await opened).toBe(true)
  expect(device.removed).toEqual([targets.engine])
})

test("two pages loading on a marked device delete once; the second finds the wipe finished", async () => {
  const device = browser()
  device.marks.set(WIPE, "1")
  const [first, second] = [device.page(), device.page()]
  expect(await Promise.all([first.open(), second.open()])).toEqual([true, true])
  expect(device.removed).toEqual([targets.engine])
  expect(device.deleted).toEqual([targets.outbox])
})

test("a delete that fails keeps the mark, and the page opens unwiped; the next boot deletes again", async () => {
  const device = browser()
  device.marks.set(WIPE, "1")
  // Each boot is a page of its own, which ends before the next one loads.
  const boot = async () => {
    const page = device.page()
    const opened = await page.open()
    page.close()
    return opened
  }
  device.opfs.fail = new DOMException("a handle is open", "NoModificationAllowedError")
  expect(await boot()).toBe(false)
  expect(device.marks.get(WIPE)).toBe("1")

  device.opfs.fail = undefined
  device.idb.failDelete = true
  expect(await boot()).toBe(false)
  expect(device.marks.get(WIPE)).toBe("1")
  expect(device.removed).toEqual([targets.engine])

  // The directory and its entry are already gone: that is wiped.
  device.idb.failDelete = false
  expect(await boot()).toBe(true)
  device.marks.set(WIPE, "1")
  device.opfs.parent = false
  expect(await boot()).toBe(true)
  expect(device.deleted).toEqual([targets.outbox, targets.outbox])
  expect(device.marks.has(WIPE)).toBe(false)
})

test("an unmarked page opens without the wipe's lock; storage that refuses reads cannot prove the device clean", async () => {
  const device = browser()
  const wiped = await device.holdLock(WIPE)
  expect(await device.page().open()).toBe(true)
  wiped()

  const refusing = pageWipe(
    {
      locks: navigator.locks,
      marks: {
        getItem: () => {
          throw new DOMException("blocked", "SecurityError")
        },
        setItem: () => {},
        removeItem: () => {},
      },
      directory: () => Promise.reject(new Error("never read")),
      indexedDB: { deleteDatabase: () => { throw new Error("never deleted") } },
      channel: (name) => new BroadcastChannel(`wipe-${crypto.randomUUID()}/${name}`),
      reload: () => {},
    },
    targets,
  )
  closing.push(refusing.close)
  expect(await refusing.open()).toBe(false)
})

test("leaving loads the page again once, after its program stops, even when stopping fails or nothing started yet", async () => {
  const device = browser()
  const failing = device.page(() => Promise.reject(new Error("stop failed")))
  const unstarted = device.page()
  const telling = device.page(async () => {})
  await telling.wipe()
  await telling.wipe()
  await until(() => {
    expect(failing.events).toEqual(["stop", "reload"])
    expect(unstarted.events).toEqual(["reload"])
    expect(telling.events).toEqual(["stop", "reload"])
  })
})

test("a page whose wipe failed starts on stores that aren't the device's: memory rows, a memory outbox and no engine", async () => {
  const host = unwiped(nodeDevice())
  await expect(Promise.resolve(host.persistence.open())).rejects.toBeInstanceOf(WipeUnfinished)

  const storage = host.outbox.storage
  await storage.set("a", "1")
  await storage.set("b", "2")
  expect(await storage.get("a")).toBe("1")
  expect(await storage.get("missing")).toBeNull()
  await storage.delete("a")
  expect(await storage.keys()).toEqual(["b"])
  await storage.clear()
  expect(await storage.keys()).toEqual([])
  expect(await memoryStorage().keys()).toEqual([])

  // The tab's engine is unavailable at once, and says why: no run of the ended session resumes on this device.
  const runtime = ManagedRuntime.make(tabEngine(host.engineWorker, `smithers-${crypto.randomUUID()}`))
  const engine = await runtime.runPromise(Effect.service(BrowserEngine.BrowserEngine))
  expect(await runtime.runPromise(engine.unavailable)).toMatchObject({ reason: "worker-failed", error: "WipeUnfinished" })
  await runtime.dispose()
})

test("a directory lookup failure retains the wipe marker and engine data", async () => {
  const device = browser()
  device.marks.set(WIPE, "1")
  device.opfs.lookupFailure = new DOMException("storage unavailable", "UnknownError")
  expect(await device.page().open()).toBe(false)
  expect(device.marks.get(WIPE)).toBe("1")
  expect(device.entries.has(targets.engine)).toBe(true)
  expect(device.deleted).toEqual([])
})

test("a synchronous stop failure still reloads once", async () => {
  const device = browser()
  const page = device.page(() => { throw new Error("synchronous stop failure") })
  await page.wipe()
  await until(() => expect(page.events).toEqual(["stop", "reload"]))
  await page.wipe()
  expect(page.events).toEqual(["stop", "reload"])
})

test("a marker that becomes unreadable while waiting for the wipe lock preserves retained stores", async () => {
  const device = browser()
  device.marks.set(WIPE, "1")
  const release = await device.holdLock(WIPE)
  const opened = device.page().open()
  await until(async () => expect(await device.pending()).toContain(`${WIPE} exclusive`))
  device.markReads.refused = true
  release()
  expect(await opened).toBe(false)
  expect(device.marks.get(WIPE)).toBe("1")
  expect(device.entries.has(targets.engine)).toBe(true)
  expect(device.deleted).toEqual([])
})

test("reopening loads every page again, this one included, and deletes nothing: the next boot checks the owner again", async () => {
  const device = browser()
  const other = device.page(async () => {})
  expect(await other.open()).toBe(true)
  const asking = device.page(async () => {})
  asking.reopen("identity_reopen")
  await until(() => {
    expect(asking.events).toEqual(["stop", "reload"])
    expect(other.events).toEqual(["stop", "reload"])
  })
  // Every page loads again for the asking page's reason.
  expect([...asking.reasons, ...other.reasons]).toEqual(["identity_reopen", "identity_reopen"])
  expect(device.marks.has(WIPE)).toBe(false)
  other.close()
  expect(await device.page().open()).toBe(true)
  expect(device.removed).toEqual([])
  expect(device.deleted).toEqual([])
})

test("a page refused the device's data runs in memory, and its engine says why", async () => {
  class Sealed extends Error {
    override readonly name = "Sealed"
  }
  const host = inMemory(nodeDevice(), () => new Sealed())
  await expect(Promise.resolve(host.persistence.open())).rejects.toBeInstanceOf(Sealed)
  await host.outbox.storage.set("a", "1")
  expect(await host.outbox.storage.keys()).toEqual(["a"])
  const runtime = ManagedRuntime.make(tabEngine(host.engineWorker, `smithers-${crypto.randomUUID()}`))
  const engine = await runtime.runPromise(Effect.service(BrowserEngine.BrowserEngine))
  expect(await runtime.runPromise(engine.unavailable)).toMatchObject({ reason: "worker-failed", error: "Sealed" })
  await runtime.dispose()
})

test("each page loads again for the reason the channel's message names, a message naming none another page's ask", () => {
  expect(leaveReason("wipe")).toBe("wipe")
  expect(leaveReason("reopen:identity_reopen")).toBe("identity_reopen")
  expect(leaveReason("reopen:older_leader")).toBe("older_leader")
  // A build that names no reason sends a bare `reopen`.
  expect(leaveReason("reopen")).toBe("wipe_channel_reopen")
  expect(leaveReason({ reopen: true })).toBe("wipe_channel_reopen")
})

test("a sign-out intent suppresses every page's reopen until wipe or failure, and abruptly terminating its tab releases it", async () => {
  const device = browser()
  const a = device.page()
  const b = device.page()
  let finish!: (response: Response) => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const pending = a.signOut(() => { entered(); return new Promise<Response>((resolve) => { finish = resolve }) })
  await started
  expect(await b.reopen("identity_reopen")).toBe(false)
  expect(b.events).toEqual([])
  finish(new Response(null, { status: 503 }))
  await pending
  expect(a.records).toEqual(["sign_out_pending", "sign_out_failed", "sign_out_released"])
  expect(b.records).toEqual(["reopen_held"])
  expect(await b.reopen("identity_reopen")).toBe(true)
  await until(() => expect(b.events).toEqual(["reload"]))

  const next = browser()
  const surviving = next.page()
  const crashed = new Worker(new URL("./test/wipeCrash.worker.ts", import.meta.url), { workerData: { lock: next.scoped(SIGN_OUT_LOCK) } })
  closing.push(() => { void crashed.terminate() })
  await new Promise<void>((resolve, reject) => { crashed.once("message", resolve); crashed.once("error", reject) })
  expect(await surviving.reopen("identity_reopen")).toBe(false)
  // Termination runs no PageWipe.close or finalizer. The lock manager alone must release the crashed page's lock.
  await crashed.terminate()
  await next.released(SIGN_OUT_LOCK)
  expect(await surviving.reopen("identity_reopen")).toBe(true)
})


test("concurrent reopen requests and receivers share the guard so every page reloads once", async () => {
  const device = browser()
  const pages = Array.from({ length: 8 }, () => device.page(async () => {}))
  expect(await Promise.all(pages.slice(0, 2).map((page) => page.reopen("identity_reopen")))).toEqual([true, true])
  await until(() => {
    for (const page of pages) expect(page.reasons).toEqual(["identity_reopen"])
  })
})


test("a broadcast delivered after sign-out takes the guard is retained through failure", async () => {
  const messages: unknown[] = []
  const receivers: Array<BroadcastChannel> = []
  const channels: WipeHost["channel"] = () => {
    const receiver = new BroadcastChannel(`delayed-reopen-${crypto.randomUUID()}`)
    receivers.push(receiver)
    return { get onmessage() { return receiver.onmessage }, set onmessage(value) { receiver.onmessage = value }, postMessage: (message) => { messages.push(message) }, close: () => receiver.close() }
  }
  const reloads: string[] = []
  const page = pageWipe({
    locks: navigator.locks,
    marks: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    channel: channels, reload: (reason) => { reloads.push(reason) },
    directory: async () => { throw new Error("A reopen must never open device stores") },
    indexedDB: { deleteDatabase: () => { throw new Error("A reopen must never delete a database") } },
  }, targets)
  closing.push(page.close)
  const session = "bob"
  let calls = 0
  const fetch = boundFetch(async () => { calls++; return Response.json({ signedIn: true, personId: session, login: session, role: "member" }) }, {
    origin: "https://app.test", principal: () => "alice", reauthorize: () => page.reopen("identity_reopen"),
  })
  await expect(fetch("https://app.test/api/auth/session")).rejects.toMatchObject({ reason: "reauthorizing" })
  let finish!: (response: Response) => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const signingOut = page.signOut(() => { entered(); return new Promise<Response>((resolve) => { finish = resolve }) })
  await started
  for (const data of messages) for (const receiver of receivers) receiver.dispatchEvent(new MessageEvent("message", { data }))
  // Wait for the receiver's lock attempt before releasing sign-out.
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(reloads).toEqual([])
  finish(new Response(null, { status: 503 }))
  await signingOut
  await until(() => expect(reloads).toEqual(["identity_reopen"]))
  expect(calls).toBe(1)
})


test("a wipe marker failure after 204 seals the page, releases sign-out, and can be retried", async () => {
  const device = browser()
  let stops = 0
  const a = device.page(async () => { stops++ })
  const b = device.page()
  await a.open()
  expect((await a.signOut(async () => new Response(null, { status: 204 }))).status).toBe(204)
  device.markReads.writeRefused = true
  await expect(a.wipe().finally(a.finishSignOut)).rejects.toMatchObject({ name: "SecurityError" })
  expect(stops).toBe(1)
  expect(a.records).toContain("sign_out_failed")
  expect(a.records).toContain("sign_out_released")
  await until(() => expect(a.failures).toHaveLength(1))
  expect(await a.open()).toBe(false)
  expect(device.entries.has(targets.engine)).toBe(true)
  // A failed marker must leave a retry possible without an exclusive guard stranded in the owning tab.
  expect((await b.signOut(async () => new Response(null, { status: 503 }))).status).toBe(503)
  device.markReads.writeRefused = false
  await a.failures[0]!()
  expect(device.marks.get(WIPE)).toBe("1")
  await until(() => expect(a.reasons).toEqual(["wipe"]))
  expect(stops).toBe(1)
})

test("a failed wipe marker lets the scoped sign-out finish before real runtime disposal completes", async () => {
  const device = browser()
  const retained = nodeDevice()
  const server = createServer((_request, response) => { response.writeHead(204); response.end() })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let disposed = false
  let releaseCleanup!: () => void
  // Only teardown releases this escape hatch, so the old deadlock reports an assertion rather than hanging the worker.
  const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve })
  let dispose!: () => Promise<void>
  const page = device.page(() => Promise.race([dispose().then(() => { disposed = true }), cleanup]))
  const transport = boundFetch(fetch, { origin, principal: () => "alice", signOut: page.signOut })
  const client = AuthClient.layer({ origin, within: "2 seconds" }).pipe(Layer.provide(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, transport))),
  ))
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    AuthStore.layer.pipe(Layer.provide(Persistence.layer(retained.persistence))),
    client,
    DeviceWipe.layer(page.wipe, page.finishSignOut),
  ))
  dispose = () => runtime.dispose()
  try {
    expect(await page.open()).toBe(true)
    await runtime.runPromise(Effect.gen(function* () {
      const store = yield* AuthStore
      yield* store.confirmed.restored
      yield* (yield* store.confirmed.insert({ id: SESSION, personId: "alice", login: "alice", role: "member" })).persisted
    }))
    device.markReads.writeRefused = true
    await runtime.runPromise(signOut)
    await until(() => expect(page.failures).toHaveLength(1))
    expect(disposed).toBe(true)
    expect(page.records).toContain("sign_out_released")
    expect(await page.open()).toBe(false)
    expect(await page.reopen("identity_reopen")).toBe(false)
    await device.released(SIGN_OUT_LOCK)
    device.markReads.writeRefused = false
    await page.failures[0]!()
    expect(device.marks.get(WIPE)).toBe("1")
    await until(() => expect(page.reasons).toEqual(["wipe"]))
    expect(page.events.filter(event => event === "stop")).toHaveLength(1)
  } finally {
    releaseCleanup()
    await runtime.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})


test.each(["session update", "confirmation restore", "confirmation read", "confirmation delete", "confirmation persistence"])("a failure at %s after server sign-out still marks the wipe and releases the whole-action guard", async (stage) => {
  const device = browser()
  const page = device.page(async () => {})
  const sibling = device.page()
  const retained = nodeDevice()
  let wiped = 0
  let answered = false
  let injected = false
  const fail = Effect.sync(() => { injected = true; throw new Error("Local sign-out step unavailable") })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const context = yield* Layer.build(AuthStore.layer.pipe(Layer.provide(Persistence.layer(retained.persistence))))
    const store = Context.get(context, AuthStore)
    yield* store.confirmed.restored
    yield* (yield* store.confirmed.insert({ id: SESSION, personId: "alice", login: "alice", role: "member" })).persisted
    const faulty = AuthStore.of({ ...store,
      session: { ...store.session, update: (key, recipe) => answered && stage === "session update" ? fail : store.session.update(key, recipe) },
      confirmed: { ...store.confirmed,
        restored: stage === "confirmation restore" ? fail : store.confirmed.restored,
        get: (key) => stage === "confirmation read" ? fail : store.confirmed.get(key),
        delete: (key) => stage === "confirmation delete" ? fail : store.confirmed.delete(key).pipe(Effect.map((receipt) => stage === "confirmation persistence" ? { ...receipt, persisted: fail } : receipt)),
      },
    })
    yield* signOut.pipe(
      Effect.provideService(AuthStore, faulty),
      Effect.provideService(AuthClient, AuthClient.of({ session: Effect.never, signOut: Effect.promise(async () => {
        await page.signOut(async () => new Response(null, { status: 204 }))
        answered = true
      }) })),
      Effect.provide(DeviceWipe.layer(async () => { wiped++; await page.wipe() }, page.finishSignOut)),
    )
    yield* Effect.promise(() => until(() => expect(injected).toBe(true)))
    yield* Effect.promise(() => until(() => expect(device.marks.get(WIPE)).toBe("1")))
    expect(wiped).toBe(1)
    yield* Effect.promise(() => device.released(SIGN_OUT_LOCK))
    expect(page.records).toContain("sign_out_released")
    yield* Effect.promise(() => sibling.reopen("identity_reopen"))
    expect(page.records.filter((record) => record === "sign_out_released")).toHaveLength(1)
  })))
})
