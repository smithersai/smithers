// The branch object's socket plumbing that needs no container (worker/BranchSandboxes.vibe over
// worker/durable/SocketPumps.vibe): the lapsed-lease notifier the object builds once, and the order a viewer is
// registered and its terminal started in. The object itself, over its real container, runs under `alchemy dev`.
import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy"
import { Clock, Console, Context, Deferred, Effect, Exit, Fiber, Layer, Metric, Option, Redacted, Scope } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, test, vi } from "vitest"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { Miniflare, Response as WorkerResponse, WebSocketPair as WorkerSocketPair } from "miniflare"
import { TestClock } from "effect/testing"
import { join, relative } from "node:path"
import { sourceText } from "../../../packages/repo-targets/test-utils/source-readers.mjs"
import * as TestDatabase from "../db/TestDatabase.ts"
import { WORKSPACE } from "../src/features/terminal/contract.ts"
import * as BranchSandboxes from "./BranchSandboxes.vibe"
import { Machines, type CommandRequest } from "./branch/Machines.vibe"
import { Sandboxes, type Attachment } from "./branch/Sandboxes.vibe"
import * as Artifacts from "./branch/Artifacts.vibe"
import type { Bucket } from "./branch/Artifacts.vibe"
import { SecretKeys } from "./secrets/Keys.vibe"
import * as SecretStore from "./secrets/Store.vibe"
import * as SandboxEgress from "./secrets/SandboxEgress.vibe"
import * as Overflow from "./runners/Overflow.vibe"
import { sealContext } from "./personal/Models.vibe"
import * as PersonalStore from "./personal/Store.vibe"
import { admissionOf, forward } from "./SocketAccess.vibe"
import { memory } from "./test/box.ts"
import { connection, objectRegistration, objectRuntime, unusedDatabase } from "./test/durableObject.ts"
import * as SocketPumps from "./durable/SocketPumps.vibe"
import * as SocketAccess from "./SocketAccess.vibe"
import { type ContainerExec, withDockerSandbox } from "./test/branchContainer.ts"

/** A renewal that dies is counted here, as the object logs it. */
const died = (causes: Array<string>) => () => Effect.sync(() => void causes.push("died"))

/** What the object's renewal reads from its own services: who built it. */
class Host extends Context.Service<Host, { readonly name: string }>()("@smthrs/mvp/test/BranchSandboxesHost") {}

