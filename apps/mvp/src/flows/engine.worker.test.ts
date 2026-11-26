import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { type SharedSqlite } from "@smthrs/platform-browser"
import { Effect, Fiber, Stream } from "effect"
import { expect, test, vi } from "vitest"
import { IDENTITY_MESSAGE, type Receipt, VISITOR } from "../device/identity.vibe"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA, SESSION_ROUTE, type SessionState } from "../features/auth/contract"
import { AUTH_FAULTS_CHANNEL } from "../test/authFaults"
import { workerHost, type EngineWorkerHost } from "./engineHost.worker"
import { engineWorker } from "./engineWorker.vibe"

const visitor: SessionState = { signedIn: false, available: true }
const sessionTag = "abcd0123".repeat(4)
const member: SessionState = { signedIn: true, login: "member", personId: "person-1", role: "member", session: sessionTag }

const fixture = async (name = "", initial: SessionState = visitor) => {
  let session = initial
  const reads: Array<string> = []
  const server = createServer((request, response) => {
    if (request.url === SESSION_ROUTE) {
      reads.push(SESSION_ROUTE)
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(session))
    } else if (request.url === "/api/owner") {
      response.end(request.headers[DEVICE_PERSON_HEADER])
    } else if (request.url?.startsWith("/api/telemetry/")) {
      response.writeHead(204).end()
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port
  const { port1, port2 } = new MessageChannel()
  const scope = Object.assign(port1, { location: new URL(origin), name, fetch: globalThis.fetch })
  const host = workerHost(scope)
  const page = new BroadcastChannel(IDENTITY_MESSAGE)
  const broadcasts: Array<Receipt> = []
  const tabReceipts: Array<Receipt> = []
  page.onmessage = (event) => { broadcasts.push(event.data) }
  port2.onmessage = (event) => { tabReceipts.push(event.data) }

  const sqlite = new DatabaseSync(":memory:")
  let storageFault = false
  const database: SharedSqlite.Service = {
    execute: (sql, args = []) => {
      if (storageFault) return Effect.die(new Error("device storage unavailable"))
      return Effect.sync(() => {
        const statement = sqlite.prepare(sql)
        const values = args as ReadonlyArray<SQLInputValue>
        if (statement.columns().length > 0) return statement.all(...values)
        statement.run(...values)
        return []
      })
    },
  }

  const requests: Array<unknown> = []
  const bindings: Array<Parameters<EngineWorkerHost["bindFetch"]>[0]> = []
  const program = (development: boolean, started = fetch(origin + SESSION_ROUTE)) => engineWorker({
    ...host,
    requests: host.requests.pipe(Stream.tap((event) => Effect.sync(() => { requests.push(event.data) }))),
    bindFetch: (binding) => {
      bindings.push(binding)
      host.bindFetch(binding)
    },
  }, development, started, origin + "/sqlite.wasm")

  return {
    broadcasts,
    tabReceipts,
    requests,
    reads,
    page,
    scope,
    sqlite,
    database,
    program,
    setSession: (next: SessionState) => { session = next },
    failStorage: (fail: boolean) => { storageFault = fail },
    principal: async () => (await scope.fetch(origin + "/api/owner")).text(),
    sessionTag: () => bindings[0]?.sessionTag?.(),
    async close() {
      page.close()
      port1.close()
      port2.close()
      sqlite.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
        server.closeAllConnections()
      })
    },
  }
}

