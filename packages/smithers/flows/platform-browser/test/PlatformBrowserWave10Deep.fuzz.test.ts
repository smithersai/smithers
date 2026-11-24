import { SQLITE_IOERR, SQLITE_OK, SQLITE_OPEN_WAL } from "@journeyapps/wa-sqlite"
import { Fuzz } from "@smthrs/fuzz"
import { Flow, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { TerminalProtocol } from "@smthrs/sandbox"
import * as Arbitrary from "effect/Arbitrary"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Queue from "effect/Queue"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Socket from "effect/socket/Socket"
import * as SqlClient from "effect/sql/SqlClient"
import * as Stream from "effect/Stream"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { closeSync, fstatSync, fsyncSync, ftruncateSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs"
import * as NodeFsPromises from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { WebSocket as NodeWsClient, type WebSocket as Peer, WebSocketServer } from "ws"
import {
  BrowserChildProcessSpawner,
  BrowserEngine,
  BrowserFileSystem,
  BrowserLanguageServer,
  BrowserRuntime,
  BrowserSqlite,
  PendingSnapshot,
  SharedSqlite,
  StoragePersistence,
  TabChannel,
  TerminalSocket,
  WebLock
} from "../src/index.ts"
import * as Prepare from "../src/internal/Prepare.ts"
import * as Protocol from "../src/internal/Protocol.ts"
import * as SqlConnection from "../src/internal/SqlConnection.ts"
import * as SqlProtocol from "../src/internal/SqlProtocol.ts"
import * as TypeScriptWorkspace from "../src/internal/TypeScriptWorkspace.ts"
import { bufferWalWrites, type Vfs as WalVfs } from "../src/internal/WalBuffer.ts"
import * as Engines from "./fixtures/Engines.ts"
import { flows, registration, Sleeper, Steps, Waiter } from "./fixtures/Flows.ts"
import * as MemoryOpfs from "./fixtures/MemoryOpfs.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261142")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(25, Math.min(baseExecutions, 70))
const ioExec = Math.max(6, Math.min(Math.ceil(baseExecutions / 15), 14))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const libDirectory = dirname(createRequire(import.meta.url).resolve("typescript"))
const realLib = (name: string) => NodeFsPromises.readFile(join(libDirectory, name), "utf8").catch(() => undefined)

const richTsProject: Record<string, string | undefined> = {
  "tsconfig.json": `{
    "extends": ["./tsconfig.base", "./missing-base"],
    "compilerOptions": { "baseUrl": ".", "paths": { "@pkg/*": ["pkg/*"] } }
  }`,
  "tsconfig.base.json": `{
    "compilerOptions": { "strict": true, "lib": ["es2022"], "target": "es2022", "moduleResolution": "bundler" }
  }`,
  "pkg/package.json": `{"name":"@local/pkg","types":"./index.ts"}`,
  "pkg/index.ts": `export const pkgVal: number = 42`,
  "src/ref.ts": `export type RefAlias = string`,
  "src/main.ts": [
    `/// <reference path="./ref.ts" />`,
    `import { pkgVal } from "../pkg/index"`,
    `export enum Color { Red = 1, Blue = 2 }`,
    `export interface Shape { area(): number }`,
    `export type Box<T> = { value: T }`,
    `/**`,
    ` * Computes a value.`,
    ` * @param x the input`,
    ` * @deprecated`,
    ` */`,
    `export function compute<T>(x: T): Box<T> { return { value: x } }`,
    `export class Widget implements Shape {`,
    `  readonly count: number = pkgVal`,
    `  private _label: string = "w"`,
    `  constructor(label: string) { this._label = label }`,
    `  get label(): string { return this._label }`,
    `  set label(v: string) { this._label = v }`,
    `  area(): number { return this.count }`,
    `}`,
    `export const bad: number = "not-a-number"`
  ].join("\n")
}

const makeOverflowChannel = (name: string): Layer.Layer<TabChannel.TabChannel> =>
  Layer.succeed(TabChannel.TabChannel)({
    open: (channelName) =>
      Effect.succeed({
        post: () => Effect.void,
        subscribe: Effect.gen(function*() {
          const q = yield* Queue.unbounded<unknown, TabChannel.TabChannelOverflow>()
          yield* Queue.fail(q, new TabChannel.TabChannelOverflow({ channel: channelName || name, capacity: 1 }))
          return q
        })
      })
  })

describe("PlatformBrowser Wave 10 deep fuzzing", () => {
  it(
    "fuzzes BrowserEngine lifecycle, runs windowing, retry/cancel/signal/changes, worker failures, overflow, Leader wake/refusals, and BrowserRuntime uncaught handlers",
    async () => {
      const scenarios = [
        "worker-error-and-recover",
        "worker-stopped-message",
        "worker-ctor-throw",
        "channel-overflow",
        "commands-and-runs-window",
        "unknown-flow-and-bad-reply",
        "leader-wake-and-overflow",
        "runtime-uncaught-and-prepare-skip"
      ] as const

      const arb = Arbitrary.schema(Schema.Literals(scenarios))

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (scenario) =>
            Effect.scoped(
              Effect.gen(function*() {
                const name = Engines.name()

                if (scenario === "worker-ctor-throw") {
                  const eng = yield* BrowserEngine.make({
                    name,
                    worker: () => {
                      throw new TypeError("ctor-boom")
                    }
                  }).pipe(
                    Effect.provide(
                      Layer.mergeAll(
                        TabChannel.layer,
                        Layer.succeed(StoragePersistence.StoragePersistence)(
                          StoragePersistence.make({ persist: () => Promise.resolve(true) })
                        )
                      )
                    )
                  )
                  const unavail = yield* eng.unavailable
                  expect(unavail.reason).toBe("worker-failed")
                  const second = yield* Effect.flip(eng.list({ limit: 5 }))
                  expect(second._tag).toBe("@smthrs/platform-browser/EngineUnavailable")
                  return true
                }

                if (scenario === "worker-stopped-message") {
                  const w = Engines.worker()
                  const eng = yield* Engines.tab(name, { worker: w.handle })
                  const stopped = Schema.encodeSync(Protocol.Stopped)({
                    _tag: "@smthrs/platform-browser/EngineStopped",
                    error: "SqlError"
                  })
                  expect(Protocol.decodeStopped(stopped)).toBeDefined()
                  w.post(stopped)
                  const unavail = yield* eng.unavailable
                  expect(unavail.reason).toBe("engine-failed")
                  return true
                }

                if (scenario === "channel-overflow") {
                  const w = Engines.worker()
                  const eng = yield* BrowserEngine.make({
                    name,
                    worker: () => w.handle
                  }).pipe(
                    Effect.provide(
                      Layer.mergeAll(
                        makeOverflowChannel(name),
                        StoragePersistence.layer
                      )
                    )
                  )
                  const unavail = yield* eng.unavailable
                  expect(unavail.reason).toBe("channel-overflow")
                  // Also exercise BrowserEngine.layer constructor path
                  const built = yield* Effect.exit(
                    Layer.build(BrowserEngine.layer({ name: Engines.name(), worker: () => Engines.worker().handle }))
                  )
                  expect(Exit.isSuccess(built)).toBe(true)
                  return true
                }

                if (scenario === "worker-error-and-recover") {
                  const w = Engines.worker()
                  const eng = yield* Engines.tab(name, { worker: w.handle })
                  const pending = yield* Effect.forkChild(Effect.exit(eng.list({ limit: 5 })))
                  yield* Effect.sleep("15 millis")
                  w.fail(new ErrorEvent("error", { error: new RangeError("worker-crash") }))
                  const unavail = yield* eng.unavailable
                  expect(unavail.reason).toBe("worker-failed")
                  const pendingExit = yield* Fiber.await(pending)
                  expect(Exit.isSuccess(pendingExit) && Exit.isFailure(pendingExit.value)).toBe(true)
                  // Now start a real leader: its "Leader" announcement resets `failed`
                  const db = yield* MemorySqlite.open
                  const ldr = yield* Engines.leader(name, Engines.engine(name, db, Engines.steps()))
                  try {
                    const listed = yield* eng.list({ limit: 5 }).pipe(
                      Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 40 })
                    )
                    expect(Array.isArray(listed.runs)).toBe(true)
                  } finally {
                    yield* Engines.close(ldr)
                  }
                  return true
                }

                if (scenario === "commands-and-runs-window") {
                  const db = yield* MemorySqlite.open
                  const run = Engines.steps()
                  const ldr = yield* Engines.leader(name, Engines.engine(name, db, run))
                  try {
                    const eng = yield* Engines.tab(name)
                    const changesFiber = yield* Effect.forkChild(
                      eng.events.pipe(Stream.take(1), Stream.runCollect)
                    )
                    // Start 3 runs so limit: 1 forces cursor pagination in readWindow
                    for (let i = 0; i < 3; i++) {
                      const id = `win-${i}-${crypto.randomUUID().slice(0, 6)}`
                      yield* eng.start(Steps, { executionId: id, payload: { prefix: `s${i}` } })
                      yield* eng.result(Steps, id)
                    }
                    const gotChanges = yield* Fiber.await(changesFiber).pipe(Effect.timeoutOption("500 millis"))
                    expect(Option.isSome(gotChanges)).toBe(true)

                    // Exercise runs() stream with within + every (multi-page readWindow)
                    const windowChunks = yield* eng.runs({ limit: 1, within: Duration.hours(1), every: Duration.millis(10) }).pipe(Stream.take(1), Stream.runCollect)
                    expect(windowChunks.length).toBe(1)
                    expect(windowChunks[0]!.runs.length).toBeGreaterThanOrEqual(3)

                    // Exercise signal on Waiter
                    const waitId = `wait-${crypto.randomUUID().slice(0, 6)}`
                    yield* eng.start(Waiter, { executionId: waitId, payload: { prefix: "w" } })
                    yield* Effect.sleep("30 millis")
                    yield* eng.signal(Waiter, waitId, "approval", "resumed")
                    const waitRes = yield* eng.result(Waiter, waitId)
                    expect(waitRes).toEqual(Exit.succeed("resumed"))

                    // Exercise cancel on Sleeper
                    const sleepId = `sleep-${crypto.randomUUID().slice(0, 6)}`
                    yield* eng.start(Sleeper, { executionId: sleepId, payload: { prefix: "z", pauseMs: 60_000 } })
                    yield* Effect.sleep("15 millis")
                    yield* eng.cancel(Sleeper, sleepId)

                    // Exercise retry on completed Step
                    const firstId = windowChunks[0]!.runs[0]!.runId
                    const retryExit = yield* Effect.exit(
                      eng.retry(Steps, { source: firstId, step: "step", executionId: `retry-${crypto.randomUUID().slice(0, 6)}` })
                    )
                    expect(retryExit).toBeDefined()
                  } finally {
                    yield* Engines.close(ldr)
                  }
                  return true
                }

                if (scenario === "unknown-flow-and-bad-reply") {
                  const db = yield* MemorySqlite.open
                  const ldr = yield* Engines.leader(name, Engines.engine(name, db, Engines.steps()))
                  try {
                    const eng = yield* Engines.tab(name)
                    const Ghost = Flow.make("ghost/unknown", {
                      payload: {},
                      success: Schema.String,
                      body: Node.capture({}, () => Node.succeed("x"))
                    })
                    const refused = yield* Effect.flip(eng.start(Ghost, { executionId: "g1", payload: {} }))
                    expect(refused._tag).toBe("@smthrs/platform-browser/RequestRefused")
                  } finally {
                    yield* Engines.close(ldr)
                  }

                  // Fake leader returning malformed result to hit SchemaError in BrowserEngine.read
                  const badName = Engines.name()
                  const channel = yield* TabChannel.TabChannel.pipe(Effect.provide(TabChannel.layer))
                  const port = yield* channel.open(badName)
                  const sub = yield* port.subscribe
                  const responder = yield* Stream.fromQueue(sub).pipe(
                    Stream.runForEach((raw) => {
                      const req = Protocol.decode(raw)
                      if (req === undefined || !("client" in req) || req._tag === "Replied" || req._tag === "Refused") return Effect.void
                      return port.post(
                        Protocol.encode({
                          _tag: "Replied",
                          client: req.client,
                          id: req.id,
                          result: { totally_invalid: true }
                        })
                      )
                    }),
                    Effect.forkChild
                  )
                  try {
                    const eng = yield* Engines.tab(badName)
                    const schemaRefused = yield* Effect.flip(eng.list({ limit: 5 }))
                    expect(schemaRefused._tag).toBe("@smthrs/platform-browser/RequestRefused")
                    // Also trigger runs() stream unread retry warning
                    const runsFiber = yield* Effect.forkChild(
                      eng.runs({ limit: 5, every: Duration.millis(10) }).pipe(Stream.take(1), Stream.runDrain)
                    )
                    yield* Effect.sleep("45 millis")
                    yield* Fiber.interrupt(runsFiber)
                  } finally {
                    yield* Fiber.interrupt(responder)
                  }
                  return true
                }

                if (scenario === "leader-wake-and-overflow") {
                  // 1. Seed a database with a running unknown flow & a running known flow, then boot a new leader to wake them!
                  const db = yield* MemorySqlite.open
                  const telemetry = Telemetry.make()
                  // First boot leader 1 and start Waiter so it stays running in SQLite
                  const ldr1 = yield* Engines.leader(name, Engines.engine(name, db, Engines.steps()))
                  const eng = yield* Engines.tab(name)
                  const waitId = `wake-${crypto.randomUUID().slice(0, 6)}`
                  yield* eng.start(Waiter, { executionId: waitId, payload: { prefix: "w" } })
                  yield* Effect.sleep("25 millis")
                  yield* Engines.close(ldr1)

                  // Boot leader 2 with ONLY [Step] (so Waiter is unknown-flow!) -> hits unknown-flow wake path
                  const ldr2 = yield* Effect.forkChild(
                    telemetry.observed(
                      BrowserRuntime.serve({ name, flows: [Steps] }, Engines.engine(name, db, Engines.steps())).pipe(
                        Effect.provide(Engines.platform)
                      )
                    )
                  )
                  yield* Effect.sleep("40 millis")
                  yield* Engines.close(ldr2)

                  // Boot leader 3 with full flows -> wakes Waiter (known flow wake path)
                  const ldr3 = yield* Effect.forkChild(
                    telemetry.observed(
                      BrowserRuntime.serve({ name, flows }, Engines.engine(name, db, Engines.steps())).pipe(
                        Effect.provide(Engines.platform)
                      )
                    )
                  )
                  yield* Effect.sleep("40 millis")
                  yield* Engines.close(ldr3)

                  // Leader channel overflow -> hits Leader overflow catch + browser.runtime.lost
                  const ovName = Engines.name()
                  const ovDb = yield* MemorySqlite.open
                  const ovFiber = yield* Effect.forkChild(
                    BrowserRuntime.serve({ name: ovName, flows }, Engines.engine(ovName, ovDb, Engines.steps())).pipe(
                      Effect.provide(Layer.mergeAll(WebLock.layer, makeOverflowChannel(ovName)))
                    )
                  )
                  yield* Effect.sleep("35 millis")
                  yield* Fiber.interrupt(ovFiber)
                  return true
                }

                // scenario === "runtime-uncaught-and-prepare-skip"
                const telemetry = Telemetry.make()
                const target = new EventTarget()
                const posted: Array<unknown> = []
                const port: BrowserRuntime.WorkerPort = {
                  addEventListener: target.addEventListener.bind(target),
                  removeEventListener: target.removeEventListener.bind(target),
                  postMessage: (data) => {
                    posted.push(data)
                  }
                }
                const removeOpfs = MemoryOpfs.install()
                try {
                  const workerFiber = BrowserRuntime.run({
                    name,
                    port,
                    sqlite: MemorySqlite.build,
                    flows,
                    registerFlows: registration(Effect.succeed),
                    telemetry: telemetry.layer
                  })
                  yield* Effect.sleep("40 millis")
                  target.dispatchEvent(new ErrorEvent("error", { error: { _tag: "TaggedBoom" } }))
                  target.dispatchEvent(new ErrorEvent("error", { error: new TypeError("type-boom") }))
                  const rej = Object.assign(new Event("unhandledrejection"), { reason: "plain-str" })
                  target.dispatchEvent(rej)
                  yield* Fiber.interrupt(workerFiber)

                  // Fatal wasm build failure posts Protocol.Stopped to port
                  const failPosted: Array<unknown> = []
                  const failPort: BrowserRuntime.WorkerPort = {
                    addEventListener: target.addEventListener.bind(target),
                    removeEventListener: target.removeEventListener.bind(target),
                    postMessage: (data) => {
                      failPosted.push(data)
                    }
                  }
                  const badWorker = BrowserRuntime.run({
                    name: Engines.name(),
                    port: failPort,
                    sqlite: { ...MemorySqlite.build, wasm: () => Promise.resolve(new Uint8Array([0])) },
                    flows,
                    registerFlows: registration(Effect.succeed),
                    telemetry: telemetry.layer
                  })
                  yield* Fiber.await(badWorker)
                  expect(failPosted.some((m) => Protocol.decodeStopped(m) !== undefined)).toBe(true)
                } finally {
                  removeOpfs()
                }

                // Prepare without SqlConnection returns "skipped"
                const skipped = yield* Prepare.run({ epoch: "e1", run: () => Effect.void } as any, Context.empty() as any)
                expect(skipped).toBeUndefined()

                return true
              })
            ),
          { seed, executions: ioExec }
        )
      )
      assertPassed(report)
    },
    90_000
  )

  it(
    "fuzzes BrowserLanguageServer & TypeScriptWorkspace across all LSP methods, symbols, diagnostics, errors, timeouts, cancellations, and worker failures",
    async () => {
      // Pure helper fuzzing
      const helperArb = Arbitrary.schema(
        Schema.Literals([
          "file:///src/a%20b.ts",
          "file:///%E0%A4%A",
          "https://example.com/a.ts",
          `${TypeScriptWorkspace.LIB_DIRECTORY}/lib.es2022.d.ts`,
          "/src/main.ts"
        ])
      )
      const helperReport = await Effect.runPromise(
        Fuzz.run(
          helperArb,
          (input) =>
            Effect.sync(() => {
              const p = BrowserLanguageServer.pathOf(input)
              if (input === "file:///src/a%20b.ts") expect(p).toBe("/src/a b.ts")
              else if (input.startsWith("file:///")) expect(p).toBeUndefined()
              else expect(p).toBeUndefined()
              const isL = BrowserLanguageServer.isLib(input)
              expect(isL).toBe(input.startsWith(`${TypeScriptWorkspace.LIB_DIRECTORY}/`))
              return true
            }),
          { seed: seed + 1, executions: fastExec }
        )
      )
      assertPassed(helperReport)

      // Full real MessageChannel + TypeScript compiler scenarios
      const lsScenarios = [
        "full-lsp-methods",
        "before-open-and-defect",
        "timeout-and-cancel",
        "worker-error-event",
        "byte-limit-and-read-fail"
      ] as const

      const lsReport = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Schema.Literals(lsScenarios)),
          (scenario) =>
            Effect.scoped(
              Effect.gen(function*() {
                if (scenario === "full-lsp-methods") {
                  const channel = new MessageChannel()
                  channel.port1.start()
                  const serverFiber = BrowserLanguageServer.serve({
                    typescript: ts,
                    lib: realLib,
                    port: channel.port2
                  })
                  yield* Effect.sleep("20 millis")
                  channel.port2.start()
                  try {
                    const client = yield* BrowserLanguageServer.make({
                      worker: () =>
                        Object.assign(channel.port1, {
                          terminate: () => channel.port1.close()
                        }) as unknown as BrowserLanguageServer.WorkerLike,
                      workspace: {
                        paths: Object.keys(richTsProject),
                        read: (path) => {
                          const content = richTsProject[path]
                          return content === undefined ? Effect.fail("missing") : Effect.succeed(content)
                        }
                      }
                    })

                    // Unsupported call hierarchy methods
                    for (const eff of [
                      client.prepareCallHierarchy({ path: "/src/main.ts", line: 0, character: 0 }),
                      client.callHierarchyIncoming({ path: "/src/main.ts", line: 0, character: 0 }),
                      client.callHierarchyOutgoing({ path: "/src/main.ts", line: 0, character: 0 })
                    ]) {
                      const err = yield* Effect.flip(eff)
                      expect(err.code).toBe("unsupported")
                    }

                    // Hover with JSDoc tags (@param + bare @deprecated)
                    const hov = yield* client.hover({ path: "/src/main.ts", line: 10, character: 17 })
                    expect(JSON.stringify(hov)).toContain("@param")
                    // Hover out-of-bounds line (hits offsetOf start === undefined)
                    const oob = yield* client.hover({ path: "/src/main.ts", line: 999, character: 5 })
                    expect(oob).toBeNull()

                    // References & implementation
                    const refs = yield* client.references({ path: "/src/main.ts", line: 3, character: 17 })
                    expect(Array.isArray(refs)).toBe(true)
                    const impls = yield* client.implementation({ path: "/src/main.ts", line: 3, character: 17 })
                    expect(Array.isArray(impls)).toBe(true)

                    // Document symbols & workspace symbols (hits enum, class, method, property, accessor, constructor, interface, type, function, enum member, type parameter)
                    const docSyms = yield* client.documentSymbols("/src/main.ts")
                    expect(Array.isArray(docSyms) && docSyms.length > 0).toBe(true)
                    const wsSyms = yield* client.workspaceSymbols("Widget")
                    expect(Array.isArray(wsSyms) && wsSyms.length > 0).toBe(true)

                    // Diagnostics (hits diagnostic mapping)
                    const diags = yield* client.diagnostics("/src/main.ts")
                    expect(diags).toBeDefined()

                    // Sync overlay in new dir (hits directoryExists overlay check) & close
                    yield* client.sync("/src/main.ts", richTsProject["src/main.ts"]! + "\nexport const z: number = 1")
                    yield* client.close("/src/main.ts")
                    const outsideExit = yield* Effect.exit(client.sync("/overlay/extra.ts", "export const z = 1"))
                    expect(outsideExit).toBeDefined()
                    yield* client.refresh
                  } finally {
                    yield* Fiber.interrupt(serverFiber)
                    channel.port1.close()
                    channel.port2.close()
                  }
                  return true
                }

                if (scenario === "before-open-and-defect") {
                  // Send a request directly to program() before Open -> hits "No workspace is open"
                  const channel = new MessageChannel()
                  channel.port1.start()
                  const throwingTs = {
                    ...ts,
                    createLanguageService: () => {
                      throw new Error("compiler-defect")
                    }
                  } as unknown as TypeScriptWorkspace.TypeScript
                  const fiber = yield* Effect.forkChild(
                    BrowserLanguageServer.program({
                      typescript: throwingTs,
                      lib: () => Promise.reject(new Error("lib-fail")),
                      port: channel.port2
                    })
                  )
                  yield* Effect.sleep("20 millis")
                  channel.port2.start()
                  try {
                    const replies: Array<any> = []
                    channel.port1.addEventListener("message", (ev) => replies.push(ev.data))
                    yield* Effect.sleep("15 millis")
                    channel.port1.postMessage({ _tag: "Request", id: 1, method: "diagnostics", params: { path: "/a.ts" } })
                    yield* Effect.sleep("25 millis")
                    expect(replies.some((r) => r._tag === "Refuse" && r.id === 1)).toBe(true)

                    // Open then trigger compiler defect
                    channel.port1.postMessage({ _tag: "Open", paths: ["src/a.ts"] })
                    channel.port1.postMessage({ _tag: "Request", id: 2, method: "diagnostics", params: { path: "/src/a.ts" } })
                    yield* Effect.sleep("35 millis")
                    // Also send Cancel for nonexistent/active id
                    channel.port1.postMessage({ _tag: "Cancel", id: 2 })
                    yield* Effect.sleep("15 millis")
                  } finally {
                    yield* Fiber.interrupt(fiber)
                    channel.port1.close()
                    channel.port2.close()
                  }
                  return true
                }

                if (scenario === "timeout-and-cancel") {
                  // Worker that never replies -> triggers timeout + Cancel; also triggers CancelRead
                  const listeners = new Map<string, Array<(e: any) => void>>()
                  const posted: Array<any> = []
                  const fakeWorker: BrowserLanguageServer.WorkerLike = {
                    postMessage: (data) => {
                      posted.push(data)
                    },
                    addEventListener: (type: string, fn: any) => {
                      const arr = listeners.get(type) ?? []
                      arr.push(fn)
                      listeners.set(type, arr)
                    },
                    terminate: () => {}
                  }
                  const client = yield* BrowserLanguageServer.make({
                    worker: () => fakeWorker,
                    workspace: {
                      paths: ["a.ts"],
                      read: () => Effect.never
                    },
                    timeout: Duration.millis(25)
                  })
                  // Trigger timeout
                  const err = yield* Effect.flip(client.diagnostics("/a.ts"))
                  expect(err.code).toBe("timeout")

                  // Simulate worker sending Read then CancelRead, plus Error reply for unknown id & known id
                  const msgListeners = listeners.get("message") ?? []
                  for (const fn of msgListeners) {
                    fn(new MessageEvent("message", { data: { _tag: "Read", id: 99, paths: ["/a.ts"] } }))
                    fn(new MessageEvent("message", { data: { _tag: "CancelRead", id: 99 } }))
                    fn(new MessageEvent("message", { data: { _tag: "Reply", id: 99999, result: null } }))
                  }
                  yield* Effect.sleep("15 millis")
                  const pendingReq = yield* Effect.forkChild(Effect.exit(client.diagnostics("/a.ts")))
                  yield* Effect.sleep("10 millis")
                  const lastReq = posted.filter((m) => m?._tag === "Request").at(-1)
                  if (lastReq !== undefined) {
                    for (const fn of msgListeners) {
                      fn(new MessageEvent("message", { data: { _tag: "Refuse", id: lastReq.id, code: "invalid_input", message: "bad", method: "diagnostics" } }))
                    }
                  }
                  const reqExit = yield* Fiber.await(pendingReq)
                  expect(Exit.isSuccess(reqExit) && Exit.isFailure(reqExit.value)).toBe(true)
                  return true
                }

                if (scenario === "worker-error-event") {
                  const listeners = new Map<string, Array<(e: any) => void>>()
                  const fakeWorker: BrowserLanguageServer.WorkerLike = {
                    postMessage: () => {},
                    addEventListener: (type: string, fn: any) => {
                      const arr = listeners.get(type) ?? []
                      arr.push(fn)
                      listeners.set(type, arr)
                    },
                    terminate: () => {}
                  }
                  const client = yield* BrowserLanguageServer.make({
                    worker: () => fakeWorker,
                    workspace: { paths: ["a.ts"], read: () => Effect.succeed("") }
                  })
                  const inflight = yield* Effect.forkChild(Effect.exit(client.diagnostics("/a.ts")))
                  yield* Effect.sleep("15 millis")
                  for (const fn of listeners.get("error") ?? []) {
                    fn(new ErrorEvent("error", { error: new Error("worker-died") }))
                  }
                  const first = yield* Fiber.await(inflight)
                  expect(Exit.isSuccess(first) && Exit.isFailure(first.value)).toBe(true)
                  const second = yield* Effect.flip(client.diagnostics("/a.ts"))
                  expect(second.code).toBe("provider_unavailable")
                  return true
                }

                // scenario === "byte-limit-and-read-fail"
                const channel = new MessageChannel()
                  channel.port1.start()
                const serverFiber = yield* Effect.forkChild(
                  BrowserLanguageServer.program({
                    typescript: ts,
                    lib: () => Promise.reject(new Error("no-lib")),
                    port: channel.port2,
                    limits: { bytes: 20, files: 10 }
                  })
                )
                yield* Effect.sleep("20 millis")
                channel.port2.start()
                try {
                  const client = yield* BrowserLanguageServer.make({
                    worker: () =>
                      Object.assign(channel.port1, {
                        terminate: () => channel.port1.close()
                      }) as unknown as BrowserLanguageServer.WorkerLike,
                    workspace: {
                      paths: ["src/big.ts", "src/missing.ts"],
                      read: (p) =>
                        p === "src/big.ts"
                          ? Effect.succeed("export const big = '" + "x".repeat(100) + "'")
                          : Effect.fail("unreadable")
                    }
                  })
                  const d = yield* client.diagnostics("/src/big.ts")
                  expect(d).toBeDefined()
                } finally {
                  yield* Fiber.interrupt(serverFiber)
                  channel.port1.close()
                  channel.port2.close()
                }
                return true
              })
            ),
          { seed: seed + 2, executions: Math.min(ioExec, 8) }
        )
      )
      assertPassed(lsReport)
    },
    90_000
  )

  it(
    "fuzzes TerminalSocket across Blob frames, resize dedup, ended/final/transient closes, constructor throw, unsupported/oversized/overflow frames, and onOutput defect",
    async () => {
      const modes = [
        "ws-blob-and-ended",
        "ws-final-and-transient-giveup",
        "ctor-throw",
        "unsupported-frame",
        "oversized-frame",
        "backlog-overflow",
        "onOutput-defect"
      ] as const

      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Schema.Literals(modes)),
          (mode) =>
            Effect.scoped(
              Effect.gen(function*() {
                const fastPolicy = RetryPolicy.make({ initialMs: 5, factor: 1, maxMs: 10, maxAttempts: 2 })

                if (mode === "ctor-throw") {
                  const layer = Layer.succeed(Socket.WebSocketConstructor)(() => {
                    throw new Error("ws-ctor-failed")
                  })
                  const conn = yield* TerminalSocket.connect("ws://127.0.0.1:1/t", {
                    onOutput: () => {},
                    reconnect: fastPolicy
                  }).pipe(Effect.provide(layer))
                  const statuses = yield* conn.status.pipe(
                    Stream.takeUntil((s) => s._tag === "Closed"),
                    Stream.runCollect
                  )
                  expect(statuses.some((s) => s._tag === "Closed")).toBe(true)
                  return true
                }

                if (mode === "unsupported-frame" || mode === "oversized-frame" || mode === "backlog-overflow" || mode === "onOutput-defect") {
                  const makeFakeWsLayer = (onOpen: (dispatch: (type: string, ev: any) => void) => void) =>
                    Layer.succeed(Socket.WebSocketConstructor)(() => {
                      const map = new Map<string, Array<(e: any) => void>>()
                      const dispatch = (type: string, ev: any) => {
                        for (const fn of map.get(type) ?? []) fn(ev)
                      }
                      const ws = {
                        binaryType: "blob",
                        readyState: 1,
                        send: () => {},
                        close: () => {},
                        addEventListener: (type: string, fn: any) => {
                          const arr = map.get(type) ?? []
                          arr.push(fn)
                          map.set(type, arr)
                        },
                        removeEventListener: (type: string, fn: any) => {
                          const arr = map.get(type) ?? []
                          const idx = arr.indexOf(fn)
                          if (idx >= 0) arr.splice(idx, 1)
                        }
                      }
                      queueMicrotask(() => onOpen(dispatch))
                      return ws as unknown as globalThis.WebSocket
                    })

                  const layer = makeFakeWsLayer((dispatch) => {
                    if (mode === "unsupported-frame") {
                      dispatch("message", { data: 12345 })
                      dispatch("message", { data: 67890 }) // hits Deferred.isDoneUnsafe(rejected)
                    } else if (mode === "oversized-frame") {
                      dispatch("message", { data: new ArrayBuffer(2 * 1024 * 1024) })
                    } else if (mode === "backlog-overflow") {
                      const chunk = new ArrayBuffer(TerminalProtocol.maxFrameBytes)
                      for (let i = 0; i < 18; i++) dispatch("message", { data: chunk })
                    } else {
                      dispatch("message", { data: new Blob([new Uint8Array([65, 66])]) })
                    }
                  })

                  const conn = yield* TerminalSocket.connect("ws://127.0.0.1:1/t", {
                    onOutput: () => {
                      if (mode === "onOutput-defect") throw new Error("render-defect")
                    },
                    reconnect: fastPolicy
                  }).pipe(Effect.provide(layer))

                  const statuses = yield* conn.status.pipe(
                    Stream.takeUntil((s) => s._tag === "Closed"),
                    Stream.runCollect
                  )
                  expect(statuses.some((s) => s._tag === "Closed")).toBe(true)
                  return true
                }

                // Real loopback WebSocketServer for ws-blob-and-ended & ws-final-and-transient-giveup
                const peers = yield* Queue.unbounded<Peer>()
                const wss = yield* Effect.acquireRelease(
                  Effect.callback<WebSocketServer>((resume) => {
                    const s = new WebSocketServer({ host: "127.0.0.1", port: 0 })
                    s.once("listening", () => resume(Effect.succeed(s)))
                    s.on("connection", (p) => Queue.offerUnsafe(peers, p))
                  }),
                  (s) => Effect.callback<void>((resume) => s.close(() => resume(Effect.void)))
                )
                const port = (wss.address() as { port: number }).port
                const wsLayer = Layer.succeed(Socket.WebSocketConstructor)(
                  (url) => new NodeWsClient(url) as unknown as globalThis.WebSocket
                )

                const received: Array<Uint8Array> = []
                const conn = yield* TerminalSocket.connect(`ws://127.0.0.1:${port}/t`, {
                  onOutput: (b) => received.push(b),
                  reconnect: fastPolicy
                }).pipe(Effect.provide(wsLayer))

                if (mode === "ws-blob-and-ended") {
                  const peer = yield* Queue.take(peers)
                  peer.send(JSON.stringify({ type: "ready", access: "write" }))
                  yield* Effect.sleep("20 millis")
                  yield* conn.resize(80, 24)
                  yield* conn.resize(80, 24) // duplicate resize skipped
                  yield* conn.send("ls\n")
                  peer.send(Buffer.from([1, 2, 3]), { binary: true })
                  peer.send(JSON.stringify({ type: "ended", reason: "slept" }))
                  const statuses = yield* conn.status.pipe(
                    Stream.takeUntil((s) => s._tag === "Ended"),
                    Stream.runCollect
                  )
                  expect(statuses.some((s) => s._tag === "Ended")).toBe(true)
                } else {
                  // Transient close (1006/1012) causes Offline -> Connecting -> retry -> Closed
                  const closer = yield* Effect.forkChild(
                    Effect.forever(
                      Effect.gen(function*() {
                        const peer = yield* Queue.take(peers)
                        peer.close(1012)
                      })
                    )
                  )
                  try {
                    const statuses = yield* conn.status.pipe(
                      Stream.takeUntil((s) => s._tag === "Closed"),
                      Stream.runCollect
                    )
                    expect(statuses.some((s) => s._tag === "Offline")).toBe(true)
                    expect(statuses.some((s) => s._tag === "Closed")).toBe(true)
                  } finally {
                    yield* Fiber.interrupt(closer)
                  }
                }
                return true
              })
            ),
          { seed: seed + 3, executions: ioExec }
        )
      )
      assertPassed(report)
    },
    90_000
  )

  it(
    "fuzzes SharedSqlite, SqlConnection, BrowserSqlite, WalBuffer, BrowserChildProcessSpawner, BrowserFileSystem, PendingSnapshot, and WebLock edge paths",
    async () => {
      const areas = [
        "shared-sqlite-handoff-and-overflow",
        "sql-connection-savepoint-vacuum-wait-poison",
        "browser-sqlite-methods-and-errors",
        "wal-buffer-errors-and-oversized",
        "child-process-rejections-and-sinks",
        "filesystem-stream-readdir-realpath",
        "pending-snapshot-and-weblock"
      ] as const

      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Schema.Literals(areas)),
          (area) =>
            Effect.scoped(
              Effect.gen(function*() {
                if (area === "shared-sqlite-handoff-and-overflow") {
                  // 1. Overflow on SharedSqlite tab (pending + subsequent)
                  const ovName = Engines.name()
                  const ovTab = yield* SharedSqlite.make({ name: ovName }).pipe(
                    Effect.provide(Layer.mergeAll(makeOverflowChannel(ovName), WebLock.layer))
                  )
                  const err1 = yield* Effect.flip(ovTab.execute("SELECT 1"))
                  expect(err1._tag).toBe("SqlError")
                  const err2 = yield* Effect.flip(ovTab.execute("SELECT 1"))
                  expect(err2._tag).toBe("SqlError")

                  // Exercise SharedSqlite.layer
                  const builtLayer = yield* Effect.exit(Layer.build(SharedSqlite.layer({ name: Engines.name() })))
                  expect(Exit.isSuccess(builtLayer)).toBe(true)

                  // 2. Leader handoff mid-transaction with replay (both matching replay AND non-replayable/mismatch rollback)
                  const name = Engines.name()
                  const pool = yield* MemorySqlite.pool
                  const db1 = yield* MemorySqlite.open
                  const ldr1 = yield* Engines.leader(name, Engines.engineWithApp(name, db1, Engines.steps(), pool))
                  const tab = yield* Engines.sharedTab(name)
                  yield* tab.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
                  yield* tab.execute("BEGIN")
                  yield* tab.execute("INSERT INTO t (id, v) VALUES (?, ?)", [1, "a"])
                  // Kill leader 1 while tx is open, start leader 2 over same pool -> next execute triggers TransactionLost + replay!
                  yield* Engines.close(ldr1)
                  const db2 = yield* MemorySqlite.open
                  const ldr2 = yield* Engines.leader(name, Engines.engineWithApp(name, db2, Engines.steps(), pool))
                  try {
                    yield* tab.execute("INSERT INTO t (id, v) VALUES (?, ?)", [2, "b"])
                    yield* tab.execute("COMMIT")
                    const rows = yield* tab.execute("SELECT count(*) AS n FROM t")
                    expect(rows).toEqual([{ n: 2 }])

                    // Also exercise Leader without SqlConnection -> DatabaseUnavailable
                    const noAppName = Engines.name()
                    const noAppDb = yield* MemorySqlite.open
                    const noAppLdr = yield* Engines.leader(noAppName, Engines.engine(noAppName, noAppDb, Engines.steps()))
                    try {
                      const noAppTab = yield* Engines.sharedTab(noAppName)
                      const unavailErr = yield* Effect.flip(noAppTab.execute("SELECT 1"))
                      expect(unavailErr._tag).toBe("SqlError")
                    } finally {
                      yield* Engines.close(noAppLdr)
                    }
                  } finally {
                    yield* Engines.close(ldr2)
                  }

                  // 3. SharedSqlite batch fallback when leader replies without `results`
                  const fbName = Engines.name()
                  const ch = yield* TabChannel.TabChannel.pipe(Effect.provide(TabChannel.layer))
                  const port = yield* ch.open(SqlProtocol.channel(fbName))
                  const sub = yield* port.subscribe
                  const responder = yield* Stream.fromQueue(sub).pipe(
                    Stream.runForEach((raw) => {
                      const msg = SqlProtocol.decode(raw)
                      if (msg?._tag !== "Execute") return Effect.void
                      return port.post(
                        SqlProtocol.encode({
                          _tag: "Executed",
                          client: msg.client,
                          id: msg.id,
                          leader: "fake-leader",
                          open: false,
                          rows: [{ ok: 1 }]
                        })
                      )
                    }),
                    Effect.forkChild
                  )
                  try {
                    const db = yield* Effect.promise(() => SharedSqlite.open({ name: fbName, within: "2 seconds" }))
                    try {
                      const batchOut = yield* Effect.promise(() =>
                        db.executeBatch([
                          { sql: "SELECT 1" },
                          { sql: "SELECT 2" }
                        ])
                      )
                      expect(batchOut).toEqual([[{ ok: 1 }], [{ ok: 1 }]])
                    } finally {
                      yield* Effect.promise(() => db.close())
                    }
                    // Also hit SharedSqlite.open timeout with no leader + runtime.dispose() catch
                    const noLdrExit = yield* Effect.exit(
                      Effect.tryPromise(() => SharedSqlite.open({ name: Engines.name(), within: "25 millis" }))
                    )
                    expect(Exit.isFailure(noLdrExit)).toBe(true)
                  } finally {
                    yield* Fiber.interrupt(responder)
                  }
                  return true
                }

                if (area === "sql-connection-savepoint-vacuum-wait-poison") {
                  // Test ReceiptFailed -> TransactionUnrecorded when receipt tables are absent
                  const bareDb = yield* MemorySqlite.open
                  const bareConn = yield* SqlConnection.make(bareDb)
                  const unrecNoTbl = yield* Effect.flip(bareConn.run("o1", "BEGIN", [], false, { id: 1, at: 1000, undecided: false }))
                  expect(unrecNoTbl._tag).toBe("@smthrs/platform-browser/TransactionUnrecorded")

                  const db = yield* MemorySqlite.open
                  yield* Effect.promise(() =>
                    db.sqlite3.exec(
                      db.db,
                      `CREATE TABLE ${SqlProtocol.commits} (client TEXT PRIMARY KEY, opened INTEGER NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;
                       CREATE TABLE ${SqlProtocol.replies} (client TEXT PRIMARY KEY, request INTEGER NOT NULL, rows TEXT NOT NULL) WITHOUT ROWID;`
                    )
                  )
                  const conn = yield* SqlConnection.make(db)
                  yield* conn.run("o1", "CREATE TABLE s (id INTEGER PRIMARY KEY)", [], false)

                  // PRAGMA writable_schema refused by authorizer
                  const pragmaExit = yield* Effect.exit(conn.run("o1", "PRAGMA writable_schema = ON", [], false))
                  expect(pragmaExit).toBeDefined()

                  // VACUUM -> VacuumUnsupported
                  const vacErr = yield* Effect.flip(conn.run("o1", "VACUUM", [], false, { id: 99, at: 1000, undecided: false }))
                  expect(vacErr._tag).toBe("@smthrs/platform-browser/VacuumUnsupported")

                  // continuing: true when no tx is held -> TransactionLost
                  const lostErr = yield* Effect.flip(conn.run("o1", "SELECT 1", [], true))
                  expect(lostErr._tag).toBe("@smthrs/platform-browser/TransactionLost")

                  // SAVEPOINT / ROLLBACK TO / RELEASE + returning rows in receipted transaction + concurrent Wait
                  yield* conn.run("o1", "BEGIN", [], false, { id: 1, at: 1000, undecided: false })
                  yield* conn.run("o1", "SAVEPOINT sp1", [], true)
                  yield* conn.run("o1", "INSERT INTO s (id) VALUES (1)", [], true)
                  yield* conn.run("o1", "ROLLBACK TO sp1", [], true)
                  yield* conn.run("o1", "RELEASE sp1", [], true)
                  const waiter = yield* Effect.forkChild(conn.run("o2", "SELECT count(*) AS n FROM s", [], false))
                  yield* Effect.sleep("15 millis")
                  yield* conn.run("o1", "INSERT INTO s (id) VALUES (2) RETURNING id", [], true, { id: 2, at: 1001, undecided: false })
                  yield* conn.run("o1", "COMMIT", [], true, { id: 3, at: 1002, undecided: false })
                  const waitRes = yield* Fiber.await(waiter)
                  expect(Exit.isSuccess(waitRes)).toBe(true)
                  // Clean receipted transaction with RETURNING rows to cover writeReply
                  yield* conn.run("o1", "BEGIN", [], false, { id: 10, at: 1010, undecided: false })
                  yield* conn.run("o1", "INSERT INTO s (id) VALUES (3) RETURNING id", [], true, { id: 11, at: 1011, undecided: false })
                  yield* conn.run("o1", "COMMIT", [], true, { id: 12, at: 1012, undecided: false })

                  // Poison via authorizer refusing ROLLBACK on abandon
                  yield* conn.run("o1", "BEGIN", [], false)
                  db.sqlite3.set_authorizer(
                    db.db,
                    (_, action, op) => action === 22 && op === "ROLLBACK" ? 1 : 0,
                    null
                  )
                  const abExit = yield* Effect.exit(conn.abandon("o1"))
                  expect(Exit.isFailure(abExit)).toBe(true)
                  const poisonedErr = yield* Effect.flip(conn.run("o3", "SELECT 1", [], false))
                  expect(poisonedErr._tag).toBe("SqlError")
                  db.sqlite3.set_authorizer(db.db, () => 0, null)
                  yield* Effect.promise(() => db.sqlite3.exec(db.db, "ROLLBACK"))
                  return true
                }

                if (area === "browser-sqlite-methods-and-errors") {
                  // Exercise executeValues, executeRaw (rows + changes), executeUnprepared, executeStream (dies)
                  yield* Effect.gen(function*() {
                    const client = yield* SqlClient.SqlClient
                    yield* client`CREATE TABLE m (id INTEGER PRIMARY KEY, name TEXT)`
                    yield* client`INSERT INTO m (id, name) VALUES (${1}, ${"a"}), (${2}, ${"b"})`
                    expect(yield* client`SELECT id, name FROM m ORDER BY id`.values).toEqual([[1, "a"], [2, "b"]])
                    expect(yield* client`SELECT id FROM m WHERE id = 1`.raw).toEqual([{ id: 1 }])
                    expect(yield* client`DELETE FROM m WHERE id = 2`.raw).toEqual({ changes: 1 })
                    expect(yield* client.unsafe("SELECT name FROM m", [])).toEqual([{ name: "a" }])
                    const streamExit = yield* Effect.exit(Stream.runCollect(client`SELECT id FROM m`.stream))
                    expect(Exit.isFailure(streamExit)).toBe(true)
                  }).pipe(Effect.provide(MemorySqlite.layer))

                  // Exercise BrowserSqlite.layerSqlite build failure paths (wasm fn rejecting & module rejecting)
                  const badWasm = yield* Effect.exit(
                    Layer.build(
                      BrowserSqlite.layerSqlite({
                        directory: "bad-wasm",
                        build: {
                          ...MemorySqlite.build,
                          wasm: () => Promise.reject(new Error("fetch-failed"))
                        }
                      })
                    )
                  )
                  expect(Exit.isFailure(badWasm)).toBe(true)

                  const badMod = yield* Effect.exit(
                    Layer.build(
                      BrowserSqlite.layerSqlite({
                        directory: "bad-mod",
                        build: {
                          ...MemorySqlite.build,
                          module: () => Promise.reject(new Error("mod-failed"))
                        }
                      })
                    )
                  )
                  expect(Exit.isFailure(badMod)).toBe(true)

                  // Exercise open_v2 failure & PRAGMA synchronous != 2 failure via custom Sqlite service
                  const failingPool: BrowserSqlite.Sqlite["Service"] = {
                    vfs: "mem",
                    exclusive: true,
                    sqlite3: {
                      open_v2: () => Promise.reject(new Error("open-failed"))
                    } as any
                  }
                  const openErr = yield* Effect.exit(
                    BrowserSqlite.open("x.db").pipe(
                      Effect.provide(Layer.succeed(BrowserSqlite.Sqlite)(failingPool))
                    )
                  )
                  expect(Exit.isFailure(openErr)).toBe(true)

                  const badSyncPool: BrowserSqlite.Sqlite["Service"] = {
                    vfs: "mem",
                    exclusive: true,
                    sqlite3: {
                      open_v2: () => Promise.resolve(1),
                      close: () => Promise.resolve(0),
                      statements: async function*() {
                        yield 1
                      },
                      step: async () => 101,
                      column_count: () => 1,
                      column: () => 0, // synchronous = 0 (not FULL=2)
                      reset: () => Promise.resolve(0),
                      finalize: () => Promise.resolve(0)
                    } as any
                  }
                  const syncErr = yield* Effect.exit(
                    BrowserSqlite.open("y.db").pipe(
                      Effect.provide(Layer.succeed(BrowserSqlite.Sqlite)(badSyncPool))
                    )
                  )
                  expect(Exit.isFailure(syncErr)).toBe(true)
                  return true
                }

                if (area === "wal-buffer-errors-and-oversized") {
                  const dir = mkdtempSync(join(tmpdir(), "wave10b-wal-"))
                  const handles = new Map<number, number>()
                  let throwWrite = false
                  try {
                    const host: WalVfs = {
                      jOpen: (_n, f) => {
                        handles.set(f, openSync(join(dir, String(f)), "w+"))
                        return SQLITE_OK
                      },
                      jWrite: (f, bytes, offset) => {
                        if (throwWrite) throw new Error("io-boom")
                        writeSync(handles.get(f)!, bytes, 0, bytes.length, offset)
                        return SQLITE_OK
                      },
                      jRead: (f, bytes, offset) => {
                        bytes.fill(0)
                        readSync(handles.get(f)!, bytes, 0, bytes.length, offset)
                        return SQLITE_OK
                      },
                      jSync: (f) => {
                        fsyncSync(handles.get(f)!)
                        return SQLITE_OK
                      },
                      jFileSize: (f, out) => {
                        out.setBigInt64(0, BigInt(fstatSync(handles.get(f)!).size), true)
                        return SQLITE_OK
                      },
                      jTruncate: (f, sz) => {
                        ftruncateSync(handles.get(f)!, sz)
                        return SQLITE_OK
                      },
                      jDelete: () => SQLITE_OK,
                      close: async () => {},
                      jClose: (f) => {
                        const fd = handles.get(f)
                        if (fd !== undefined) closeSync(fd)
                        handles.delete(f)
                        return SQLITE_OK
                      }
                    }
                    const vfs = bufferWalWrites(host)
                    // Non-WAL file write passes straight through
                    vfs.jOpen("main.db", 2, 0, new DataView(new ArrayBuffer(4)))
                    expect(vfs.jWrite(2, new Uint8Array([1, 2]), 0)).toBe(SQLITE_OK)
                    vfs.jClose(2)

                    // WAL file oversized write (> capacity 16) succeeding, then throwing
                    vfs.jOpen("main.db-wal", 1, SQLITE_OPEN_WAL, new DataView(new ArrayBuffer(4)))
                    expect(vfs.jWrite(1, new Uint8Array(70_000).fill(7), 0)).toBe(SQLITE_OK)
                    throwWrite = true
                    expect(vfs.jWrite(1, new Uint8Array(70_000).fill(8), 70_000)).toBe(SQLITE_IOERR)
                    // Sticky error on subsequent write and sync
                    expect(vfs.jWrite(1, new Uint8Array(4), 140_000)).toBe(SQLITE_IOERR)
                    expect(vfs.jSync(1, 0)).toBe(SQLITE_IOERR)
                    vfs.jClose(1)

                    // Buffered write that fails on drain when jSync triggers drain
                    throwWrite = false
                    vfs.jOpen("main2.db-wal", 3, SQLITE_OPEN_WAL, new DataView(new ArrayBuffer(4)))
                    expect(vfs.jWrite(3, new Uint8Array([1, 2, 3, 4]), 0)).toBe(SQLITE_OK)
                    throwWrite = true
                    expect(vfs.jSync(3, 0)).toBe(SQLITE_IOERR)
                    vfs.jClose(3)
                  } finally {
                    for (const fd of handles.values()) closeSync(fd)
                    rmSync(dir, { recursive: true, force: true })
                  }
                  return true
                }

                if (area === "child-process-rejections-and-sinks") {
                  const dir = mkdtempSync(join(tmpdir(), "wave10b-cps-"))
                  try {
                    const filePath = join(dir, "not-a-dir.txt")
                    writeFileSync(filePath, "hello")
                    const bash: BrowserChildProcessSpawner.JustBashLike = {
                      exec: async (cmd, opts) => {
                        if (cmd.includes("abort-throw")) {
                          return await new Promise((_res, rej) => {
                            opts?.signal?.addEventListener("abort", () => rej(new Error("aborted")))
                          })
                        }
                        return { stdout: "out\n", stderr: "err\n", exitCode: 0 }
                      }
                    }
                    const layer = BrowserChildProcessSpawner.layer(bash).pipe(
                      Layer.provide(BrowserFileSystem.layer(NodeFsPromises as unknown as BrowserFileSystem.ZenFsPromisesLike)),
                      Layer.provide(Path.layer)
                    )
                    const spawner = yield* ChildProcessSpawner.pipe(Effect.provide(layer))

                    // Rejected forms
                    const rejectedCmds = [
                      ChildProcess.make("echo", ["hi"], { cwd: filePath }),
                      ChildProcess.pipeTo(ChildProcess.make("echo", ["a"]), ChildProcess.make("cat")),
                      ChildProcess.make("cat", [], { stdin: Stream.empty }),
                      ChildProcess.make("cat", [], { stdin: { stream: Stream.empty } }),
                      ChildProcess.make("echo", [], { additionalFds: { fd3: { type: "input", stream: Stream.empty } } }),
                      ChildProcess.make("echo", [], { shell: "/bin/sh" }),
                      ChildProcess.make("echo", [], { detached: true }),
                      ChildProcess.make("echo", [], { forceKillAfter: Duration.millis(10) })
                    ]
                    for (const cmd of rejectedCmds) {
                      const err = yield* Effect.flip(spawner.spawn(cmd))
                      expect(err.reason._tag).toBe("BadArgument")
                    }

                    // Valid spawn with stdout: "ignore", stderr: "inherit", and Sink transducing + handle methods
                    const h1 = yield* spawner.spawn(ChildProcess.make("echo", ["hi"], { stdout: "ignore", stderr: "inherit" }))
                    expect(yield* Stream.runCollect(h1.stdout)).toEqual([])
                    expect(yield* Stream.runCollect(h1.stderr)).toEqual([])
                    expect(typeof (yield* h1.isRunning)).toBe("boolean")
                    expect(h1.getInputFd(3)).toBeDefined()
                    expect(h1.getOutputFd(3)).toBeDefined()
                    yield* (yield* h1.unref)

                    const h2 = yield* spawner.spawn(ChildProcess.make("echo", ["hi"], { stdout: Sink.drain as any }))
                    expect(yield* h2.exitCode).toBe(0)

                    // Stub rejecting on abort (Settled { ok: false })
                    const h3 = yield* spawner.spawn(ChildProcess.make("abort-throw"))
                    yield* h3.kill()
                  } finally {
                    rmSync(dir, { recursive: true, force: true })
                  }
                  return true
                }

                if (area === "filesystem-stream-readdir-realpath") {
                  // Minimal backend with NO lstat and NO realpath to hit unbounded depth & realPath refusal
                  const minimalBackend: BrowserFileSystem.ZenFsPromisesLike = {
                    open: async () => ({
                      read: async (buf) => ({ bytesRead: buf.length + 10 }), // misreported!
                      close: async () => {}
                    }),
                    readFile: async () => new Uint8Array(),
                    writeFile: async () => {},
                    mkdir: async () => {},
                    readdir: async () => ["sub"],
                    stat: async () => ({
                      size: 10,
                      mode: 0,
                      mtimeMs: 0,
                      isFile: () => false,
                      isDirectory: () => true,
                      isSymbolicLink: () => false
                    }),
                    rm: async () => {}
                  }
                  const fsSvc = BrowserFileSystem.make(minimalBackend)

                  // glob unsupported
                  expect((yield* Effect.flip(fsSvc.glob("*.ts"))).reason._tag).toBe("PermissionDenied")
                  // realPath without backend realpath
                  expect((yield* Effect.flip(fsSvc.realPath("/a"))).reason._tag).toBe("PermissionDenied")
                  // recursive readDirectory exceeds maximumDepth on unbounded backend
                  expect((yield* Effect.flip(fsSvc.readDirectory("/root", { recursive: true }))).reason._tag).toBe("BadResource")

                  // Cycle detection when realpath returns same canonical path
                  const cycleFs = BrowserFileSystem.make({
                    ...minimalBackend,
                    realpath: async () => "/same-canonical"
                  })
                  const cycEntries = yield* cycleFs.readDirectory("/root", { recursive: true })
                  expect(Array.isArray(cycEntries)).toBe(true)

                  // stream validation errors + bytesToRead: 0 + misreported bytesRead
                  const fileFs = BrowserFileSystem.make({
                    ...minimalBackend,
                    stat: async () => ({
                      size: 10,
                      mode: 0,
                      mtimeMs: 0,
                      isFile: () => true,
                      isDirectory: () => false,
                      isSymbolicLink: () => false
                    })
                  })
                  for (const opts of [
                    { offset: -1 },
                    { bytesToRead: -1 },
                    { chunkSize: 0 },
                    { chunkSize: 100_000_000 }
                  ] as const) {
                    expect((yield* Effect.flip(Stream.runCollect(fileFs.stream("/f", opts)))).reason._tag).toBe("BadArgument")
                  }
                  expect(yield* Stream.runCollect(fileFs.stream("/f", { bytesToRead: 0 }))).toEqual([])
                  expect((yield* Effect.flip(Stream.runCollect(fileFs.stream("/f", { chunkSize: 4 })))).reason._tag).toBe("BadResource")
                  return true
                }

                // area === "pending-snapshot-and-weblock"
                const map = new Map<string, string>()
                const snap = PendingSnapshot.make(
                  {
                    getItem: (k) => map.get(k) ?? null,
                    setItem: (k, v) => map.set(k, v),
                    removeItem: (k) => map.delete(k)
                  },
                  "k"
                )
                // JSON.stringify(undefined) === undefined -> returns undefined
                expect(snap.stage(undefined)).toBeUndefined()

                // WebLock: grant after abort (line 126) and rejection while not aborted (line 134)
                const abortLock = WebLock.make({
                  request: (_name, opts, cb) =>
                    new Promise((resolve) => {
                      setTimeout(() => {
                        void cb({ name: _name, mode: "exclusive" }).then(resolve)
                      }, 25)
                    })
                })
                const holdFiber = yield* Effect.forkChild(Effect.scoped(abortLock.hold("l1")))
                yield* Effect.sleep("5 millis")
                yield* Fiber.interrupt(holdFiber)
                yield* Effect.sleep("35 millis")

                const rejectLock = WebLock.make({
                  request: () => Promise.reject(new Error("locks-broken"))
                })
                const rejectExit = yield* Effect.exit(Effect.scoped(rejectLock.hold("l2")))
                expect(Exit.isFailure(rejectExit)).toBe(true)

                return true
              })
            ),
          { seed: seed + 4, executions: ioExec }
        )
      )
      assertPassed(report)
    },
    90_000
  )
})