describe("the object's lapsed-lease notifier", () => {
  test("is built once with the object's services and renews from a socket's event after the request that attached it ended", async () => {
    const scope = Effect.runSync(Scope.make())
    const ran: Array<string> = []
    let done = Deferred.makeUnsafe<void>()
    const renewDue = Effect.gen(function*() {
      ran.push((yield* Host).name)
      Deferred.doneUnsafe(done, Effect.void)
    })
    // The object's construction: the only place the renewal's services are given.
    const lapsed = await Effect.runPromise(
      SocketPumps.lapsedRenewals(renewDue, scope, died([])).pipe(Effect.provideService(Host, { name: "object" })),
    )
    // A first socket's request comes and goes, its own scope closed, before any frame lapses.
    await Effect.runPromise(Effect.scoped(Effect.provideService(Effect.void, Host, { name: "request-1" })))

    // A socket's own event, outside any effect: no runtime is handed in and none is captured per request.
    lapsed()
    await Effect.runPromise(Deferred.await(done))
    done = Deferred.makeUnsafe<void>()
    // A second socket, attached by another request, shares the one notifier.
    await Effect.runPromise(Effect.scoped(Effect.provideService(Effect.void, Host, { name: "request-2" })))
    lapsed()
    await Effect.runPromise(Deferred.await(done))

    expect(ran).toEqual(["object", "object"])
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test("a burst of frames on lapsed leases costs one renewal, and the next burst one more", async () => {
    const scope = Effect.runSync(Scope.make())
    let runs = 0
    const started = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let finished = Deferred.makeUnsafe<void>()
    const renewDue = Effect.gen(function*() {
      runs += 1
      Deferred.doneUnsafe(started, Effect.void)
      yield* Deferred.await(release)
    }).pipe(Effect.ensuring(Effect.sync(() => void Deferred.doneUnsafe(finished, Effect.void))))
    const lapsed = await Effect.runPromise(SocketPumps.lapsedRenewals(renewDue, scope, died([])))

    for (let frame = 0; frame < 50; frame++) lapsed()
    await Effect.runPromise(Deferred.await(started))
    for (let frame = 0; frame < 50; frame++) lapsed()
    Deferred.doneUnsafe(release, Effect.void)
    await Effect.runPromise(Deferred.await(finished))
    expect(runs).toBe(1)

    finished = Deferred.makeUnsafe<void>()
    lapsed()
    await Effect.runPromise(Deferred.await(finished))
    expect(runs).toBe(2)
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test("a renewal that dies doesn't stop the object's later renewals", async () => {
    const scope = Effect.runSync(Scope.make())
    let runs = 0
    let finished = Deferred.makeUnsafe<void>()
    const renewDue = Effect.suspend(() => (++runs === 1 ? Effect.die("renewal broke") : Effect.void)).pipe(
      Effect.ensuring(Effect.sync(() => void Deferred.doneUnsafe(finished, Effect.void))),
    )
    const deaths: Array<string> = []
    const lapsed = await Effect.runPromise(SocketPumps.lapsedRenewals(renewDue, scope, died(deaths)))

    lapsed()
    await Effect.runPromise(Deferred.await(finished))
    finished = Deferred.makeUnsafe<void>()
    lapsed()
    await Effect.runPromise(Deferred.await(finished))

    expect(runs).toBe(2)
    expect(deaths).toEqual(["died"])
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test("the object runs no Effect through a captured runtime and binds no unused clock", () => {
    const source = sourceText(new URL("./BranchSandboxes.vibe", import.meta.url))
    for (const banned of ["runForkWith", "Effect.runFork", "Effect.runPromise", "Effect.runSync", "Effect.clockWith"]) {
      expect(source).not.toContain(banned)
      expect(sourceText(new URL("./durable/SocketPumps.vibe", import.meta.url))).not.toContain(banned)
    }
    // The object's own notifier and registration order are the ones it attaches sockets with.
    expect(source).toContain("SocketPumps.lapsedRenewals(")
    expect(source).toContain("SocketPumps.attachRegistered(")
    // The fetch client is named only as the default of the client the hosting program injects (`live`, `gateLive`):
    // no handler provides its own.
    expect(source.match(/FetchHttpClient\.layer/g)).toHaveLength(2)
    expect(source.match(/http: ObjectHttp = FetchHttpClient\.layer/g)).toHaveLength(2)
  })
})

describe("attaching a socket", () => {
  test("registers the viewer before its terminal starts, so a terminal that ends at once removes its own entry", async () => {
    const scope = Effect.runSync(Scope.make())
    const attached = new Map<string, Fiber.Fiber<string>>()
    const seen: Array<string> = []
    let startedAtRegistration: boolean | undefined
    let started = false

    const fiber = await Effect.runPromise(SocketPumps.attachRegistered(
      (registered) =>
        // A terminal that closes immediately: it ends without ever suspending once it may start.
        Effect.andThen(registered, Effect.sync(() => {
          started = true
          seen.push(attached.has("socket") ? "registered" : "missing")
          return "closed"
        })).pipe(Effect.ensuring(Effect.sync(() => attached.delete("socket")))),
      (registering) => {
        startedAtRegistration = started
        attached.set("socket", registering)
      },
      scope,
    ))

    expect(await Effect.runPromise(Fiber.join(fiber))).toBe("closed")
    expect(startedAtRegistration).toBe(false)
    expect(seen).toEqual(["registered"])
    // Nothing is left behind for a socket that is gone.
    expect(attached.size).toBe(0)
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test("the registered pump stays interruptible, and interrupting it runs its release", async () => {
    const scope = Effect.runSync(Scope.make())
    const attached = new Map<string, Fiber.Fiber<never>>()
    const running = Deferred.makeUnsafe<void>()

    const fiber = await Effect.runPromise(SocketPumps.attachRegistered(
      (registered) =>
        Effect.andThen(registered, Effect.andThen(Deferred.succeed(running, undefined), Effect.never)).pipe(
          Effect.ensuring(Effect.sync(() => attached.delete("socket"))),
        ),
      (registering) => void attached.set("socket", registering),
      scope,
    ))
    await Effect.runPromise(Deferred.await(running))
    expect(attached.get("socket")).toBe(fiber)

    const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(attached.size).toBe(0)
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// worker/durable/SocketPumps.vibe holds per-object waits, as worker/durable/SocketHost.vibe does
// (worker/durable/boundary.test.ts): only the Durable Object that owns the sockets, and tests, may import it.
test("only the branch object imports the socket pump coordinators", () => {
  const root = import.meta.dirname
  const walk = (dir: string): Array<string> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full)
      return entry.name.endsWith(".ts") || entry.name.endsWith(".vibe") ? [full] : []
    })
  const importers = walk(root)
    .map((file) => relative(root, file).replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".test.ts") && !file.includes("/test/") && !file.startsWith("durable/"))
    .filter((file) => /from\s+["'][^"']*durable\/SocketPumps/.test(sourceText(new URL(`./${file}`, import.meta.url))))
  expect(importers).toEqual(["BranchSandboxes.vibe"])
})

const branch = { branchId: "branch-1", owner: "octo", name: "widgets", branch: "main" }
const sandboxRequest = HttpServerRequest.fromWeb(new Request("https://chat.test/terminal", {
  headers: { "x-smithers-ticket": "spoofed", "x-smithers-extra": "remove", "x-keep": "present" },
}))

test("identifies requests from only valid sandbox object props", () => {
  const { BOX_PROP, MACHINE_PROP, boxOf } = BranchSandboxes
  for (const props of [undefined, null, 42, {}, { [BOX_PROP]: 42 }, { [BOX_PROP]: "" }]) {
    expect(boxOf(props)).toBeUndefined()
  }
  expect(boxOf({ [BOX_PROP]: "id" })).toEqual({ id: "id" })
  expect(boxOf({ [BOX_PROP]: "id", [MACHINE_PROP]: "" })).toEqual({ id: "id" })
  expect(boxOf({ [BOX_PROP]: "id", [MACHINE_PROP]: "gate" })).toEqual({ id: "id", machine: "gate" })
})

const objectNamespace = (fixture: {
  readonly rpc?: Partial<BranchSandboxes.SandboxObjectShape>
  readonly fetch?: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse>
}) => {
  const rpc = { ...fixture.rpc, fetch: fixture.fetch }
  return {
    getByName: (id: string) => {
      expect(id).toBe(branch.branchId)
      return rpc
    },
    idFromString: (id: string) => {
      if (id !== "object-id") throw new Error("invalid object id")
      return id
    },
    get: (id: string) => {
      expect(id).toBe("object-id")
      return rpc
    },
  } as unknown as Parameters<typeof BranchSandboxes.sandboxesOver>[0]
}

test("the sandbox adapter keeps successful generations and preserves wake and session failures", async () => {
  let wake: BranchSandboxes.Woken = { _tag: "Woken", generation: 7 }
  let ready = true
  const kept: Array<readonly [string, number, string | undefined]> = []
  const objects = objectNamespace({ rpc: {
    wake: (from, ownerId) => Effect.sync(() => {
      expect(from).toEqual(branch)
      expect(ownerId).toBe("person")
      return wake
    }),
    session: (id, ownerId) => Effect.sync(() => {
      expect([id, ownerId]).toEqual(["term-1", "person"])
      return ready
    }),
  } })
  const keep: BranchSandboxes.Keep = (id, generation, machine) => Effect.sync(() => void kept.push([id, generation, machine]))
  await Effect.runPromise(Effect.gen(function* () {
    const sandboxes = yield* Sandboxes
    expect(yield* sandboxes.wake(branch, "person")).toEqual({ generation: 7 })
    yield* sandboxes.session(branch.branchId, "term-1", "person")
    wake = { _tag: "Waiting" }
    expect(yield* Effect.flip(sandboxes.wake(branch, "person"))).toMatchObject({ reason: "waiting" })
    wake = { _tag: "Unavailable" }
    expect(yield* Effect.flip(sandboxes.wake(branch, "person"))).toMatchObject({ reason: "start" })
    wake = { _tag: "CheckoutFailed", exitCode: 75, checkoutFailure: "clone", checkoutTransportCause: "http_status", checkoutHttpStatus: 502 }
    expect(yield* Effect.flip(sandboxes.wake(branch, "person"))).toMatchObject({
      exitCode: 75,
      checkoutFailure: "clone",
      checkoutTransportCause: "http_status",
      checkoutHttpStatus: 502,
    })
    ready = false
    expect(yield* Effect.flip(sandboxes.session(branch.branchId, "term-1", "person"))).toMatchObject({ reason: "exec" })
    expect(kept).toEqual([[branch.branchId, 7, undefined]])
    const untracked = yield* BranchSandboxes.sandboxesOver(objects)
    wake = { _tag: "Woken", generation: 8 }
    expect(yield* untracked.wake(branch, "person")).toEqual({ generation: 8 })
  }).pipe(
    Effect.provide(BranchSandboxes.sandboxesLayer(objects, keep)),
    Effect.provideService(RuntimeContext, objectRuntime),
  ))
})

test("the terminal adapter replaces caller headers with its own one-use ticket and admission", async () => {
  const calls: Array<string> = []
  const admission: Attachment["admission"] = {
    session: null, alias: null, expiresAt: null, admittedAt: 0,
    principal: "viewer", role: null, basis: { kind: "terminal", branchId: branch.branchId }, access: "read",
  }
  const attachment = { terminalId: "term-1", ownerId: "owner", access: "read", principal: "viewer", role: null, admission } as const
  const objects = objectNamespace({
    rpc: {
      ticket: () => Effect.sync(() => {
        calls.push("ticket")
        return "object-ticket"
      }),
      alive: (id, ownerId) => Effect.succeed(id === attachment.terminalId && ownerId === attachment.ownerId),
      enforce: (policy, revoked) => Effect.sync(() => {
        expect(policy).toEqual({ createdBy: null, grants: {} })
        expect(revoked).toEqual([{ terminalId: "term-1", ownerId: "owner" }])
        calls.push("enforce")
      }),
    },
    fetch: (request) => Effect.sync(() => {
      calls.push("fetch")
      expect(request.headers).toMatchObject({
        "x-smithers-ticket": "object-ticket",
        "x-smithers-terminal": "term-1",
        "x-smithers-owner": "owner",
        "x-smithers-principal": "viewer",
        "x-smithers-access": "read",
        "x-smithers-role": "",
        "x-keep": "present",
      })
      expect(request.headers).not.toHaveProperty("x-smithers-extra")
      expect(admissionOf(request)).toEqual(admission)
      return HttpServerResponse.empty({ status: 101 })
    }),
  })
  await Effect.runPromise(Effect.gen(function* () {
    const terminals = yield* BranchSandboxes.terminalSocketsOver(objects)
    expect((yield* terminals.attach(branch.branchId, attachment)).status).toBe(101)
    expect(yield* terminals.alive(branch.branchId, "term-1", "owner")).toBe(true)
    yield* terminals.enforce(branch.branchId, { createdBy: null, grants: {} }, [{ terminalId: "term-1", ownerId: "owner" }])
    expect(calls).toEqual(["ticket", "fetch", "enforce"])
  }).pipe(
    Effect.provideService(RuntimeContext, objectRuntime),
    Effect.provideService(HttpServerRequest.HttpServerRequest, sandboxRequest),
  ))
})

test("box requests and machine methods use the named namespace, and missing machines fail closed", async () => {
  const calls: Array<unknown> = []
  const objects = objectNamespace({ fetch: () => Effect.succeed(HttpServerResponse.empty({ status: 204 })) })
  const gate = objectNamespace({
    fetch: () => Effect.succeed(HttpServerResponse.empty({ status: 202 })),
    rpc: {
      command: (target, ownerId, request: CommandRequest) => Effect.sync(() => {
        calls.push([target, ownerId, request])
        return { _tag: "Cancelled" as const }
      }),
      tool: (target, ownerId, callId, call) => Effect.sync(() => {
        calls.push([target, ownerId, callId, call])
        return { _tag: "Lost" as const }
      }),
      sleepIfIdle: (generation, idleMs) => Effect.sync(() => {
        calls.push([generation, idleMs])
        return "slept" as const
      }),
    },
  })
  const objectsFor = BranchSandboxes.namespaces(objects, gate)
  const gateBranch = { ...branch, machine: "gate" }
  await Effect.runPromise(Effect.gen(function* () {
    const machines = yield* Machines
    expect((yield* BranchSandboxes.answerBox(objectsFor, { id: "object-id" })).status).toBe(204)
    expect((yield* BranchSandboxes.answerBox(objectsFor, { id: "object-id", machine: "gate" })).status).toBe(202)
    expect((yield* BranchSandboxes.answerBox(objectsFor, { id: "object-id", machine: "unknown" })).status).toBe(502)
    expect((yield* BranchSandboxes.answerBox(objectsFor, { id: "bad-id" })).status).toBe(502)
    yield* machines.commands(gateBranch, "person").cancel("command-1")
    const read = { tool: "read", path: "README.md" } as const
    expect(yield* Effect.flip(machines.tool(gateBranch, "person", "call-1", read))).toMatchObject({ _tag: expect.stringMatching(/ToolLost$/) })
    expect(yield* machines.sleepIfIdle(branch.branchId, 6, 1000, "gate")).toBe("slept")
    expect(yield* Effect.flip(machines.sleepIfIdle(branch.branchId, 6, 1000, "unknown"))).toMatchObject({ reason: "undeclared" })
    expect(calls).toEqual([
      [gateBranch, "person", { op: "cancel", key: "command-1" }],
      [gateBranch, "person", "call-1", read],
      [6, 1000],
    ])
  }).pipe(
    Effect.provide(BranchSandboxes.machinesLayer(objectsFor)),
    Effect.provideService(RuntimeContext, objectRuntime),
    Effect.provideService(HttpServerRequest.HttpServerRequest, sandboxRequest),
  ))
})

test.each([undefined, "fixture/gate:local"])("registers the gate only when its image is declared (%s)", async (image) => {
  const gate = objectRegistration("GateObject", image === undefined ? {} : { GATE_IMAGE: image })
  const main = objectRegistration("SandboxObject")
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* Layer.build(BranchSandboxes.live(connection, {}, connection)).pipe(Effect.provideContext(main.services))
    yield* Layer.build(BranchSandboxes.gateLive(connection, {}, connection)).pipe(Effect.provideContext(gate.services))
    expect(main.exports.get("SandboxObject")).toMatchObject({ kind: "durableObject" })
    if (image === undefined) expect(gate.exports.has("GateObject")).toBe(false)
    else expect(gate.exports.get("GateObject")).toMatchObject({ kind: "durableObject" })
  })).pipe(
    Effect.provideService(Cloudflare.Hyperdrive.Connect, unusedDatabase),
    Effect.provideService(Cloudflare.R2.ReadWriteBucket, () => Effect.die("bucket is bound during object construction")),
  ))
})

type SandboxHandlers = BranchSandboxes.SandboxObjectShape & {
  readonly fetch: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>
}

const sandboxRegistration = (container: object, options: {
  readonly config?: Record<string, string>
  readonly gate?: Bucket
  readonly http?: BranchSandboxes.ObjectHttp
  readonly storage?: ReturnType<typeof memory>["store"]
  readonly checkConnection?: typeof connection
  readonly checks?: Parameters<typeof BranchSandboxes.live>[1]
} = {}) => {
  const name = options.gate === undefined ? "SandboxObject" : "GateObject"
  const { exports, services } = objectRegistration(name, {
    SANDBOX_IMAGE: "fixture/sandbox:local",
    ...(options.gate === undefined ? {} : { GATE_IMAGE: "fixture/gate:local" }),
    ...options.config,
  })
  const { store, map } = memory()
  const storage = options.storage ?? store
  const forwarded: Array<Record<string, string>> = []
  const state = {
    id: { toString: () => "object-id" },
    storage: { ...storage, list: ({ prefix }: { prefix: string }) => storage.list(prefix) },
    container,
    raw: { exports: { default: ({ props }: { props: Record<string, string> }) => {
      forwarded.push(props)
      return { fetch: () => Promise.reject(new Error("unexpected loopback fetch")) }
    } } },
  } as unknown as Cloudflare.DurableObjectState["Service"]
  const initialize = Effect.gen(function* () {
    const args = [connection, options.checks ?? {}, options.checkConnection ?? connection, options.http] as const
    if (options.gate === undefined) yield* Layer.build(BranchSandboxes.live(...args))
    else yield* Layer.build(BranchSandboxes.gateLive(...args))
    const entry = exports.get(name) as {
      readonly constructor: Effect.Effect<Effect.Effect<SandboxHandlers, never, RuntimeContext>, never, Cloudflare.DurableObjectState>
    }
    return yield* (yield* entry.constructor)
  }).pipe(
    Effect.provideContext(services),
    Effect.provideService(Cloudflare.R2.ReadWriteBucket, () =>
      options.gate === undefined
        ? Effect.die("unexpected artifact bucket")
        : Effect.succeed({ raw: Effect.succeed(options.gate) } as never)),
    Effect.provideService(Cloudflare.DurableObjectState, state),
    Effect.provideService(RuntimeContext, objectRuntime),
  )
  return { initialize, forwarded, map }
}

const terminalId = "00000000-0000-4000-8000-000000000001"

const fetchSandbox = (sandbox: SandboxHandlers, request: Request | HttpServerRequest.HttpServerRequest) =>
  sandbox.fetch.pipe(Effect.provideService(
    HttpServerRequest.HttpServerRequest,
    request instanceof Request ? HttpServerRequest.fromWeb(request) : request,
  ))

const withScratchDatabase = Effect.gen(function* () {
  const scratch = yield* TestDatabase.Scratch
  const url = yield* TestDatabase.serverUrl
  url.searchParams.set("options", `-c search_path=${scratch.name}`)
  return Effect.map(unusedDatabase(), (binding) => ({
    ...binding, connectionString: Effect.succeed(Redacted.make(url.toString())),
  }))
})

test("the registered sandbox rejects a replayed ticket and checks aliveness without starting its container", async () => {
  const { initialize, forwarded } = sandboxRegistration({ running: false })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sandbox = yield* initialize
    expect(forwarded).toEqual([{ sandboxObject: "object-id" }])
    expect(yield* sandbox.alive(terminalId, "owner")).toBe(false)
    expect(yield* sandbox.alive("invalid/terminal", "owner")).toBe(false)

    const fetch = (url: string, headers?: Record<string, string>) => sandbox.fetch.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(url, { headers }))),
    )
    const ticket = yield* sandbox.ticket()
    expect(ticket).toMatch(/^[0-9a-f-]{36}$/)
    expect((yield* fetch("https://egress.invalid/", { "x-smithers-ticket": ticket })).status).toBe(400)
    expect((yield* fetch("https://egress.invalid/", { "x-smithers-ticket": ticket })).status).toBe(403)
    expect((yield* fetch("http://forge.smithers.internal/")).status).toBe(403)

    const expired: Attachment["admission"] = {
      session: "ended-session",
      alias: null,
      expiresAt: 1,
      admittedAt: 0,
      principal: "viewer",
      role: "member",
      basis: { kind: "terminal", branchId: branch.branchId },
      access: "write",
    }
    const upgrade = forward(sandboxRequest, expired, {
      "x-smithers-ticket": yield* sandbox.ticket(),
      "x-smithers-terminal": terminalId,
      "x-smithers-owner": "owner",
      "x-smithers-principal": "viewer",
      "x-smithers-access": "write",
    })
    expect((yield* sandbox.fetch.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, upgrade))).status).toBe(401)
    yield* sandbox.enforce({ createdBy: null, grants: {} }, [{ terminalId, ownerId: "owner" }])
  })).pipe(
    Effect.provideService(Cloudflare.Hyperdrive.Connect, unusedDatabase),
    Effect.provideService(RuntimeContext, objectRuntime),
  ))
})

