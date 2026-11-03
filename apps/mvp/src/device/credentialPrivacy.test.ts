import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Collection, Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { expect, test, vi } from "vitest"
import { AuthClient } from "../features/auth/api"
import { load } from "../features/auth/actions"
import { SESSION_ROUTE } from "../features/auth/contract"
import { RepoRole } from "../features/auth/schema"
import { AuthStore, SESSION } from "../features/auth/store"
import { makeVisibility } from "../features/repo/gate"
import { nodeDevice } from "../test/chatApi"
import { boundFetch, VISITOR } from "./identity"

test.each(["ready", "rejected", "stalled storage", "stalled lock"] as const)("a stale session hides private rows through AuthClient and the data gate with %s publication", async publication => {
  let mode: "fresh" | "stale" | "offline" = "fresh"
  let releasePublication!: () => void
  const publicationGate = new Promise<void>(resolve => { releasePublication = resolve })
  const server = createServer((request, response) => {
    if (mode === "offline") { request.socket.destroy(); return }
    if (mode === "stale") {
      response.writeHead(503, { "x-smithers-credential": "stale", "retry-after": "120" })
      response.end()
    } else {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ signedIn: true, personId: "alice", login: "alice", role: "member" }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const rows = new Map<string, string>()
  const transport = boundFetch(fetch, { origin, principal: () => "alice", reauthorize: async () => false,
    credentialStorage: {
      get: async key => rows.get(key) ?? null,
      set: async (key, value) => {
        if (publication === "stalled storage") await publicationGate
        if (publication === "rejected") throw new Error("Storage write refused")
        rows.set(key, value)
      },
    },
    withCredential: async action => {
      if (publication === "stalled lock") await publicationGate
      return action()
    },
  })
  const device = nodeDevice()
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    AuthStore.layer.pipe(Layer.provide(Persistence.layer(device.persistence))),
    AuthClient.layer({ origin, within: "2 seconds" }).pipe(Layer.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, transport))),
    )),
  ))
  try {
    await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* AuthStore
      const roles = yield* Collection.local({ id: `roles-${crypto.randomUUID()}`, schema: RepoRole,
        getKey: row => row.id, initialData: [
          { id: "private", role: "member" as const, own: false },
          { id: "public", role: null, own: false, readable: true },
        ],
      })
      const data = yield* Collection.local({ id: `data-${crypto.randomUUID()}`,
        schema: Schema.Struct({ id: Schema.String, repoId: Schema.String }), getKey: row => row.id,
        initialData: [{ id: "private-row", repoId: "private" }, { id: "public-row", repoId: "public" }],
      })
      const visibility = yield* makeVisibility(roles, store.session, Effect.void)
      const gated = yield* visibility.gate(data)
      gated.tanstack.startSyncImmediate()
      const visible = (expected: ReadonlyArray<string>) => Effect.promise(() => vi.waitFor(async () => {
        const shown = await runtime.runPromise(gated.toArray)
        expect(shown.map(row => row.id).sort()).toEqual(expected)
      }))
      expect(yield* load).toBe("signed_in")
      yield* visible(["private-row", "public-row"])
      mode = "stale"
      expect(yield* load).toBe("unreachable")
      expect(Option.getOrThrow(yield* store.session.get(SESSION)).unverifiable).toBe(true)
      yield* visible(["public-row"])
      mode = "offline"
      expect(yield* load).toBe("unreachable")
      yield* visible(["public-row"])
      mode = "fresh"
      expect(yield* load).toBe("signed_in")
      yield* visible(["private-row", "public-row"])
      expect(Option.getOrThrow(yield* store.confirmed.get(SESSION)).personId).toBe("alice")
    })))
  } finally {
    releasePublication()
    await runtime.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test.each(["absent", "already verified"] as const)("a failed credential publication blocks writes with an %s stored receipt", async previous => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(10_000)
  let writes = 0
  let reads = 0
  let stale = true
  let rejectStorage = false
  let delay = "0"
  const rows = new Map<string, string>()
  const server = createServer((request, response) => {
    if (request.url === SESSION_ROUTE) {
      reads++
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ signedIn: true, personId: "alice", login: "alice", role: "member" }))
      return
    }
    writes++
    response.writeHead(stale ? 503 : 200, stale ? { "x-smithers-credential": "stale", "retry-after": delay } : {})
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const lock = `credential-publication-${crypto.randomUUID()}`
  const transport = boundFetch(fetch, { origin, principal: () => "alice", reauthorize: async () => false,
    credentialStorage: {
      get: async key => rows.get(key) ?? null,
      set: async (key, value) => { if (rejectStorage) throw new Error("Storage write refused"); rows.set(key, value) },
    },
    withCredential: action => navigator.locks.request(lock, action),
  })
  const send = () => transport(`${origin}/api/questions`, { method: "POST", body: "{}" })
  try {
    if (previous === "already verified") {
      await expect(send()).rejects.toBeDefined()
      stale = false
      expect((await send()).status).toBe(200)
      expect([writes, reads]).toEqual([2, 1])
    }
    stale = true
    delay = "120"
    rejectStorage = true
    await expect(send()).rejects.toBeDefined()
    const sent = writes
    const checked = reads
    stale = false
    vi.setSystemTime(129_999)
    await expect(send()).rejects.toMatchObject({ reason: "credential_stale" })
    expect([writes, reads]).toEqual([sent, checked])
    vi.setSystemTime(130_000)
    await expect(send()).rejects.toMatchObject({ reason: "credential_stale" })
    expect([writes, reads]).toEqual([sent, checked])
    rejectStorage = false
    expect((await send()).status).toBe(200)
    expect([writes, reads]).toEqual([sent + 1, checked + 1])
  } finally {
    vi.useRealTimers()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test.each(["lock", "storage"] as const)("a successor waits for stalled %s publication, the deadline and its owner before writing", async stalled => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(10_000)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let stale = true
  let person = "alice"
  let writes = 0
  let reads = 0
  const server = createServer((request, response) => {
    if (request.url === SESSION_ROUTE) {
      reads++
      response.writeHead(stale ? 503 : 200, stale
        ? { "x-smithers-credential": "stale", "retry-after": "120" }
        : { "content-type": "application/json" })
      response.end(stale ? undefined : JSON.stringify({ signedIn: true, personId: person, login: person, role: "member" }))
    } else { writes++; response.writeHead(200); response.end() }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const lock = `credential-successor-${crypto.randomUUID()}`
  const rows = new Map<string, string>()
  let entered!: () => void
  const enteredGate = new Promise<void>(resolve => { entered = resolve })
  const blocker = stalled === "lock" ? navigator.locks.request(lock, async () => { entered(); await gate }) : Promise.resolve()
  const storage = {
    get: async (key: string) => rows.get(key) ?? null,
    set: async (key: string, value: string) => {
      if (stalled === "storage") { entered(); await gate }
      rows.set(key, value)
    },
  }
  const transport = () => boundFetch(fetch, { origin, principal: () => "alice", credentialStorage: storage,
    withCredential: action => navigator.locks.request(lock, action),
  })
  let pending: Promise<unknown> | undefined
  try {
    if (stalled === "lock") await enteredGate
    await expect(transport()(`${origin}${SESSION_ROUTE}`)).rejects.toMatchObject({ reason: "credential_stale" })
    if (stalled === "storage") await enteredGate
    stale = false
    const successor = transport()
    const send = () => successor(`${origin}/api/questions`, { method: "POST", body: "{}" })
    let settled = false
    const attempt = send().then(value => ({ response: value }), error => ({ error })).finally(() => { settled = true })
    pending = attempt
    await vi.waitFor(async () => {
      const waiting = (await navigator.locks.query()).pending?.filter(row => row.name === lock).length ?? 0
      expect(settled || waiting >= (stalled === "lock" ? 2 : 1)).toBe(true)
    })
    expect(writes).toBe(0)
    expect(reads).toBe(1)
    release()
    await blocker
    expect(await attempt).toMatchObject({ error: { reason: "credential_stale" } })
    vi.setSystemTime(129_999)
    await expect(send()).rejects.toMatchObject({ reason: "credential_stale" })
    expect([writes, reads]).toEqual([0, 1])
    vi.setSystemTime(130_000)
    person = "bob"
    await expect(send()).rejects.toMatchObject({ reason: "credential_stale" })
    expect([writes, reads]).toEqual([0, 2])
    person = "alice"
    expect((await send()).status).toBe(200)
    expect([writes, reads]).toEqual([1, 3])
  } finally {
    release()
    await blocker
    await pending
    vi.useRealTimers()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test.each(["absent", "already verified"] as const)("a rejected publication fences a successor with an %s receipt until an ordinary request publishes it", async previous => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(10_000)
  let stale = false
  let rejectStorage = false
  let writes = 0
  let reads = 0
  let attempted!: () => void
  const rejected = new Promise<void>(resolve => { attempted = resolve })
  const rows = new Map<string, string>()
  if (previous === "already verified") rows.set("outbox:credential:alice", JSON.stringify({ until: 0, revision: "earlier", personId: "alice" }))
  const server = createServer((request, response) => {
    if (request.url === SESSION_ROUTE) {
      reads++
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ signedIn: true, personId: "alice", login: "alice", role: "member" }))
    } else {
      writes++
      response.writeHead(stale ? 503 : 200, stale ? { "x-smithers-credential": "stale", "retry-after": "120" } : {})
      response.end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const lock = `credential-rejection-${crypto.randomUUID()}`
  const controller = new AbortController()
  const transport = () => boundFetch(fetch, { origin, principal: () => "alice",
    credentialStorage: {
      get: async key => rows.get(key) ?? null,
      set: async (key, value) => { if (rejectStorage) { attempted(); throw new Error("Storage write refused") }; rows.set(key, value) },
    },
    withCredential: action => navigator.locks.request(lock, { signal: controller.signal }, action),
  })
  const observer = transport()
  const successor = transport()
  const send = (using: typeof fetch) => using(`${origin}/api/questions`, { method: "POST", body: "{}" })
  let pending: Promise<unknown> | undefined
  try {
    if (previous === "already verified") expect((await send(successor)).status).toBe(200)
    stale = true
    rejectStorage = true
    await expect(send(observer)).rejects.toMatchObject({ reason: "credential_stale" })
    await rejected
    const sent = writes
    stale = false
    let settled = false
    const attempt = send(successor).then(response => ({ response }), error => ({ error })).finally(() => { settled = true })
    pending = attempt
    await vi.waitFor(async () => {
      const waiting = (await navigator.locks.query()).pending?.some(row => row.name === lock) ?? false
      expect(settled || waiting).toBe(true)
    })
    expect(writes).toBe(sent)
    expect(settled).toBe(false)
    rejectStorage = false
    // The observer can recover from a normal read, even when only the other transport owns a queued write.
    expect((await observer(`${origin}${SESSION_ROUTE}`)).status).toBe(200)
    expect(await attempt).toMatchObject({ error: { reason: "credential_stale" } })
    vi.setSystemTime(129_999)
    await expect(send(successor)).rejects.toMatchObject({ reason: "credential_stale" })
    expect(writes).toBe(sent)
    const checked = reads
    vi.setSystemTime(130_000)
    expect((await send(successor)).status).toBe(200)
    expect([writes, reads]).toEqual([sent + 1, checked + 1])
  } finally {
    rejectStorage = false
    await observer(`${origin}${SESSION_ROUTE}`).catch(() => undefined)
    controller.abort()
    await pending
    vi.useRealTimers()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test("visitor adoption recovers an older owner's rejected publication before a successor writes", async () => {
  let principal: string = VISITOR
  let stale = true
  let rejectStorage = true
  let writes = 0
  let attempts = 0
  const rows = new Map<string, string>()
  const server = createServer((request, response) => {
    if (request.url === SESSION_ROUTE) {
      response.writeHead(stale ? 503 : 200, stale
        ? { "x-smithers-credential": "stale", "retry-after": "120" }
        : { "content-type": "application/json" })
      response.end(stale ? undefined : JSON.stringify({ signedIn: true, personId: "alice", login: "alice", role: "member" }))
    } else { writes++; response.writeHead(200); response.end() }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const lock = `credential-adoption-${crypto.randomUUID()}`
  const controller = new AbortController()
  const storage = {
    get: async (key: string) => rows.get(key) ?? null,
    set: async (key: string, value: string) => { attempts++; if (rejectStorage) throw new Error("Storage write refused"); rows.set(key, value) },
  }
  const withCredential = <A,>(action: () => Promise<A>) => navigator.locks.request(lock, { signal: controller.signal }, action)
  const observer = boundFetch(fetch, { origin, principal: () => principal, credentialStorage: storage, withCredential,
    reauthorize: async () => false,
    adopt: async () => { principal = "alice"; return "adopted" },
  })
  const session = () => observer(`${origin}${SESSION_ROUTE}`)
  let pending: Promise<unknown> | undefined
  try {
    await expect(session()).rejects.toMatchObject({ reason: "credential_stale" })
    await vi.waitFor(() => expect(attempts).toBe(1))
    stale = false
    expect((await session()).status).toBe(200)
    expect(principal).toBe("alice")
    await vi.waitFor(() => expect(attempts).toBe(2))
    await expect(observer(`${origin}/api/questions`, { method: "POST", body: "{}" }))
      .rejects.toMatchObject({ reason: "credential_stale" })
    expect(writes).toBe(0)
    const successor = boundFetch(fetch, { origin, principal: () => "alice", credentialStorage: storage, withCredential })
    let settled = false
    const attempt = successor(`${origin}/api/questions`, { method: "POST", body: "{}" })
      .then(response => ({ response }), error => ({ error })).finally(() => { settled = true })
    pending = attempt
    await vi.waitFor(async () => expect((await navigator.locks.query()).pending?.some(row => row.name === lock)).toBe(true))
    expect(writes).toBe(0)
    rejectStorage = false
    expect((await session()).status).toBe(200)
    await vi.waitFor(() => expect(rows.has(`outbox:credential:${encodeURIComponent(VISITOR)}`)).toBe(true))
    expect(rows.has("outbox:credential:alice")).toBe(false)
    await vi.waitFor(() => expect(settled).toBe(true))
    expect(await attempt).toMatchObject({ response: { status: 200 } })
    expect(writes).toBe(1)
  } finally {
    // Release the original owner's fence even on the pre-fix failure; this is test cleanup only.
    principal = VISITOR
    rejectStorage = false
    await session().catch(() => undefined)
    controller.abort()
    await pending
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