test("the worker answers followers in order and adopts visitor data without restarting", async () => {
  const device = await fixture("dev:faults=session-503")
  // A production build treats the worker name as ordinary text.
  const { options } = device.program(false)
  const runtime = Effect.runFork(Effect.never.pipe(Effect.provide(options.telemetry)))
  try {
    expect(await device.principal()).toBe(NO_DEVICE_DATA)
    expect(device.sessionTag()).toBeUndefined()
    device.page.postMessage({ request: true })
    await vi.waitFor(() => expect(device.requests).toHaveLength(1))
    expect(device.broadcasts).toEqual([])

    await Effect.runPromise(options.authorize(device.database))
    await vi.waitFor(() => expect(device.tabReceipts).toHaveLength(1))
    const opened = { _tag: IDENTITY_MESSAGE, owner: VISITOR, outcome: "visitor" }
    expect(device.tabReceipts).toEqual([opened])
    expect(device.reads).toEqual([SESSION_ROUTE])
    expect(await device.principal()).toBe(VISITOR)

    device.page.postMessage(null)
    device.page.postMessage({ request: false })
    device.page.postMessage({ request: true })
    await vi.waitFor(() => expect(device.broadcasts).toEqual([opened, opened]))

    device.failStorage(true)
    device.page.postMessage({ request: "adopt" })
    await vi.waitFor(() => expect(device.broadcasts.at(-1)).toEqual({ ...opened, outcome: "unavailable" }))
    expect(device.tabReceipts).toEqual([opened])
    device.failStorage(false)

    device.setSession(member)
    device.page.postMessage({ request: "adopt" })
    const adopted = { _tag: IDENTITY_MESSAGE, owner: member.personId, outcome: "verified", sessionTag }
    await vi.waitFor(() => expect(device.tabReceipts).toEqual([opened, adopted]))
    expect(await device.principal()).toBe(member.personId)
    expect(device.sessionTag()).toBe(sessionTag)

    device.page.postMessage({ request: "adopt" })
    await vi.waitFor(() => expect(device.broadcasts).toHaveLength(5))
    expect(device.broadcasts.at(-1)).toEqual(adopted)
    expect(device.tabReceipts).toHaveLength(2)

    device.sqlite.exec("UPDATE smithers_device_identity SET owns_unstamped = 1")
    await Effect.runPromise(options.authorize(device.database))
    await vi.waitFor(() => expect(device.tabReceipts.at(-1)).toEqual({ ...adopted, continuous: true }))
  } finally {
    await Effect.runPromise(Fiber.interrupt(runtime))
    await device.close()
  }
})

test("an adoption refused for a different recorded owner seals future answers", async () => {
  const device = await fixture("dev:other=1")
  const { options } = device.program(true)
  const runtime = Effect.runFork(Effect.never.pipe(Effect.provide(options.telemetry)))
  try {
    await Effect.runPromise(options.authorize(device.database))
    await vi.waitFor(() => expect(device.broadcasts).toHaveLength(1))
    device.sqlite.prepare("UPDATE smithers_device_identity SET person_id = ?").run("another-person")
    device.setSession(member)
    device.page.postMessage({ request: "adopt" })

    const refused = { _tag: IDENTITY_MESSAGE, owner: undefined, outcome: "changed" }
    await vi.waitFor(() => expect(device.tabReceipts.at(-1)).toEqual(refused))
    device.page.postMessage({ request: true })
    await vi.waitFor(() => expect(device.requests).toHaveLength(2))
    expect(device.broadcasts).toEqual([{ _tag: IDENTITY_MESSAGE, owner: VISITOR, outcome: "visitor" }, refused])
    expect(await device.principal()).toBe(NO_DEVICE_DATA)
  } finally {
    await Effect.runPromise(Fiber.interrupt(runtime))
    await device.close()
  }
})

test("the development fault bypasses the early read until the page heals it", async () => {
  const device = await fixture("dev:faults=session-503", member)
  const page = new BroadcastChannel(AUTH_FAULTS_CHANNEL)
  const started = fetch(device.scope.location.origin + SESSION_ROUTE)
  const program = device.program(true, started)
  const runtime = await program.start()
  try {
    await started
    await Effect.runPromise(program.options.authorize(device.database))
    await vi.waitFor(() => expect(device.tabReceipts.at(-1)).toMatchObject({ owner: VISITOR, outcome: "visitor" }))
    expect(device.reads).toEqual([SESSION_ROUTE])

    page.postMessage("heal")
    await vi.waitFor(async () => {
      await Effect.runPromise(program.options.authorize(device.database))
      expect(await device.principal()).toBe(member.personId)
    })
    expect(device.reads.length).toBeGreaterThanOrEqual(2)
  } finally {
    page.close()
    await Effect.runPromise(Fiber.interrupt(runtime))
    await device.close()
  }
})

test("the worker entry starts its first session read and installs the device-bound fetch", async () => {
  const device = await fixture()
  const previous = Object.getOwnPropertyDescriptor(globalThis, "self")
  Object.defineProperty(globalThis, "self", { configurable: true, value: device.scope })
  try {
    await import("./engine.worker.vibe")
    await vi.waitFor(() => expect(device.reads).toEqual([SESSION_ROUTE]))
    expect(await device.principal()).toBe(NO_DEVICE_DATA)
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "self")
    else Object.defineProperty(globalThis, "self", previous)
    await device.close()
  }
})