test("the sandbox reserves a real budget slot, keeps checkout diagnostics, and reuses its running generation", async () => {
  let checkoutCode = 70
  let startRefused = false
  const starts: Array<unknown> = []
  const commands: Array<ReadonlyArray<string>> = []
  const intercepts: Array<string> = []
  const container = {
    running: false,
    start(options: unknown) {
      if (startRefused) throw new Error("container failed to start")
      this.running = true
      starts.push(options)
    },
    monitor: () => Promise.resolve(),
    setInactivityTimeout: () => Promise.resolve(),
    interceptOutboundHttp: async (host: string) => void intercepts.push(host),
    interceptAllOutboundHttp: () => Promise.resolve(),
    interceptOutboundHttps: () => Promise.resolve(),
    exec: async (argv: ReadonlyArray<string>) => {
      commands.push(argv)
      return {
        pid: commands.length,
        isPty: false,
        stdin: new WritableStream(),
        stdout: new ReadableStream({ start: (stream) => stream.close() }),
        stderr: new ReadableStream({ start: (stream) => stream.close() }),
        exitCode: Promise.resolve(argv[3] === "checkout" ? checkoutCode : 0),
        kill: () => {},
      }
    },
  }
  const { initialize, map } = sandboxRegistration(container)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const hyperdrive = yield* withScratchDatabase
    const sandbox = yield* initialize.pipe(Effect.provideService(Cloudflare.Hyperdrive.Connect, () => hyperdrive))

    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO sandbox_limits (audience, awake, awake_per_person, monthly_alert_usd, updated_by) VALUES ('admin', 1, 1, 100, 'test')`
    yield* sql`INSERT INTO sandbox_generations (branch_id, kind) VALUES ('already-awake', 'branch')`
    expect(yield* sandbox.wake(branch)).toEqual({ _tag: "Waiting" })
    expect(starts).toEqual([])
    yield* sql`UPDATE sandbox_generations SET ended_at = now() WHERE branch_id = 'already-awake'`

    startRefused = true
    expect(yield* sandbox.wake(branch)).toEqual({ _tag: "Unavailable" })
    expect(yield* sql`SELECT generation FROM sandbox_generations WHERE branch_id = ${branch.branchId} AND ended_at IS NULL`).toEqual([])
    startRefused = false
    expect(yield* sandbox.wake(branch)).toEqual({
      _tag: "CheckoutFailed",
      exitCode: 70,
      checkoutFailure: "forge",
      checkoutTransportCause: "unknown",
      checkoutForge: { routing: "unreached" },
    })
    checkoutCode = 99
    expect(yield* sandbox.wake(branch)).toEqual({
      _tag: "CheckoutFailed",
      exitCode: 99,
      checkoutFailure: "other",
      checkoutTransportCause: "unknown",
      checkoutForge: { routing: "unreached" },
    })
    checkoutCode = 0
    expect(yield* sandbox.wake(branch)).toEqual({ _tag: "Woken", generation: 1 })
    expect(starts).toEqual([{ enableInternet: false, instance: "standard-1" }])
    expect(intercepts).toEqual(Array(3).fill("forge.smithers.internal"))
    expect(map.get("restored")).toBe(1)
    expect(yield* sql`SELECT generation FROM sandbox_generations WHERE branch_id = ${branch.branchId} AND ended_at IS NULL`).toEqual([{ generation: 1 }])
    expect(yield* sandbox.alive(terminalId, "owner")).toBe(true)
    expect(yield* sandbox.sleepIfIdle(2, 1000)).toBe("gone")
    yield* sandbox.enforce({ createdBy: null, grants: {} }, [{ terminalId: "invalid", ownerId: "owner" }, { terminalId, ownerId: "owner" }])
    expect(commands.filter((args) => args[0] === "tmux")).toEqual([
      ["tmux", "has-session", "-t", `=${terminalId}`],
      ["tmux", "kill-session", "-t", `=${terminalId}`],
    ])
  })).pipe(
    Effect.provide(TestDatabase.layer("branch_sandbox_object")),
    Effect.provideService(RuntimeContext, objectRuntime),
  ))
})

test("sandbox checkout classifies bounded transport causes from stderr without logging raw stderr or secrets", async () => {
  const secret = "tok_checkout_stderr_secret_sentinel"
  const logLines: Array<string> = []
  const testConsole: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (value: unknown) => {
      if (typeof value === "string") logLines.push(value)
    },
  })
  let checkoutCode = 75
  let checkoutStderr = ""
  const container = {
    running: true,
    start: () => {},
    monitor: () => Promise.resolve(),
    setInactivityTimeout: () => Promise.resolve(),
    interceptOutboundHttp: async () => {},
    interceptAllOutboundHttp: () => Promise.resolve(),
    interceptOutboundHttps: () => Promise.resolve(),
    exec: async (argv: ReadonlyArray<string>) => {
      const payload = argv[3] === "checkout" ? checkoutStderr : ""
      return {
        pid: 1,
        isPty: false,
        stdin: new WritableStream(),
        stdout: new ReadableStream({ start: (stream) => stream.close() }),
        stderr: new ReadableStream({
          start: (stream) => {
            if (payload !== "") stream.enqueue(new TextEncoder().encode(payload))
            stream.close()
          },
        }),
        exitCode: Promise.resolve(argv[3] === "checkout" ? checkoutCode : 0),
        kill: () => {},
      }
    },
  }
  const { initialize } = sandboxRegistration(container)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const hyperdrive = yield* withScratchDatabase
    const sandbox = yield* initialize.pipe(Effect.provideService(Cloudflare.Hyperdrive.Connect, () => hyperdrive))
    const scenarios = [
      {
        code: 75,
        stderr: `error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502 (${secret})\n`,
        expected: { _tag: "CheckoutFailed", exitCode: 75, checkoutFailure: "clone", checkoutTransportCause: "http_status", checkoutHttpStatus: 502, checkoutForge: { routing: "unreached" } },
        log: { exitCode: 75, failure: "clone", transportCause: "http_status", httpStatus: 502, forgeRouting: "unreached" },
      },
      {
        code: 75,
        stderr: `fatal: unable to access 'http://forge.smithers.internal/${secret}': Could not resolve host: forge.smithers.internal\n`,
        expected: { _tag: "CheckoutFailed", exitCode: 75, checkoutFailure: "clone", checkoutTransportCause: "dns", checkoutForge: { routing: "unreached" } },
        log: { exitCode: 75, failure: "clone", transportCause: "dns", forgeRouting: "unreached" },
      },
      {
        code: 75,
        stderr: `fatal: remote error: upload-pack: not our ref ${secret}\n`,
        expected: { _tag: "CheckoutFailed", exitCode: 75, checkoutFailure: "clone", checkoutTransportCause: "missing_object", checkoutForge: { routing: "unreached" } },
        log: { exitCode: 75, failure: "clone", transportCause: "missing_object", forgeRouting: "unreached" },
      },
      {
        code: 75,
        stderr: `fatal: write error: No space left on device (${secret})\n`,
        expected: { _tag: "CheckoutFailed", exitCode: 75, checkoutFailure: "clone", checkoutTransportCause: "pack_storage", checkoutForge: { routing: "unreached" } },
        log: { exitCode: 75, failure: "clone", transportCause: "pack_storage", forgeRouting: "unreached" },
      },
      {
        code: 75,
        stderr: `error: index-pack died of signal 9 (${secret})\n`,
        expected: { _tag: "CheckoutFailed", exitCode: 75, checkoutFailure: "clone", checkoutTransportCause: "interrupted", checkoutForge: { routing: "unreached" } },
        log: { exitCode: 75, failure: "clone", transportCause: "interrupted", forgeRouting: "unreached" },
      },
      {
        code: 75,
        stderr: `fatal: opaque error ${secret}\n`,
        expected: { _tag: "CheckoutFailed", exitCode: 75, checkoutFailure: "clone", checkoutTransportCause: "unknown", checkoutForge: { routing: "unreached" } },
        log: { exitCode: 75, failure: "clone", transportCause: "unknown", forgeRouting: "unreached" },
      },
    ] as const
    for (const scenario of scenarios) {
      logLines.length = 0
      checkoutCode = scenario.code
      checkoutStderr = scenario.stderr
      const outcome = yield* sandbox.wake(branch)
      expect(outcome).toEqual(scenario.expected)
      expect(JSON.stringify(outcome)).not.toContain(secret)
      const checkoutLog = logLines
        .map((line) => {
          try { return JSON.parse(line) as { message?: string; annotations?: Record<string, unknown> } } catch { return {} }
        })
        .find((entry) => entry.message === "sandbox.checkout")
      expect(checkoutLog?.annotations).toMatchObject(scenario.log)
      expect(logLines.join("\n")).not.toContain(secret)
    }
  })).pipe(
    Effect.provide(TestDatabase.layer("branch_sandbox_checkout_transport")),
    Effect.provideService(Console.Console, testConsole),
    Effect.provideService(RuntimeContext, objectRuntime),
  ))
})

test("unreachable object RPCs are mapped to the caller's own failures", async () => {
  const offline = () => Effect.fail(new Error("object disconnected")) as Effect.Effect<never>
  const objects = objectNamespace({
    rpc: { wake: offline, session: offline, ticket: offline, alive: offline, enforce: offline, tool: offline, command: offline, sleepIfIdle: offline },
  })
  const admission: Attachment["admission"] = {
    session: null, alias: null, expiresAt: null, admittedAt: 0,
    principal: "viewer", role: "member", basis: { kind: "terminal", branchId: branch.branchId }, access: "write",
  }
  const attachment = { terminalId, ownerId: "owner", access: "write", principal: "viewer", role: "member", admission } as const
  const policy = { createdBy: null, grants: {} }
  await Effect.runPromise(Effect.gen(function* () {
    const sandboxes = yield* BranchSandboxes.sandboxesOver(objects)
    const terminals = yield* BranchSandboxes.terminalSocketsOver(objects)
    const machines = yield* BranchSandboxes.machinesOver(BranchSandboxes.namespaces(objects, undefined))
    expect(yield* Effect.flip(sandboxes.wake(branch))).toMatchObject({ reason: "start" })
    expect(yield* Effect.flip(sandboxes.session(branch.branchId, terminalId, "owner"))).toMatchObject({ reason: "exec" })
    expect((yield* terminals.attach(branch.branchId, attachment)).status).toBe(503)
    expect(yield* terminals.alive(branch.branchId, terminalId, "owner")).toBe(false)
    expect(yield* Effect.flip(terminals.enforce(branch.branchId, policy, []))).toMatchObject({ reason: "exec" })
    expect(yield* Effect.flip(machines.tool(branch, "owner", "read", { tool: "read", path: "README.md" })))
      .toMatchObject({ reason: "exec" })
    expect(yield* Effect.flip(machines.commands(branch, "owner").cancel("job"))).toMatchObject({ reason: "exec" })
    expect(yield* Effect.flip(machines.sleepIfIdle(branch.branchId, 1, 1000))).toMatchObject({ reason: "exec" })
  }).pipe(
    Effect.provideService(RuntimeContext, objectRuntime),
    Effect.provideService(HttpServerRequest.HttpServerRequest, sandboxRequest),
  ))
})

test("a stopped generation loses commands, and storage faults are reported by the affected methods", async () => {
  const { store, map } = memory()
  let failed: string | undefined
  const storage: typeof store = {
    ...store,
    get: (key) => key === failed ? Effect.die(new Error("storage read refused")) : store.get(key),
  }
  const { initialize } = sandboxRegistration({ running: false }, { storage })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sandbox = yield* initialize
    const start = { op: "start", key: "pending", call: { tool: "run", command: "printf should-not-run" } } as const
    expect(yield* sandbox.command(branch, "owner", { op: "cancel", key: start.key })).toEqual({ _tag: "Cancelled" })
    expect(map.get("run:pending")).toMatchObject({ generation: 0 })
    expect(yield* sandbox.command(branch, "owner", { op: "observe", key: start.key }))
      .toEqual({ _tag: "Observed", observed: { state: "lost" } })
    expect(yield* sandbox.command(branch, "owner", start)).toEqual({ _tag: "Unavailable" })
    expect(yield* sandbox.tool(branch, "owner", "read", { tool: "read", path: "README.md" })).toEqual({ _tag: "Unavailable" })
    failed = "generation"
    expect(yield* sandbox.sleepIfIdle(1, 1000)).toBe("unavailable")
  })).pipe(
    Effect.provideService(Cloudflare.Hyperdrive.Connect, unusedDatabase),
    Effect.provideService(RuntimeContext, objectRuntime),
  ))
})

test("a forge proxy answers a forbidden operation and propagates a defect from its HTTP client", async () => {
  const http = Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die(new Error("outbound unavailable"))))
  const { initialize, map } = sandboxRegistration({ running: false }, { http })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sandbox = yield* initialize
    map.set("branch", { malformed: true })
    const read = new Request("http://forge.smithers.internal/octo/widgets/info/refs?service=git-upload-pack")
    expect((yield* fetchSandbox(sandbox, read)).status).toBe(403)
    map.set("branch", branch)
    const write = new Request("http://forge.smithers.internal/octo/widgets/info/refs?service=git-receive-pack")
    expect((yield* fetchSandbox(sandbox, write)).status).toBe(403)
    expect(yield* Effect.exit(fetchSandbox(sandbox, read))).toMatchObject({ _tag: "Failure" })
  })).pipe(
    Effect.provideService(Cloudflare.Hyperdrive.Connect, unusedDatabase),
    Effect.provideService(RuntimeContext, objectRuntime),
  ))
})

const withWorkerGlobals = async (globals: Record<string, unknown>, run: () => Promise<void>) => {
  const saved = Object.entries(globals).map(([key, value]) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    return [key, original] as const
  })
  try {
    await run()
  } finally {
    for (const [key, original] of saved) {
      if (original === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, original)
    }
  }
}

const withWorkerSockets = (run: () => Promise<void>) =>
  withWorkerGlobals({ WebSocketPair: WorkerSocketPair, Response: WorkerResponse }, run)

/** Byte-preserving stream adapter for the Miniflare R2 proxy, enforcing workerd's length contract. */
class ExactLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number) {
    let seen = 0
    super({
      transform(bytes, stream) {
        seen += bytes.byteLength
        if (seen > length) throw new RangeError("body exceeded the declared length")
        stream.enqueue(bytes)
      },
      flush() {
        if (seen !== length) throw new RangeError("body ended before the declared length")
      },
    })
  }
}

test("the machine adapter keeps the generation that really read a checkout and cancels a detached command", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const box = yield* withDockerSandbox(true)
    const hyperdrive = yield* withScratchDatabase
    const { initialize, map } = sandboxRegistration(box.container)
    const sandbox = yield* initialize.pipe(Effect.provideService(Cloudflare.Hyperdrive.Connect, () => hyperdrive))
    const objects = objectNamespace({ rpc: sandbox })
    const kept: Array<readonly [string, number, string | undefined]> = []
    const machines = yield* BranchSandboxes.machinesOver(
      BranchSandboxes.namespaces(objects, undefined),
      (id, generation, machine) => Effect.sync(() => void kept.push([id, generation, machine])),
    )
    expect(yield* machines.tool(branch, "owner", "read", { tool: "read", path: "README.md" })).toMatchObject({
      result: { tool: "read", content: "sandbox checkout\n" }, generation: 1,
    })
    const start = { op: "start", key: "to-cancel", call: { tool: "run", command: "sleep 30" } } as const
    expect(yield* sandbox.command(branch, "owner", start)).toMatchObject({ _tag: "Started", generation: 1 })
    expect(yield* sandbox.command(branch, "owner", { op: "observe", key: start.key })).toMatchObject({
      _tag: "Observed", observed: { state: "running" },
    })
    expect(yield* sandbox.command(branch, "owner", { op: "cancel", key: start.key })).toEqual({ _tag: "Cancelled" })
    expect(yield* sandbox.command(branch, "owner", { op: "observe", key: start.key })).toMatchObject({
      _tag: "Observed", observed: { state: "lost" },
    })
    expect(kept).toEqual([[branch.branchId, 1, undefined]])
    expect(map.get("generation")).toBe(1)
  })).pipe(Effect.provide(TestDatabase.layer("branch_commands")), Effect.provideService(RuntimeContext, objectRuntime)))
}, 60_000)

type Viewer = NonNullable<WorkerResponse["webSocket"]>
const closeEvent = (socket: Viewer) => new Promise<{ code: number; reason: string }>((resolve) =>
  socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true }))

const viewerRequest = (
  sandbox: SandboxHandlers,
  admission: Attachment["admission"],
  headers: Record<string, string> = {},
) => Effect.gen(function* () {
  const ticket = yield* sandbox.ticket()
  return yield* fetchSandbox(sandbox, forward(sandboxRequest, admission, {
    "x-smithers-ticket": ticket,
    "x-smithers-terminal": terminalId,
    "x-smithers-owner": "owner",
    "x-smithers-principal": admission.principal,
    "x-smithers-access": admission.access,
    ...(admission.role === null ? {} : { "x-smithers-role": admission.role }),
    ...headers,
  }))
})

const viewerOf = (response: HttpServerResponse.HttpServerResponse): Viewer => {
  expect(response.status).toBe(101)
  if (response.body._tag !== "Raw" || !(response.body.body instanceof WorkerResponse) || response.body.body.webSocket === null) {
    throw new Error("expected a WebSocket upgrade")
  }
  return response.body.body.webSocket
}

test("terminal viewers exchange frames with tmux and lose access individually", async () => {
  await withWorkerSockets(() => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const box = yield* withDockerSandbox()
    const { initialize, map } = sandboxRegistration(box.container)
    const sandbox = yield* initialize.pipe(Effect.provideService(Cloudflare.Hyperdrive.Connect, unusedDatabase))
    expect(yield* sandbox.session(terminalId, "owner")).toBe(true)
    expect(yield* sandbox.alive(terminalId, "owner")).toBe(true)
    expect(map.has("branch")).toBe(false)
    const admission = {
      session: null, alias: null, expiresAt: null, admittedAt: Date.now(),
      principal: "owner", role: "member", basis: { kind: "terminal", branchId: branch.branchId }, access: "write",
    } as const

    expect((yield* viewerRequest(sandbox, admission, { "x-smithers-terminal": "" })).status).toBe(400)
    expect((yield* viewerRequest(sandbox, admission, { "x-smithers-owner": "" })).status).toBe(400)
    expect((yield* viewerRequest(sandbox, admission, { "x-smithers-principal": "" })).status).toBe(400)

    const open = (admitted: Attachment["admission"]) => Effect.gen(function* () {
      const socket = viewerOf(yield* viewerRequest(sandbox, admitted))
      const ready = new Promise<string>((resolve) => socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") resolve(event.data)
      }))
      socket.accept()
      return { socket, ready, closed: closeEvent(socket) }
    })
    const owner = yield* open(admission)
    const editor = yield* open({ ...admission, principal: "editor" })
    const reader = yield* open({ ...admission, principal: "anonymous", role: null, access: "read" })
    expect(JSON.parse(yield* Effect.promise(() => owner.ready))).toEqual({ type: "ready", access: "write" })
    expect(JSON.parse(yield* Effect.promise(() => reader.ready))).toEqual({ type: "ready", access: "read" })
    const output = new Promise<string>((resolve) => {
      let text = ""
      reader.socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") return
        text += new TextDecoder().decode(event.data)
        if (text.includes("owner-2")) resolve(text)
      })
    })
    owner.socket.send(new TextEncoder().encode("printf 'owner-%s\\n' 2\r"))
    expect(yield* Effect.promise(() => output)).toContain("owner-2")

    yield* sandbox.enforce({ createdBy: "owner", grants: { editor: "view" } }, [])
    expect(yield* Effect.promise(() => editor.closed)).toEqual({ code: 1011, reason: "access changed" })
    expect(yield* Effect.promise(() => reader.closed)).toEqual({ code: 1008, reason: "no access" })
    yield* sandbox.enforce({ createdBy: "owner", grants: {} }, [{ terminalId, ownerId: "owner" }])
    expect((yield* Effect.promise(() => owner.closed)).code).toBe(1000)
    expect(yield* sandbox.alive(terminalId, "owner")).toBe(false)
  })).pipe(Effect.provideService(RuntimeContext, objectRuntime)), { signal: AbortSignal.timeout(15_000) }))
}, 45_000)

test("a container start that misses its deadline releases the admission", async () => {
  const { initialize } = sandboxRegistration({
    running: false,
    start: () => { throw new Error("you are requesting too many containers per second") },
  }, { config: { SANDBOX_START_TIMEOUT_SECONDS: "1" } })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const hyperdrive = yield* withScratchDatabase
    const sandbox = yield* initialize.pipe(Effect.provideService(Cloudflare.Hyperdrive.Connect, () => hyperdrive))
    expect(yield* sandbox.wake(branch)).toEqual({ _tag: "Unavailable", reason: "start_timeout" })
    const sql = yield* SqlClient.SqlClient
    expect(yield* sql`SELECT generation FROM sandbox_generations WHERE branch_id = ${branch.branchId} AND ended_at IS NULL`).toEqual([])
  })).pipe(Effect.provide(TestDatabase.layer("branch_timeout")), Effect.provideService(RuntimeContext, objectRuntime)))
})

test("the gate binds its actual R2 bucket and scopes each artifact to its stored run", async () => {
  const worker = new Miniflare({ workers: [{ config: {
    name: "gate-artifacts",
    compatibilityDate: "2026-10-01",
    manifest: { mainModule: "worker.js", modules: {
      "worker.js": { type: "esm", contents: "export default { fetch: () => new Response(null, { status: 404 }) }" },
    } },
    env: { ARTIFACTS: { type: "r2" } },
  } }] })
  try {
    const r2 = await worker.getR2Bucket("ARTIFACTS")
    const scope = "a".repeat(40)
    const key = Artifacts.keyOf(scope, "report")
    await r2.put(key, "checked branch")
    const gate: Bucket = {
      put: async (name, body) => r2.put(name, body === null ? null : await new Response(body).arrayBuffer()),
      get: async (name) => {
        const object = await r2.get(name)
        if (object === null) return null
        return { body: new Response(await object.arrayBuffer()).body!, size: object.size }
      },
    }
    const { initialize, forwarded, map } = sandboxRegistration({ running: false }, { gate })
    await withWorkerGlobals({ FixedLengthStream: ExactLengthStream }, () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sandbox = yield* initialize
      const request = new Request("http://artifacts.smithers.internal/report", { headers: { "x-scope": scope } })
      expect(forwarded).toEqual([{ sandboxObject: "object-id", sandboxMachine: "gate" }])
      expect((yield* fetchSandbox(sandbox, request)).status).toBe(403)
      map.set("branch", { ...branch, kind: "job", artifacts: "b".repeat(40) })
      expect((yield* fetchSandbox(sandbox, request)).status).toBe(404)
      map.set("branch", { ...branch, kind: "job", artifacts: scope })
      const read = yield* fetchSandbox(sandbox, request)
      expect(read.status).toBe(200)
      expect(yield* Effect.promise(() => HttpServerResponse.toWeb(read).text())).toBe("checked branch")
      const put = (length: number) => fetchSandbox(sandbox, new Request(request.url, {
        method: "PUT", body: "new report", headers: { "content-length": String(length) },
      }))
      expect((yield* put(9)).status).toBe(502)
      expect((yield* put(10)).status).toBe(201)
      expect(yield* Effect.promise(async () => (await r2.get(key))?.text())).toBe("new report")
    })).pipe(
      Effect.provideService(Cloudflare.Hyperdrive.Connect, unusedDatabase),
      Effect.provideService(RuntimeContext, objectRuntime),
    )))
  } finally {
    await worker.dispose()
  }
}, 60_000)

const testKey = "branch-object-test-secret-material".repeat(2)
const repository = "github/octo/widgets"
const configuredKeys = Effect.service(SecretKeys).pipe(
  Effect.provide(SecretKeys.layer(Redacted.make(testKey))),
  Effect.map(Option.getOrThrow),
)

/** A loopback HTTP peer sees the actual headers after the real Effect client's egress transformation. */
const outboundPeer = Effect.acquireRelease(
  Effect.promise(() => new Promise<{ server: ReturnType<typeof createServer>; port: number; requests: Array<{
    url: string | undefined; authorization: string | undefined
  }> }>((resolve, reject) => {
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = []
    const server = createServer((request, response) => {
      requests.push({ url: request.url, authorization: request.headers.authorization })
      response.writeHead(200, { "content-type": "text/plain" }).end("outbound peer")
    })
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") reject(new Error("no loopback address"))
      else resolve({ server, port: address.port, requests })
    })
  })),
  ({ server }) => Effect.promise(() => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })),
).pipe(Effect.map(({ port, requests }) => ({
  requests,
  http: Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, HttpClient.mapRequest((request) => {
    const original = new URL(request.url)
    return HttpClientRequest.setUrl(request, `http://127.0.0.1:${port}/${original.hostname}${original.pathname}`)
  }))).pipe(Layer.provide(FetchHttpClient.layer)),
})))

const saveConnection = (kind: "claude_subscription" | "api_key", personId: string, baseUrl: string, value: string) =>
  Effect.gen(function* () {
    const keys = yield* configuredKeys
    const id = crypto.randomUUID()
    const sealed = yield* keys.cipher.seal(Redacted.make(value), sealContext(personId, keys.version))
    expect(yield* PersonalStore.put({
      personId, invocationKey: crypto.randomUUID(),
      connections: [{
        id, kind, active: true, protocol: kind === "api_key" ? "openai-chat" : null, baseUrl, models: {},
        sealed: { ...sealed, keyVersion: keys.version, keyLast4: value.slice(-4) },
      }],
    })).toBe("set")
    return id
  })

test("a TODO subscription stays with its owner's commands and is unsealed only at its upstream", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const box = yield* withDockerSandbox(true)
    const peer = yield* outboundPeer
    const hyperdrive = yield* withScratchDatabase
    const config = { SANDBOX_SECRETS: "true", SECRETS_KEY: testKey, EGRESS_ALLOW_HOSTS: "probe.test" }
    const { initialize, map } = sandboxRegistration(box.container, { config, http: peer.http })
    const sandbox = yield* initialize.pipe(Effect.provideService(Cloudflare.Hyperdrive.Connect, () => hyperdrive))
    const todo = { ...branch, branchId: "todo-fixture" }
    const request = new Request("https://probe.test/health")
    expect((yield* fetchSandbox(sandbox, request)).status).toBe(403)
    map.set("branch", todo)
    expect((yield* fetchSandbox(sandbox, request)).status).toBe(403)
    expect(yield* sandbox.wake(todo)).toEqual({ _tag: "Woken", generation: 1 })
    expect(yield* sandbox.wake(todo, "owner")).toEqual({ _tag: "Woken", generation: 1 })
    expect(map.has("subscription")).toBe(false)

    const credential = "fixture-subscription-token"
    const connectionId = yield* saveConnection("claude_subscription", "owner", "https://agent.test/v1", credential)
    const keys = yield* configuredKeys
    const sealed = yield* keys.cipher.seal(Redacted.make("fixture-secret-value"), {
      id: repository, name: "DEMO_TOKEN", version: keys.version,
    })
    expect(yield* SecretStore.put({
      ...sealed, keyVersion: keys.version, repoId: repository, name: "DEMO_TOKEN", hosts: ["probe.test"],
      methods: undefined, actorId: "owner", invocationKey: "fixture-secret",
    })).toBe("set")
    expect(yield* sandbox.wake(todo, "owner")).toEqual({ _tag: "Woken", generation: 1 })
    const held = map.get("subscription") as {
      subscription: { connectionId: string }; environment: { CLAUDE_CODE_OAUTH_TOKEN: string }
    }
    expect(held.subscription.connectionId).toBe(connectionId)
    const token = held.environment.CLAUDE_CODE_OAUTH_TOKEN
    expect(token).toMatch(/^smthrs-secret-/)
    expect(JSON.stringify(held)).not.toContain(credential)
    const environment = box.root(["cat", "/run/smithers/env"])
    expect(environment).toMatch(/^DEMO_TOKEN=smthrs-secret-/)
    const command = { tool: "run", command: 'printf "%s|%s" "${CLAUDE_CODE_OAUTH_TOKEN:-none}" "$DEMO_TOKEN"' } as const
    expect(yield* sandbox.tool(todo, "owner", "owner-env", command)).toMatchObject({
      _tag: "Done", result: { stdout: `${token}|${environment.split("=")[1]}` },
    })
    map.set("run:missing", 1)
    for (const stale of [undefined, { generation: 0, environment: "DEMO_TOKEN=from-another-generation" }]) {
      if (stale === undefined) map.delete("environment")
      else map.set("environment", stale)
      expect(yield* sandbox.command(todo, "owner", { op: "observe", key: "missing" })).toMatchObject({
        _tag: "Observed", observed: { state: "lost" },
      })
    }

    expect((yield* fetchSandbox(sandbox, request)).status).toBe(200)
    const agentRequest = new Request("https://agent.test/v1/messages", {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}",
    })
    expect((yield* fetchSandbox(sandbox, agentRequest)).status).toBe(200)
    expect(peer.requests).toEqual([
      { url: "/probe.test/health", authorization: undefined },
      { url: "/agent.test/v1/messages", authorization: `Bearer ${credential}` },
    ])
    map.delete("branch")
    expect((yield* fetchSandbox(sandbox, agentRequest)).status).toBe(403)
    map.set("branch", todo)
    map.delete("generation")
    expect((yield* fetchSandbox(sandbox, agentRequest)).status).toBe(403)

    map.set("generation", 1)
    expect(yield* sandbox.tool(todo, "other", "other-env", command)).toMatchObject({
      _tag: "Done", result: { stdout: `none|${environment.split("=")[1]}` },
    })
    expect(yield* sandbox.wake(todo, "owner")).toEqual({ _tag: "Woken", generation: 1 })
    box.root(["mkdir", "/run/smithers/env.tmp"])
    expect(yield* sandbox.wake(todo, "owner")).toEqual({ _tag: "Woken", generation: 1 })
    expect(box.root(["cat", "/run/smithers/env"])).toBe(environment)
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE personal_models RENAME TO offline_models`
    expect(yield* sandbox.wake(todo, "owner")).toEqual({ _tag: "Woken", generation: 1 })
    expect(map.has("subscription")).toBe(false)
    yield* sql`ALTER TABLE secrets RENAME TO offline_secrets`
    expect(yield* sandbox.wake(todo, "owner")).toEqual({ _tag: "Woken", generation: 1 })
    expect(box.root(["cat", "/run/smithers/env"])).toBe(environment)
  })).pipe(Effect.provide(TestDatabase.layer("branch_subscription")), Effect.provideService(RuntimeContext, objectRuntime)))
}, 60_000)

test("the overflow box launches from its own configuration and routes its sealed runner credential", async () => {
  const outcomes: Array<string> = []
  const testConsole: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (value: unknown) => {
      if (typeof value !== "string" || !value.startsWith("{")) return
      const record = JSON.parse(value) as { message: string; annotations?: { outcome?: string } }
      if (record.message === "sandbox.overflow" && record.annotations?.outcome !== undefined) {
        outcomes.push(record.annotations.outcome)
      }
    },
  })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const box = yield* withDockerSandbox()
    const peer = yield* outboundPeer
    const hyperdrive = yield* withScratchDatabase
    const { initialize, map } = sandboxRegistration(box.container, {
      config: { SECRETS_KEY: testKey, OVERFLOW_INSTANCE: "standard-3" }, http: peer.http,
    })
    const sandbox = yield* initialize.pipe(Effect.provideService(Cloudflare.Hyperdrive.Connect, () => hyperdrive))
    const overflow = Overflow.boxBranch(repository)
    expect(yield* sandbox.wake(overflow)).toEqual({ _tag: "Woken", generation: 1 })
    expect(box.starts).toEqual([{ enableInternet: false, instance: "standard-3" }])
    expect(map.has("overflow")).toBe(false)
    const connectionId = yield* saveConnection("api_key", "owner", "https://models.test/v1", "fixture-model-key")
    const runnerToken = "fixture-runner-token"
    const keys = yield* configuredKeys
    const sealed = yield* keys.cipher.seal(Redacted.make(runnerToken), Overflow.tokenContext(repository, keys.version))
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO repo_overflow
      (repo_id, person_id, connection_id, origin, profile, argv, labels, min_queued_seconds, capacity,
        token_ciphertext, token_nonce, key_version, updated_by)
      VALUES (${repository}, 'owner', 'missing', 'https://runner.test', 'test', '["printf"]', '{}', 0, 1,
        ${sealed.ciphertext}, ${sealed.nonce}, ${keys.version}, 'owner')`
    expect(yield* sandbox.wake(overflow)).toEqual({ _tag: "Woken", generation: 1 })
    expect(map.has("overflow")).toBe(false)
    yield* sql`UPDATE repo_overflow SET connection_id = ${connectionId} WHERE repo_id = ${repository}`
    expect(yield* sandbox.wake(overflow)).toEqual({ _tag: "Woken", generation: 1 })
    const placeholder = box.root(["cat", "/home/smithers/runner/runner-token"])
    expect(placeholder).toMatch(/^smthrs-secret-/)
    expect(JSON.parse(box.root(["cat", "/home/smithers/runner/runner.json"]))).toMatchObject({ name: Overflow.RUNNER })
    const request = new Request("https://runner.test/api/claim", { headers: { authorization: `Bearer ${placeholder}` } })
    expect((yield* fetchSandbox(sandbox, request)).status).toBe(200)
    expect(peer.requests).toEqual([{ url: "/runner.test/api/claim", authorization: `Bearer ${runnerToken}` }])
    map.delete("branch")
    expect((yield* fetchSandbox(sandbox, request)).status).toBe(403)
    map.set("branch", overflow)
    map.delete("generation")
    expect((yield* fetchSandbox(sandbox, request)).status).toBe(403)

    map.set("generation", 1)
    box.root(["sh", "-c", 'jj_path=$(command -v jj); mv "$jj_path" "$jj_path.offline"'])
    expect(yield* sandbox.wake(overflow)).toEqual({ _tag: "Woken", generation: 1 })
    expect(box.root(["cat", "/home/smithers/runner/runner-token"])).toBe(placeholder)
    box.root(["sh", "-c", 'jj_path=$(find /usr/local/bin -name jj.offline -print -quit); mv "$jj_path" "${jj_path%.offline}"'])
    // Run the same startup on an image without Debian's interactive logout hook.
    box.root(["rm", "-f", "/home/smithers/.bash_logout"])
    // An existing runner owns this lock. The next wake must leave that runner alone.
    const existing = yield* Effect.acquireRelease(
      Effect.promise(() => box.container.exec(["sh", "-c",
        "exec 9>/home/smithers/runner/serve.lock; flock -n 9; touch /home/smithers/runner/lock-ready; sleep 20",
      ], { user: "1000:2000", stdout: "ignore", stderr: "ignore" })),
      (process) => Effect.sync(() => process.kill()),
    )
    box.root(["sh", "-c", "for i in 1 2 3 4 5; do test -f /home/smithers/runner/lock-ready && exit 0; sleep .1; done; exit 1"])
    expect(yield* sandbox.wake(overflow)).toEqual({ _tag: "Woken", generation: 1 })
    expect(box.root(["sh", "-c", "flock -n /home/smithers/runner/serve.lock -c true; echo $?"])).toBe("1")
    existing.kill()
    yield* sql`ALTER TABLE repo_overflow RENAME TO offline_overflow`
    expect(yield* sandbox.wake(overflow)).toEqual({ _tag: "Woken", generation: 1 })
    expect(map.has("overflow")).toBe(false)
    expect((yield* fetchSandbox(sandbox, request)).status).toBe(403)
  })).pipe(
    Effect.provide(TestDatabase.layer("branch_overflow")),
    Effect.provideService(RuntimeContext, objectRuntime),
    Effect.provideService(Console.Console, testConsole),
  ))
  expect(outcomes).toEqual(["off", "connection", "failed", "no_runner", "started"])
}, 60_000)

test("the terminal caps admissions before spawning another pump and releases the cap on close", async () => {
  // The container stops answering exec while viewers attach. The admission limit still applies.
  const broken = {
    running: false,
    exec: () => new Promise<never>(() => {}),
  }
  const { initialize, map } = sandboxRegistration(broken)
  await withWorkerSockets(() => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sandbox = yield* initialize
    const admission = {
      session: null, alias: null, expiresAt: null, admittedAt: Date.now(), principal: "viewer", role: "member",
      basis: { kind: "terminal", branchId: branch.branchId }, access: "read",
    } as const
    const sockets: Array<Viewer> = []
    for (let i = 0; i < SocketAccess.MAX_SOCKETS_PER_PERSON; i++) {
      const socket = viewerOf(yield* viewerRequest(sandbox, admission, { "x-smithers-role": "invalid" }))
      socket.accept()
      sockets.push(socket)
    }
    expect((yield* viewerRequest(sandbox, admission)).status).toBe(429)
    const closing = sockets.map(closeEvent)
    yield* sandbox.enforce({ createdBy: null, grants: {} }, [])
    expect(yield* Effect.promise(() => Promise.all(closing))).toEqual(sockets.map(() => ({ code: 1008, reason: "no access" })))
    expect(map.get("saveDue")).toBe(true)
    const next = viewerOf(yield* viewerRequest(sandbox, admission))
    const closed = closeEvent(next)
    next.accept()
    yield* sandbox.enforce({ createdBy: null, grants: {} }, [])
    expect(yield* Effect.promise(() => closed)).toEqual({ code: 1008, reason: "no access" })
  })).pipe(
    Effect.provideService(RuntimeContext, objectRuntime),
    Effect.provideService(Cloudflare.Hyperdrive.Connect, unusedDatabase),
  )))
})

const tickRenewal = SocketAccess.LEASE_MS - SocketAccess.RENEW_AHEAD_MS + 1
const countRenewed = (outcome: "keep" | "revoked") =>
  Effect.map(Metric.value(Metric.withAttributes(SocketAccess.leases, { host: "terminal", outcome })), ({ count }) => count)

test("the object renews a live terminal through Postgres and cancels its pump when the branch is deleted", async () => {
  await withWorkerSockets(() => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const box = yield* withDockerSandbox()
    const hyperdrive = yield* withScratchDatabase
    const sql = yield* SqlClient.SqlClient
    const branchId = crypto.randomUUID()
    yield* sql`INSERT INTO branches (id, repo_id, name, created_by) VALUES (${branchId}, ${repository}, 'terminal', 'owner')`
    yield* sql`INSERT INTO conversations (id, repo_id, branch_id) VALUES (${crypto.randomUUID()}, ${repository}, ${branchId})`
    const { initialize, map } = sandboxRegistration(box.container, { checks: { local: true } })
    const sandbox = yield* initialize.pipe(Effect.provideService(Cloudflare.Hyperdrive.Connect, () => hyperdrive))
    map.set("branch", { ...branch, branchId })
    expect(yield* sandbox.session(terminalId, "owner")).toBe(true)
    expect(yield* sql`SELECT generation, person_id FROM sandbox_generations WHERE branch_id = ${branchId}`)
      .toEqual([{ generation: 1, person_id: "owner" }])
    const now = Date.now()
    yield* TestClock.setTime(now)
    const kept = yield* countRenewed("keep")
    const revoked = yield* countRenewed("revoked")
    const socket = viewerOf(yield* viewerRequest(sandbox, {
      session: null, alias: null, expiresAt: null, admittedAt: now, principal: "owner",
      role: "member", basis: { kind: "terminal", branchId }, access: "write",
    }))
    const closed = closeEvent(socket)
    socket.accept()
    yield* TestClock.adjust(tickRenewal)
    yield* Effect.promise(() => vi.waitFor(async () => {
      expect(await Effect.runPromise(countRenewed("keep"))).toBe(kept + 1)
      expect(socket.readyState).toBe(1)
    }))
    yield* sql`UPDATE branches SET deleted_at = now() WHERE id = ${branchId}`
    yield* TestClock.adjust(tickRenewal + 1)
    expect(yield* Effect.promise(() => closed)).toEqual({ code: 1008, reason: "no access" })
    expect(yield* countRenewed("revoked")).toBe(revoked + 1)
    expect(box.container.running).toBe(true)
  })).pipe(
    Effect.provide(TestClock.layer()),
    Effect.provide(TestDatabase.layer("terminal_renewal")),
    Effect.provideService(RuntimeContext, objectRuntime),
  )))
}, 45_000)

test("container status faults leave liveness false, commands unavailable and policy enforcement safe", async () => {
  let down = false
  const { initialize } = sandboxRegistration({
    get running() {
      if (down) throw new Error("container status unavailable")
      return false
    },
  })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sandbox = yield* initialize
    down = true
    expect(yield* sandbox.alive(terminalId, "owner")).toBe(false)
    expect(yield* sandbox.command(branch, "owner", { op: "observe", key: "existing" })).toEqual({ _tag: "Unavailable" })
    yield* sandbox.enforce({ createdBy: null, grants: {} }, [{ terminalId, ownerId: "owner" }])
    down = false
    expect(yield* sandbox.alive(terminalId, "owner")).toBe(false)
  })).pipe(
    Effect.provideService(Cloudflare.Hyperdrive.Connect, unusedDatabase),
    Effect.provideService(RuntimeContext, objectRuntime),
  ))
})

test("a machine without an encryption key clears stale credential state and tolerates a trust setup failure", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const box = yield* withDockerSandbox(true)
    const hyperdrive = yield* withScratchDatabase
    let execBroken = false
    const container = {
      get running() { return box.container.running },
      start: box.container.start,
      destroy: box.container.destroy,
      monitor: box.container.monitor,
      setInactivityTimeout: box.container.setInactivityTimeout,
      interceptOutboundHttp: box.container.interceptOutboundHttp,
      interceptAllOutboundHttp: box.container.interceptAllOutboundHttp,
      interceptOutboundHttps: box.container.interceptOutboundHttps,
      exec: (argv: ReadonlyArray<string>, options: ContainerExec) => execBroken && argv.includes(SandboxEgress.TRUST)
        ? Promise.reject(new Error("container exec failed"))
        : box.container.exec(argv, options),
    }
    const { initialize, map } = sandboxRegistration(container)
    const sandbox = yield* initialize.pipe(Effect.provideService(Cloudflare.Hyperdrive.Connect, () => hyperdrive))
    map.set("subscription", { previous: true })
    const todo = { ...branch, branchId: "todo-without-key" }
    expect(yield* sandbox.wake(todo, "owner")).toEqual({ _tag: "Woken", generation: 1 })
    expect(map.has("subscription")).toBe(false)
    execBroken = true
    expect(yield* sandbox.wake(todo)).toEqual({ _tag: "Woken", generation: 1 })
    execBroken = false
    box.root(["sh", "-c", "mkdir -p /etc/cloudflare/certs; touch /etc/cloudflare/certs/cloudflare-containers-ca.crt; rm -rf /usr/local/share/ca-certificates; touch /usr/local/share/ca-certificates"])
    expect(yield* sandbox.wake(todo)).toEqual({ _tag: "Woken", generation: 1 })
    expect(map.has("environment")).toBe(false)

    map.set("overflow", { previous: true })
    expect(yield* sandbox.wake(Overflow.boxBranch(repository))).toEqual({ _tag: "Woken", generation: 1 })
    expect(map.has("overflow")).toBe(false)
  })).pipe(Effect.provide(TestDatabase.layer("branch_no_key")), Effect.provideService(RuntimeContext, objectRuntime)))
}, 60_000)

test("a renewal applies the measured or fallback lease without resurrecting a viewer detached in flight", () => {
  const admission = {
    session: null, alias: null, expiresAt: null, admittedAt: 0, principal: "viewer", role: "member",
    basis: { kind: "terminal", branchId: branch.branchId }, access: "read",
  } as const
  const attached = new Map([
    ["fallback", { admission, lease: { until: 60 } }],
    ["measured", { admission, lease: { until: 60 } }],
    ["closing", { admission, lease: { until: 60 } }],
    ["departed", { admission, lease: { until: 10 } }],
  ])
  const departed = attached.get("departed")!
  const renewal = BranchSandboxes.terminalRenewal(attached, ["fallback", "missing", "measured", "closing", "departed"])
  expect(renewal.admissions).toEqual([admission, admission, admission, admission])
  attached.delete("departed")
  expect(renewal.settle([
    { verdict: "keep", admission },
    { verdict: "keep", admission: { ...admission, expiresAt: 190 }, until: 190 },
    { verdict: "changed", admission },
    { verdict: "revoked", admission },
  ], 100)).toEqual([{
    socket: "closing", viewer: { admission, lease: { until: 0 } }, verdict: "changed",
  }])
  expect(attached.get("fallback")?.lease.until).toBe(100 + SocketAccess.LEASE_MS)
  expect(attached.get("measured")).toEqual({ admission: { ...admission, expiresAt: 190 }, lease: { until: 190 } })
  expect([...attached.keys()]).toEqual(["fallback", "measured"])
  expect(departed.lease.until).toBe(10)
})

test("a lapsed terminal survives both a notifier defect and a renewal defect before a later check closes it", async () => {
  const entered = Deferred.makeUnsafe<void>()
  const { initialize } = sandboxRegistration({
    running: false,
    // Stalled process start leaves the pump's socket listener active while frames arrive.
    exec: () => {
      Deferred.doneUnsafe(entered, Effect.void)
      return new Promise<never>(() => {})
    },
  })
  await withWorkerSockets(() => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const wall = Date.now()
    yield* TestClock.setTime(wall - 2 * SocketAccess.LEASE_MS)
    const clock = yield* Clock.Clock
    let fail = false
    let failAfterVerdict = false
    const logs: Array<string> = []
    let sleepCalls = 0
    let failedReads = 0
    const testConsole: Console.Console = Object.assign(Object.create(globalThis.console), {
      log: (value: unknown) => {
        if (typeof value !== "string" || !value.startsWith("{")) return
        const record = JSON.parse(value) as { message: string }
        logs.push(record.message)
        if (record.message === "socket.lease" && failAfterVerdict) {
          failAfterVerdict = false
          fail = true
        }
      },
    })
    const faultyClock: Clock.Clock = Object.assign(Object.create(clock), {
      currentTimeMillis: Effect.suspend(() => {
        if (!fail) return clock.currentTimeMillis
        fail = false
        failedReads++
        return Effect.die(new Error("clock read failed"))
      }),
      sleep: (duration: Parameters<Clock.Clock["sleep"]>[0]) => {
        sleepCalls++
        return clock.sleep(duration)
      },
    })
    yield* Effect.gen(function* () {
      const sandbox = yield* initialize
      const admission = {
        session: null, alias: null, expiresAt: null, admittedAt: wall - SocketAccess.LEASE_MS - 1,
        principal: "viewer", role: "member", basis: { kind: "terminal", branchId: branch.branchId }, access: "read",
      } as const
      const socket = viewerOf(yield* viewerRequest(sandbox, admission))
      const closed = closeEvent(socket)
      socket.accept()
      yield* Deferred.await(entered)
      yield* Effect.promise(() => vi.waitFor(() => expect(sleepCalls).toBeGreaterThanOrEqual(2)))
      fail = true
      socket.send("lapsed frame")
      yield* Effect.promise(() => vi.waitFor(() =>
        expect({ failedReads, logs }).toMatchObject({ failedReads: 1, logs: expect.arrayContaining(["sandbox.renew"]) })))
      expect(socket.readyState).toBe(1)

      failAfterVerdict = true
      yield* TestClock.setTime(admission.admittedAt + tickRenewal)
      yield* Effect.promise(() => vi.waitFor(() =>
        expect(logs.filter((message) => message === "sandbox.renew")).toHaveLength(2)))
      expect(failedReads).toBe(2)
      yield* TestClock.adjust(1)
      expect(yield* Effect.promise(() => closed)).toEqual({ code: 1012, reason: "access unverified" })
    }).pipe(
      Effect.provideService(Clock.Clock, faultyClock),
      Effect.provideService(Console.Console, testConsole),
    )
  })).pipe(
    Effect.provide(TestClock.layer()),
    Effect.provideService(RuntimeContext, objectRuntime),
    Effect.provideService(Cloudflare.Hyperdrive.Connect, unusedDatabase),
  ), { signal: AbortSignal.timeout(15_000) }))
}, 30_000)

test("internalHostOf and routeBox fail closed with 502 for internal sandbox hosts arriving without box props", async () => {
  expect(BranchSandboxes.internalHostOf("http://forge.smithers.internal/evmts/guillotine/info/refs?service=git-upload-pack")).toBe("forge")
  expect(BranchSandboxes.internalHostOf("http://FORGE.SMITHERS.INTERNAL:80/a/b")).toBe("forge")
  expect(BranchSandboxes.internalHostOf("http://artifacts.smithers.internal/report")).toBe("artifacts")
  expect(BranchSandboxes.internalHostOf("https://smithers.sh/api/health")).toBeUndefined()
  expect(BranchSandboxes.internalHostOf("not a valid url")).toBeUndefined()

  // ChatApiProgram dispatches through routeBox before any external API route.
  const program = sourceText(new URL("./ChatApiProgram.ts", import.meta.url))
  expect(program).toContain("BranchSandboxes.routeBox(")

  const objects = objectNamespace({ fetch: () => Effect.succeed(HttpServerResponse.empty({ status: 204 })) })
  const objectsFor = BranchSandboxes.namespaces(objects, undefined)

  const runRoute = (url: string, props: unknown) =>
    Effect.runPromise(
      BranchSandboxes.routeBox(objectsFor, props).pipe(
        Effect.provideService(RuntimeContext, objectRuntime),
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(url))),
      ),
    )

  // Valid props route straight to the sandbox object.
  const forwarded = await runRoute("http://forge.smithers.internal/evmts/guillotine/info/refs?service=git-upload-pack", {
    [BranchSandboxes.BOX_PROP]: "object-id",
  })
  expect(Option.isSome(forwarded) ? forwarded.value.status : undefined).toBe(204)

  // Missing props on forge or artifacts internal hosts fail closed with 502 (never fall through to 404).
  const missingForge = await runRoute("http://forge.smithers.internal/evmts/guillotine/info/refs?service=git-upload-pack", undefined)
  expect(Option.isSome(missingForge) ? missingForge.value.status : undefined).toBe(502)

  const missingArtifacts = await runRoute("http://artifacts.smithers.internal/report", {})
  expect(Option.isSome(missingArtifacts) ? missingArtifacts.value.status : undefined).toBe(502)

  // Normal external API requests pass through untouched (`Option.none()`).
  const external = await runRoute("https://smithers.sh/api/health", undefined)
  expect(Option.isNone(external)).toBe(true)
})

test("real public git checkout through SandboxObject + routeBox + Forge.proxy succeeds and discriminates info-refs 404, upload-pack 404, missing props 502, pre-object 404 and host mismatch", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "sandbox-forge-e2e-"))
  const repoDir = join(scratch, "upstream.git")
  mkdirSync(repoDir, { recursive: true })
  const runGit = (cwd: string, ...args: ReadonlyArray<string>) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim()
  runGit(repoDir, "init", "-q", "-b", "main")
  runGit(repoDir, "config", "uploadpack.allowAnySHA1InWant", "true")
  writeFileSync(join(repoDir, "README.md"), "public repo content\n")
  runGit(repoDir, "add", ".")
  runGit(repoDir, "commit", "-q", "-m", "initial")
  const sha = runGit(repoDir, "rev-parse", "HEAD")

  const uploadPack = (args: ReadonlyArray<string>, input: Buffer, protocol?: string) =>
    new Promise<Buffer>((resolve, reject) => {
      const child = spawn("git", ["upload-pack", "--stateless-rpc", ...args, repoDir], {
        env: { ...process.env, ...(protocol ? { GIT_PROTOCOL: protocol } : {}) },
      })
      const chunks: Array<Buffer> = []
      let errs = ""
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => { errs += chunk.toString("utf8") })
      child.on("error", reject)
      child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(errs)))
      child.stdin.end(input)
    })

  let upstreamMode: "ok" | "info-refs-404" | "upload-pack-404" = "ok"
  let bridgeMode: "routed" | "missing-props" | "pre-object-404" | "host-mismatch" = "routed"
  const upstreamCalls: Array<string> = []

  // Clean upstream HttpClient using FetchHttpClient backed by a real local upstream HTTP server so streaming POST bodies work natively.
  const upstreamServer = createServer(async (req, res) => {
    const chunks: Array<Buffer> = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    if (req.method === "GET" && req.url?.includes("/info/refs")) {
      if (upstreamMode === "info-refs-404") {
        res.writeHead(404, { "content-type": "text/plain" })
        res.end("Not Found")
        return
      }
      const pack = await uploadPack(["--advertise-refs"], body, req.headers["git-protocol"] as string | undefined)
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" })
      res.end(Buffer.concat([Buffer.from("001e# service=git-upload-pack\n0000"), pack]))
      return
    }
    if (req.method === "POST" && req.url?.includes("/git-upload-pack")) {
      if (upstreamMode === "upload-pack-404") {
        res.writeHead(404, { "content-type": "text/plain" })
        res.end("Not Found")
        return
      }
      const pack = await uploadPack([], body, req.headers["git-protocol"] as string | undefined)
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" })
      res.end(pack)
      return
    }
    res.writeHead(500)
    res.end("unexpected")
  })

  let activeSandbox: Effect.Success<ReturnType<typeof sandboxRegistration>["initialize"]> | undefined
  let workspaceDir = join(scratch, "w0")
  let bridgeOrigin = ""
  const logLines: Array<string> = []
  const testConsole: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (value: unknown) => {
      if (typeof value === "string") logLines.push(value)
    },
  })

  await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve))
  const upstreamOrigin = `http://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`

  const objectHttp = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, (input, init) => {
      const incoming = input instanceof Request ? input : new Request(input, init)
      upstreamCalls.push(`${incoming.method} ${incoming.url}`)
      const parsed = new URL(incoming.url)
      if (parsed.hostname !== "github.com") {
        return Promise.reject(new Error(`unexpected outbound host: ${parsed.hostname}`))
      }
      const rewritten = new Request(`${upstreamOrigin}${parsed.pathname}${parsed.search}`, {
        method: incoming.method,
        headers: incoming.headers,
        body: incoming.method === "POST" ? incoming.body : undefined,
        ...(incoming.method === "POST" ? { duplex: "half" } : {}),
      } as RequestInit)
      return globalThis.fetch(rewritten)
    })),
  )

  const bridgeServer = createServer(async (req, res) => {
    try {
      const chunks: Array<Buffer> = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      if (bridgeMode === "pre-object-404") {
        res.writeHead(404, { "content-type": "text/plain" })
        res.end("pre-object 404")
        return
      }
      const targetHost = bridgeMode === "host-mismatch" ? "wrong.smithers.internal" : "forge.smithers.internal"
      const request = new Request(`http://${targetHost}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(req.method === "POST" ? { body } : {}),
      })
      const objects = objectNamespace({
        fetch: (incoming) =>
          activeSandbox!.fetch.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, incoming),
          ),
      })
      const objectsFor = BranchSandboxes.namespaces(objects, undefined)
      const props = bridgeMode === "missing-props" ? undefined : { [BranchSandboxes.BOX_PROP]: "object-id" }
      const { routed, context } = await Effect.runPromise(
        Effect.all({
          routed: BranchSandboxes.routeBox(objectsFor, props),
          context: Effect.context<never>(),
        }).pipe(
          Effect.provideService(RuntimeContext, objectRuntime),
          Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
          Effect.provideService(Console.Console, testConsole),
        ),
      )
      const web = Option.isSome(routed) ? HttpServerResponse.toWeb(routed.value, { context }) : new Response("fell through", { status: 404 })
      res.writeHead(web.status, Object.fromEntries(web.headers))
      res.end(Buffer.from(await web.arrayBuffer()))
    } catch (error) {
      res.writeHead(500)
      res.end(String(error))
    }
  })

  await new Promise<void>((resolve) => bridgeServer.listen(0, "127.0.0.1", resolve))
  bridgeOrigin = `http://127.0.0.1:${(bridgeServer.address() as AddressInfo).port}`

  const container = {
    running: true,
    start: () => {},
    monitor: () => Promise.resolve(),
    setInactivityTimeout: () => Promise.resolve(),
    interceptOutboundHttp: async () => {},
    interceptAllOutboundHttp: () => Promise.resolve(),
    interceptOutboundHttps: () => Promise.resolve(),
    exec: async (argv: ReadonlyArray<string>) => {
      if (argv[3] !== "checkout") {
        return {
          pid: 1,
          isPty: false,
          stdin: new WritableStream(),
          stdout: new ReadableStream({ start: (s) => s.close() }),
          stderr: new ReadableStream({ start: (s) => s.close() }),
          exitCode: Promise.resolve(0),
          kill: () => {},
        }
      }
      const [shell, flag, script, name, branchArg, remoteArg] = argv
      const rewrittenScript = script!.replaceAll(WORKSPACE, workspaceDir)
      const rewrittenRemote = remoteArg!.replace("http://forge.smithers.internal", bridgeOrigin)
      const child = spawn(shell!, [flag!, rewrittenScript, name!, branchArg!, rewrittenRemote], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "ignore", "pipe"],
      })
      const stderr = new ReadableStream<Uint8Array>({
        start(controller) {
          child.stderr.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
          child.stderr.on("end", () => controller.close())
          child.stderr.on("error", (err) => controller.error(err))
        },
      })
      const exitCode = new Promise<number>((resolve, reject) => {
        child.on("error", reject)
        child.on("close", (code) => resolve(code ?? 137))
      })
      return {
        pid: child.pid ?? 1,
        isPty: false,
        stdin: new WritableStream(),
        stdout: new ReadableStream({ start: (s) => s.close() }),
        stderr,
        exitCode,
        kill: () => child.kill("SIGKILL"),
      }
    },
  }

  const jobBranch = {
    branchId: "job-public-forge-e2e",
    owner: "octo",
    name: "widgets",
    branch: sha,
    forge: "github" as const,
    kind: "job" as const,
  }

  try {
    const { initialize } = sandboxRegistration(container, { http: objectHttp })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const hyperdrive = yield* withScratchDatabase
      const sandbox = yield* initialize.pipe(Effect.provideService(Cloudflare.Hyperdrive.Connect, () => hyperdrive))
      activeSandbox = sandbox

      const freshDir = (label: string) => {
        workspaceDir = join(scratch, label)
        mkdirSync(workspaceDir, { recursive: true })
      }

      // 1. Ordinary public pinned checkout succeeds end-to-end.
      freshDir("happy")
      upstreamMode = "ok"
      bridgeMode = "routed"
      expect(yield* sandbox.wake(jobBranch)).toEqual({ _tag: "Woken", generation: 1 })
      expect(runGit(workspaceDir, "rev-parse", "HEAD")).toBe(sha)
      expect(upstreamCalls.some((c) => c.includes("https://github.com/octo/widgets.git/info/refs?service=git-upload-pack"))).toBe(true)
      expect(upstreamCalls.some((c) => c.includes("https://github.com/octo/widgets.git/git-upload-pack"))).toBe(true)

      // 2. Upstream returns 404 on info-refs -> discriminated as reached + github + infoRefs 404.
      freshDir("info-refs-404")
      upstreamMode = "info-refs-404"
      bridgeMode = "routed"
      const refs404 = yield* sandbox.wake(jobBranch)
      expect(refs404).toMatchObject({
        _tag: "CheckoutFailed",
        exitCode: 75,
        checkoutFailure: "clone",
        checkoutTransportCause: "http_status",
        checkoutHttpStatus: 404,
        checkoutForge: {
          routing: "reached",
          upstream: "github",
          infoRefs: { source: "upstream", status: 404, outcome: "4xx" },
        },
      })
      expect((refs404 as { checkoutForge?: { uploadPack?: unknown } }).checkoutForge?.uploadPack).toBeUndefined()

      // 3. Upstream returns 200 on info-refs, 404 on upload-pack -> both stages recorded cleanly.
      freshDir("upload-pack-404")
      upstreamMode = "upload-pack-404"
      bridgeMode = "routed"
      const pack404 = yield* sandbox.wake(jobBranch)
      expect(pack404).toEqual({
        _tag: "CheckoutFailed",
        exitCode: 75,
        checkoutFailure: "clone",
        checkoutTransportCause: "http_status",
        checkoutHttpStatus: 404,
        checkoutForge: {
          routing: "reached",
          upstream: "github",
          infoRefs: { source: "upstream", status: 200, outcome: "ok" },
          uploadPack: { source: "upstream", status: 404, outcome: "4xx" },
        },
      })

      // 4. Missing props at ChatApi routeBox fails closed with 502 (not 404) and records unreached.
      freshDir("missing-props")
      upstreamMode = "ok"
      bridgeMode = "missing-props"
      const missingProps = yield* sandbox.wake(jobBranch)
      expect(missingProps).toEqual({
        _tag: "CheckoutFailed",
        exitCode: 75,
        checkoutFailure: "clone",
        checkoutTransportCause: "http_status",
        checkoutHttpStatus: 502,
        checkoutForge: { routing: "unreached" },
      })

      // 5. 404 returned before SandboxObject.fetch records unreached.
      freshDir("pre-object-404")
      upstreamMode = "ok"
      bridgeMode = "pre-object-404"
      const preObject404 = yield* sandbox.wake(jobBranch)
      expect(preObject404).toEqual({
        _tag: "CheckoutFailed",
        exitCode: 75,
        checkoutFailure: "clone",
        checkoutTransportCause: "http_status",
        checkoutHttpStatus: 404,
        checkoutForge: { routing: "unreached" },
      })

      // 6. Non-forge host hitting SandboxObject.fetch during checkout is refused 403 and records host_mismatch.
      freshDir("host-mismatch")
      upstreamMode = "ok"
      bridgeMode = "host-mismatch"
      const mismatch = yield* sandbox.wake(jobBranch)
      expect(mismatch).toEqual({
        _tag: "CheckoutFailed",
        exitCode: 75,
        checkoutFailure: "clone",
        checkoutTransportCause: "http_status",
        checkoutHttpStatus: 403,
        checkoutForge: { routing: "host_mismatch" },
      })

      // Admission boundary: git-receive-pack remains refused with 403.
      const pushRefused = yield* fetchSandbox(
        sandbox,
        new Request("http://forge.smithers.internal/octo/widgets/info/refs?service=git-receive-pack"),
      )
      expect(pushRefused.status).toBe(403)
    })).pipe(
      Effect.provide(TestDatabase.layer("branch_sandbox_forge_e2e")),
      Effect.provideService(Console.Console, testConsole),
      Effect.provideService(RuntimeContext, objectRuntime),
    ))
  } finally {
    bridgeServer.closeAllConnections()
    upstreamServer.closeAllConnections()
    await new Promise<void>((resolve) => bridgeServer.close(() => resolve()))
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()))
    rmSync(scratch, { recursive: true, force: true })
  }
}, 60_000)
