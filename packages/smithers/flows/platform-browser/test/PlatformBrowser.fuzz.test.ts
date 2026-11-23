import { SQLITE_IOERR, SQLITE_OK, SQLITE_OPEN_WAL } from "@journeyapps/wa-sqlite"
import { ImmutableCache } from "@smthrs/artifacts"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { TerminalProtocol } from "@smthrs/sandbox"
import { Arbitrary, Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, Queue, Schema, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Socket from "effect/socket/Socket"
import * as SqlClient from "effect/sql/SqlClient"
import * as nodeFs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type WebSocket as Peer, WebSocketServer } from "ws"
import {
  BrowserCache,
  BrowserChildProcessSpawner,
  BrowserFileSystem,
  BrowserHost,
  BrowserLanguageServer,
  BrowserScheduler,
  BrowserServices,
  PendingSnapshot,
  StoragePersistence,
  TabChannel,
  TerminalSocket
} from "../src/index.ts"
import * as Protocol from "../src/internal/Protocol.ts"
import * as SqlProtocol from "../src/internal/SqlProtocol.ts"
import * as Statements from "../src/internal/Statements.ts"
import * as TypeScriptWorkspace from "../src/internal/TypeScriptWorkspace.ts"
import { bufferWalWrites, type Vfs } from "../src/internal/WalBuffer.ts"
import * as Engines from "./fixtures/Engines.ts"
import { Steps } from "./fixtures/Flows.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"
import * as ZenFsMount from "./fixtures/ZenFsMount.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe("@smthrs/platform-browser fuzz invariants", () => {
  let tempRoot = ""

  beforeAll(() => {
    tempRoot = nodeFs.mkdtempSync(join(tmpdir(), "smthrs-pb-fuzz-"))
  })

  afterAll(() => {
    if (tempRoot !== "") {
      nodeFs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("BrowserFileSystem, BrowserChildProcessSpawner, BrowserServices, and BrowserHost over ZenFS + just-bash", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        dirName: Schema.Literals(["alpha", "beta", "sub/nested"]),
        fileName: Schema.Literals(["a.txt", "data.bin", "note-1.md"]),
        payload: Schema.Array(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 })))).pipe(
          Schema.check(Schema.isMaxLength(64))
        ),
        text: Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
        exitCode: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 })))
      })
    )

    const fsExecutions = Math.min(executions, 24)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const mount = yield* Effect.promise(() => ZenFsMount.mount())
            const servicesLayer = BrowserServices.layer({
              bash: mount.bash,
              fs: mount.fs.promises
            })
            const bytes = Uint8Array.from(input.payload)
            const safeText = decoder.decode(encoder.encode(input.text.replace(/[\0\r\n'\\$"`]/g, "x")))
            const dirPath = `/${input.dirName}`
            const filePath = `${dirPath}/${input.fileName}`

            const ok = yield* Effect.provide(
              Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                yield* fs.makeDirectory(dirPath, { recursive: true })
                yield* fs.writeFile(filePath, bytes)
                if (!(yield* fs.exists(filePath))) return false
                const readBack = yield* fs.readFile(filePath)
                if (readBack.length !== bytes.length) return false
                for (let i = 0; i < bytes.length; i++) {
                  if (readBack[i] !== bytes[i]) return false
                }
                const info = yield* fs.stat(filePath)
                if (info.type !== "File" || Number(info.size) !== bytes.length) return false

                const real = yield* fs.realPath(filePath)
                if (!real.endsWith(input.fileName)) return false

                const entries = yield* fs.readDirectory(dirPath)
                if (!entries.includes(input.fileName)) return false
                const recEntries = yield* fs.readDirectory("/", { recursive: true })
                if (recEntries.length === 0) return false

                const copyPath = `${dirPath}/copy.bin`
                const copyExit = yield* Effect.exit(fs.copyFile(filePath, copyPath))
                if (!Exit.isFailure(copyExit)) return false
                yield* fs.writeFile(copyPath, bytes)
                const renamedPath = `${dirPath}/renamed.bin`
                yield* fs.rename(copyPath, renamedPath)
                if (!(yield* fs.exists(renamedPath))) return false

                const truncExit = yield* Effect.exit(fs.truncate(renamedPath, 0))
                if (!Exit.isFailure(truncExit)) return false

                const streamed = yield* Stream.runCollect(fs.stream(filePath))
                const streamedLen = Array.from(streamed).reduce((a, c) => a + c.length, 0)
                if (streamedLen !== bytes.length) return false

                const missingExit = yield* Effect.exit(fs.readFile(`${dirPath}/missing-file`))
                if (!Exit.isFailure(missingExit)) return false

                yield* fs.remove(renamedPath)
                if (yield* fs.exists(renamedPath)) return false

                const spawner = yield* ChildProcessSpawner
                const cmdOut = yield* Effect.scoped(
                  Effect.gen(function*() {
                    const proc = yield* spawner.spawn(
                      ChildProcess.make("sh", ["-c", `printf '%s' '${safeText}'; exit ${input.exitCode}`])
                    )
                    const outChunks = yield* Stream.runCollect(proc.stdout)
                    const code = yield* proc.exitCode
                    const textOut = decoder.decode(
                      Uint8Array.from(Array.from(outChunks).flatMap((c) => Array.from(c)))
                    )
                    return { textOut, code }
                  })
                )
                if (cmdOut.textOut !== safeText || Number(cmdOut.code) !== input.exitCode) return false
                return true
              }),
              servicesLayer
            )
            if (!ok) return false

            const hostLayer = BrowserHost.layer({
              bash: mount.bash,
              fs: mount.fs.promises,
              jj: { fs: mount.fs, wasm: new Uint8Array(0) }
            })
            const hostOk = yield* Effect.provide(
              Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                return yield* fs.exists(filePath)
              }),
              hostLayer
            )
            void BrowserFileSystem.make
            void BrowserChildProcessSpawner.make
            return hostOk
          }),
        { seed, executions: fsExecutions }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("BrowserCache layer & readAsset handle hits, misses, quotas, and network/http/body failures", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "cache_rw",
          "too_large",
          "open_refused",
          "asset_cache_hit",
          "asset_network_hit",
          "asset_http_err",
          "asset_net_err",
          "asset_body_err"
        ]),
        ns: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
        part: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
        payload: Schema.Array(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 })))).pipe(
          Schema.check(Schema.isMaxLength(48))
        ),
        httpStatus: Schema.Literals([404, 500, 503])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const safeNs = "b" + input.ns.toLowerCase().replace(/[^a-z0-9-]/g, "a")
            const safePart = input.part.replace(/[^a-zA-Z0-9._-]/g, "p") || "x"
            const key = ImmutableCache.key(safeNs, safePart)
            const bytes = Uint8Array.from(input.payload)

            if (input.mode === "open_refused") {
              const caches: BrowserCache.CacheStorage = {
                open: async () => {
                  throw new Error("denied")
                }
              }
              const exit = yield* Effect.exit(
                Effect.provide(
                  Effect.flatMap(ImmutableCache.ImmutableCache, (c) => c.get(key)),
                  BrowserCache.layer({ caches })
                )
              )
              return Exit.isFailure(exit)
            }

            if (input.mode === "cache_rw" || input.mode === "too_large") {
              const backing = ImmutableCache.makeMemoryWebCache()
              const caches: BrowserCache.CacheStorage = { open: async () => backing }
              const layer = BrowserCache.layer({
                caches,
                name: "fuzz-cache",
                maxEntryBytes: input.mode === "too_large" ? 8 : 1024
              })
              return yield* Effect.provide(
                Effect.gen(function*() {
                  const cache = yield* ImmutableCache.ImmutableCache
                  const data = input.mode === "too_large" ? new Uint8Array(32) : bytes
                  const res = yield* cache.put(key, { bytes: data, metadata: {} })
                  const got = yield* cache.get(key)
                  if (input.mode === "too_large") {
                    return res === "too_large" && Option.isNone(got)
                  }
                  if (res !== "stored" || Option.isNone(got)) return false
                  return got.value.bytes.length === data.length
                }),
                layer
              )
            }

            const okResponse = (buf: Uint8Array): BrowserCache.AssetResponse => ({
              ok: true,
              status: 200,
              arrayBuffer: async () => new Uint8Array(buf).buffer
            })
            const assetLayer = Layer.succeed(BrowserCache.AssetSource, {
              match: () =>
                input.mode === "asset_cache_hit"
                  ? Effect.succeed(okResponse(bytes))
                  : Effect.succeed(undefined),
              fetch: () => {
                if (input.mode === "asset_net_err") return Effect.fail(new TypeError("offline"))
                if (input.mode === "asset_http_err") {
                  return Effect.succeed({
                    ok: false,
                    status: input.httpStatus,
                    arrayBuffer: async () => new ArrayBuffer(0)
                  })
                }
                if (input.mode === "asset_body_err") {
                  return Effect.succeed({
                    ok: true,
                    status: 200,
                    arrayBuffer: async () => {
                      throw new Error("corrupt body")
                    }
                  })
                }
                return Effect.succeed(okResponse(bytes))
              }
            })

            const exit = yield* Effect.exit(
              Effect.provide(BrowserCache.readAsset("https://example.invalid/a.wasm"), assetLayer)
            )
            if (input.mode === "asset_cache_hit" || input.mode === "asset_network_hit") {
              return Exit.isSuccess(exit) && exit.value.byteLength === bytes.length
            }
            if (!Exit.isFailure(exit)) return false
            const err = Cause.squash(exit.cause)
            if (!(err instanceof BrowserCache.AssetUnavailable)) return false
            if (input.mode === "asset_net_err") return err.phase === "network"
            if (input.mode === "asset_http_err") return err.phase === "http"
            return err.phase === "body"
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  })

  it("BrowserScheduler, StoragePersistence, and PendingSnapshot uphold ordering, persistence, and error-isolation invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nTasks: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
        cancelIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 7 }))),
        persistMode: Schema.Literals(["true", "false", "missing", "reject"]),
        snapA: Schema.String.pipe(Schema.check(Schema.isMaxLength(24))),
        snapB: Schema.String.pipe(Schema.check(Schema.isMaxLength(24))),
        storageThrows: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const ch = new MessageChannel()
            try {
              const dispatch = BrowserScheduler.immediate(
                ch as unknown as Parameters<typeof BrowserScheduler.immediate>[0]
              )
              const order: Array<number> = []
              const expected: Array<number> = []
              yield* Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    const cancelAt = input.cancelIdx % input.nTasks
                    for (let i = 0; i < input.nTasks; i++) {
                      const cancel = dispatch(() => order.push(i))
                      if (i === cancelAt && input.nTasks > 1) {
                        cancel()
                      } else {
                        expected.push(i)
                      }
                    }
                    dispatch(() => resolve())
                  })
              )
              if (order.length !== expected.length) return false
              for (let i = 0; i < expected.length; i++) {
                if (order[i] !== expected[i]) return false
              }
            } finally {
              ch.port1.close()
              ch.port2.close()
            }

            const sched = BrowserScheduler.make({ setImmediate: () => {} })
            if (sched === undefined) return false

            const sp = input.persistMode === "missing"
              ? StoragePersistence.make(undefined)
              : input.persistMode === "reject"
              ? StoragePersistence.make({ persist: () => Promise.reject(new Error("SecurityError")) })
              : StoragePersistence.make({ persist: () => Promise.resolve(input.persistMode === "true") })
            const granted = yield* sp.persist
            if (granted !== (input.persistMode === "true")) return false

            if (input.storageThrows) {
              const broken: PendingSnapshot.Storage = {
                getItem: () => {
                  throw new Error("quota")
                },
                setItem: () => {
                  throw new Error("quota")
                },
                removeItem: () => {
                  throw new Error("quota")
                }
              }
              const ps = PendingSnapshot.make(broken, "k")
              ps.stage({ v: input.snapA })
              if (ps.read() !== undefined) return false
              ps.acknowledge("any")
              ps.clear()
              return true
            }

            const map = new Map<string, string>()
            const memStorage: PendingSnapshot.Storage = {
              getItem: (k) => map.get(k) ?? null,
              setItem: (k, v) => void map.set(k, v),
              removeItem: (k) => void map.delete(k)
            }
            const ps1 = PendingSnapshot.make(memStorage, "tab-1")
            const tok1 = ps1.stage({ v: input.snapA })
            const tok2 = ps1.stage({ v: input.snapB })
            if (tok1 === undefined || tok2 === undefined || tok1 === tok2) return false
            ps1.acknowledge(tok1)
            const reloaded = PendingSnapshot.make(memStorage, "tab-1").read()
            if (reloaded === undefined || reloaded.token !== tok2) return false
            ps1.acknowledge(tok2)
            return PendingSnapshot.make(memStorage, "tab-1").read() === undefined
          }),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)
  })

  it("TabChannel delivers fan-out messages and ends overflowing subscribers without affecting healthy ones under FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        capacity: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 6 }))),
        burst: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 12 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const peers: Array<TabChannel.BroadcastChannelLike> = []
            const service = TabChannel.make(
              () => {
                const peer: TabChannel.BroadcastChannelLike = {
                  onmessage: null,
                  postMessage(msg) {
                    for (const other of peers) {
                      if (other !== peer && other.onmessage !== null) {
                        other.onmessage({ data: msg } as MessageEvent)
                      }
                    }
                  },
                  close() {
                    const idx = peers.indexOf(peer)
                    if (idx >= 0) peers.splice(idx, 1)
                  }
                }
                peers.push(peer)
                return peer
              },
              { capacity: input.capacity }
            )

            return yield* Effect.scoped(
              Effect.gen(function*() {
                const sender = yield* service.open("chan")
                const receiver = yield* service.open("chan")
                const slowSub = yield* receiver.subscribe
                const fastSub = yield* receiver.subscribe
                const fastReceived: Array<unknown> = []

                for (let i = 0; i < input.burst; i++) {
                  yield* sender.post({ seq: i })
                  fastReceived.push(yield* Queue.take(fastSub))
                }

                if (fastReceived.length !== input.burst) return false

                let drained = 0
                let overflowed = false
                for (let i = 0; i <= input.burst; i++) {
                  const exit = yield* Effect.exit(Queue.take(slowSub))
                  if (Exit.isSuccess(exit)) {
                    drained++
                    if (drained === input.burst) break
                  } else {
                    const err = Cause.squash(exit.cause)
                    if (err instanceof TabChannel.TabChannelOverflow) {
                      overflowed = true
                      break
                    }
                    return false
                  }
                }

                if (input.burst > input.capacity) {
                  return overflowed && drained <= input.capacity
                }
                return !overflowed && drained === input.burst
              })
            )
          }),
        { seed: seed + 3, executions, execution: FuzzSimulation.execution() }
      )
    )
    assertPassed(report)
  })

  it("Protocol, SqlProtocol, and Statements preserve codec roundtrips, byte fidelity, and VACUUM detection", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        execId: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(20))),
        reqId: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
        num: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -10000, maximum: 10000 }))),
        bytes: Schema.Array(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 })))).pipe(
          Schema.check(Schema.isMaxLength(24))
        ),
        text: Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
        sqlPrefix: Schema.Literals(["", "   ", "/* comment */ ", "-- line\n", "\t\n "]),
        sqlVerb: Schema.Literals(["VACUUM", "vacuum", "Vacuum main", "SELECT 1", "INSERT INTO t VALUES (1)", "VACUUM_NOT"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const safeText = decoder.decode(encoder.encode(input.text))
            const msgs: ReadonlyArray<Protocol.Message> = [
              { _tag: "Poll", client: input.reqId, id: 1, flow: "f", executionId: input.execId },
              { _tag: "Cancel", client: input.reqId, id: 2, flow: "f", executionId: input.execId },
              { _tag: "Signal", client: input.reqId, id: 3, flow: "f", executionId: input.execId, name: "ev", value: safeText },
              { _tag: "Replied", client: input.reqId, id: 4, result: { n: input.num } },
              { _tag: "Refused", client: input.reqId, id: 5, error: safeText },
              { _tag: "Leader" },
              { _tag: "RunChanged", executionId: input.execId, eventType: "StepCompleted" }
            ]
            for (const m of msgs) {
              const encoded = Protocol.encode(m)
              const decoded = Protocol.decode(encoded)
              if (decoded === undefined || decoded._tag !== m._tag) return false
            }
            if (Protocol.decode({ _tag: "NotReal" }) !== undefined) return false
            if (Protocol.decode(null) !== undefined) return false

            const sqlMsgs: ReadonlyArray<SqlProtocol.Message> = [
              { _tag: "Ready" },
              { _tag: "Failed", client: input.reqId, id: 1, error: "SqlError", message: safeText },
              { _tag: "Executed", client: input.reqId, id: 2, leader: "l1", rows: [], open: false }
            ]
            for (const sm of sqlMsgs) {
              const dec = SqlProtocol.decode(SqlProtocol.encode(sm))
              if (dec === undefined || dec._tag !== sm._tag) return false
            }
            if (SqlProtocol.decode({ bogus: 1 }) !== undefined) return false

            const bin = Uint8Array.from(input.bytes)
            const rows = [{ a: input.num, b: safeText, c: null, d: bin }]
            const decodedRows = SqlProtocol.decodeRows(SqlProtocol.encodeRows(rows)) as Array<Record<string, unknown>>
            if (decodedRows.length !== 1) return false
            const row0 = decodedRows[0]!
            if (row0.a !== input.num || row0.b !== safeText || row0.c !== null) return false
            if (!(row0.d instanceof Uint8Array) || row0.d.length !== bin.length) return false
            for (let i = 0; i < bin.length; i++) {
              if (row0.d[i] !== bin[i]) return false
            }

            const decodedResults = SqlProtocol.decodeResults(SqlProtocol.encodeResults([rows]))
            if (decodedResults.length !== 1 || decodedResults[0]!.length !== 1) return false

            const sql = `${input.sqlPrefix}${input.sqlVerb}`
            const isVac = Statements.isVacuum(sql)
            const expectedVac =
              input.sqlVerb === "VACUUM" || input.sqlVerb === "vacuum" || input.sqlVerb === "Vacuum main"
            if (isVac !== expectedVac) return false

            const err = Statements.failed(new Error(safeText), "query failed", "execute")
            return err._tag === "SqlError"
          }),
        { seed: seed + 4, executions }
      )
    )
    assertPassed(report)
  })

  it("TypeScriptWorkspace & BrowserLanguageServer serve symbols, hover, definition, and diagnostics over MessageChannel", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        lines: Schema.Array(
          Schema.String.pipe(Schema.check(Schema.isMaxLength(20)))
        ).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(6))),
        eol: Schema.Literals(["\n", "\r\n", "\r"]),
        offsetSeed: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
        rawPath: Schema.Literals(["a/b/../c.ts", "/./x//y.ts", "../../escape.ts", "src/main.ts"]),
        symName: Schema.Literals(["alpha", "beta", "gamma", "delta"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              const cleanLines = input.lines.map((l) => l.replace(/[\r\n]/g, "a"))
              const text = cleanLines.join(input.eol)
              const starts = TypeScriptWorkspace.lineStarts(text)
              if (starts.length !== cleanLines.length) return false

              let offset = text.length === 0 ? 0 : input.offsetSeed % (text.length + 1)
              if (offset > 0 && text[offset - 1] === "\r" && text[offset] === "\n") {
                offset--
              }
              const pos = TypeScriptWorkspace.positionAt(starts, offset)
              const back = TypeScriptWorkspace.offsetAt(text, starts, pos)
              if (back !== offset) return false

              const norm = TypeScriptWorkspace.normalize(input.rawPath)
              if (!norm.startsWith("/") || norm.includes("/../") || norm.includes("/./")) return false
              if (!TypeScriptWorkspace.uriOf(norm).startsWith("file://")) return false

              const files: Record<string, string> = {
                "src/lib.ts": `export const ${input.symName}: number = 42\n`,
                "src/main.ts": `import { ${input.symName} } from "./lib"\nexport const res = ${input.symName} + 1\n`
              }
              const channel = new MessageChannel()
              channel.port2.start()
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  channel.port1.close()
                  channel.port2.close()
                })
              )
              yield* Effect.forkScoped(
                BrowserLanguageServer.program({
                  typescript: ts,
                  lib: async () => undefined,
                  port: channel.port1 as unknown as BrowserLanguageServer.ServeOptions["port"] & object
                })
              )
              const lsp = yield* BrowserLanguageServer.make({
                worker: () => ({
                  postMessage: (m) => channel.port2.postMessage(m),
                  terminate: () => channel.port2.close(),
                  addEventListener: (type: "message" | "error", listener: (ev: never) => void) => {
                    if (type === "message") channel.port2.addEventListener("message", listener as never)
                  }
                }),
                workspace: {
                  paths: Object.keys(files),
                  read: (p) => Effect.succeed(files[p])
                }
              })
              const syms = yield* lsp.documentSymbols("/src/lib.ts")
              if (!Array.isArray(syms) || syms.length === 0) return false
              const hover = yield* lsp.hover({ path: "/src/main.ts", line: 1, character: 20 })
              void hover
              const defs = yield* lsp.definition({ path: "/src/main.ts", line: 1, character: 20 })
              const diags = yield* lsp.diagnostics("/src/main.ts")
              return Array.isArray(defs) && diags !== undefined && diags !== null
            })
          ),
        { seed: seed + 5, executions: Math.min(executions, 10) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("WalBuffer.bufferWalWrites matches unbuffered file semantics byte-for-byte across random write/read/sync/truncate ops", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        ops: Schema.Array(
          Schema.Struct({
            kind: Schema.Literals(["write", "read", "sync", "truncate"]),
            offset: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 256 }))),
            len: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 64 }))),
            fill: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 })))
          })
        ).pipe(Schema.check(Schema.isMinLength(2), Schema.isMaxLength(16))),
        injectIoErr: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const dir = nodeFs.mkdtempSync(join(tempRoot, "wal-"))
            const walPath = join(dir, "db.sqlite-wal")
            let fd: number | undefined
            try {
              const rawVfs: Vfs = {
                jOpen(_name, fileId, _flags, pOutFlags) {
                  fd = nodeFs.openSync(walPath, "w+")
                  pOutFlags.setInt32(0, 0, true)
                  void fileId
                  return SQLITE_OK
                },
                jClose() {
                  if (fd !== undefined) {
                    nodeFs.closeSync(fd)
                    fd = undefined
                  }
                  return SQLITE_OK
                },
                jRead(_fileId, pData, iOffset) {
                  if (fd === undefined) return SQLITE_IOERR
                  pData.fill(0)
                  nodeFs.readSync(fd, pData, 0, pData.byteLength, iOffset)
                  return SQLITE_OK
                },
                jWrite(_fileId, pData, iOffset) {
                  if (input.injectIoErr) return SQLITE_IOERR
                  if (fd === undefined) return SQLITE_IOERR
                  nodeFs.writeSync(fd, pData, 0, pData.byteLength, iOffset)
                  return SQLITE_OK
                },
                jTruncate(_fileId, iSize) {
                  if (fd === undefined) return SQLITE_IOERR
                  nodeFs.ftruncateSync(fd, iSize)
                  return SQLITE_OK
                },
                jSync() {
                  if (fd === undefined) return SQLITE_IOERR
                  nodeFs.fsyncSync(fd)
                  return SQLITE_OK
                },
                jDelete() {
                  return SQLITE_OK
                },
                async close() {},
                jFileSize(_fileId, pSize64) {
                  if (fd === undefined) return SQLITE_IOERR
                  const st = nodeFs.fstatSync(fd)
                  pSize64.setBigInt64(0, BigInt(st.size), true)
                  return SQLITE_OK
                }
              }

              const buffered = bufferWalWrites(rawVfs)
              const outFlags = new DataView(new ArrayBuffer(4))
              if (buffered.jOpen("db.sqlite-wal", 1, SQLITE_OPEN_WAL, outFlags) !== SQLITE_OK) return false

              let ref = new Uint8Array(0)
              let sawError = false
              let hadWrite = false

              for (const op of input.ops) {
                if (op.kind === "write") {
                  hadWrite = true
                  const chunk = new Uint8Array(op.len).fill(op.fill)
                  const rc = buffered.jWrite(1, chunk, op.offset)
                  if (rc !== SQLITE_OK) {
                    sawError = true
                    break
                  }
                  const needed = op.offset + op.len
                  if (needed > ref.length) {
                    const grown = new Uint8Array(needed)
                    grown.set(ref)
                    ref = grown
                  }
                  ref.set(chunk, op.offset)
                } else if (op.kind === "read") {
                  const buf = new Uint8Array(op.len)
                  const rc = buffered.jRead(1, buf, op.offset)
                  if (rc !== SQLITE_OK) {
                    sawError = true
                    break
                  }
                  for (let i = 0; i < op.len; i++) {
                    const expectedByte = op.offset + i < ref.length ? ref[op.offset + i]! : 0
                    if (buf[i] !== expectedByte) return false
                  }
                } else if (op.kind === "sync") {
                  const rc = buffered.jSync(1, 0)
                  if (rc !== SQLITE_OK) {
                    sawError = true
                    break
                  }
                } else {
                  const rc = buffered.jTruncate(1, op.offset)
                  if (rc !== SQLITE_OK) {
                    sawError = true
                    break
                  }
                  if (op.offset < ref.length) {
                    ref = ref.slice(0, op.offset)
                  } else if (op.offset > ref.length) {
                    const grown = new Uint8Array(op.offset)
                    grown.set(ref)
                    ref = grown
                  }
                }
              }

              const syncRc = buffered.jSync(1, 0)
              const closeRc = buffered.jClose(1)
              if (input.injectIoErr) {
                return !hadWrite || sawError || syncRc !== SQLITE_OK || closeRc !== SQLITE_OK
              }
              if (sawError || syncRc !== SQLITE_OK || closeRc !== SQLITE_OK) return false
              const onDisk = nodeFs.readFileSync(walPath)
              if (onDisk.length !== ref.length) return false
              for (let i = 0; i < ref.length; i++) {
                if (onDisk[i] !== ref[i]) return false
              }
              return true
            } finally {
              if (fd !== undefined) {
                try {
                  nodeFs.closeSync(fd)
                } catch {}
              }
              nodeFs.rmSync(dir, { recursive: true, force: true })
            }
          }),
        { seed: seed + 6, executions }
      )
    )
    assertPassed(report)
  })

  it("BrowserSqlite, SharedSqlite, BrowserEngine, and BrowserRuntime execute transactions & durable flows over wa-sqlite", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        vals: Schema.Array(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 500 })))).pipe(
          Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4))
        ),
        rollbackLast: Schema.Boolean
      })
    )

    const sqliteExecutions = Math.min(executions, 6)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              // 1. Direct BrowserSqlite via MemorySqlite.open
              const db = yield* MemorySqlite.open
              yield* Effect.provide(
                Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  yield* sql`CREATE TABLE t (v INTEGER NOT NULL)`
                  for (let i = 0; i < input.vals.length; i++) {
                    const v = input.vals[i]!
                    if (input.rollbackLast && i === input.vals.length - 1) {
                      yield* Effect.exit(
                        sql.withTransaction(Effect.andThen(sql`INSERT INTO t (v) VALUES (${v})`, Effect.fail("abort")))
                      )
                    } else {
                      yield* sql.withTransaction(sql`INSERT INTO t (v) VALUES (${v})`)
                    }
                  }
                  const rows = yield* sql<{ readonly v: number }>`SELECT v FROM t ORDER BY rowid`
                  const expectedLen = input.rollbackLast ? input.vals.length - 1 : input.vals.length
                  if (rows.length !== expectedLen) {
                    return yield* Effect.fail("row-mismatch")
                  }
                }),
                MemorySqlite.over(db)
              )

              // 2. End-to-end BrowserRuntime leader + BrowserEngine tab + SharedSqlite tab
              const name = Engines.name()
              const engineDb = yield* MemorySqlite.open
              const pool = yield* MemorySqlite.pool
              yield* Engines.leader(name, Engines.engineWithApp(name, engineDb, Engines.steps(), pool))
              const tab = yield* Engines.tab(name)
              const sharedTab = yield* Engines.sharedTab(name)
              yield* sharedTab.execute("CREATE TABLE items (n INTEGER NOT NULL)")
              yield* sharedTab.execute("INSERT INTO items (n) VALUES (?)", [input.vals[0]!])
              const sharedRows = yield* sharedTab.execute("SELECT n FROM items")
              if (sharedRows.length !== 1) return false

              const execId = `pb-exec-${input.vals[0]}`
              yield* tab.start(Steps, { executionId: execId, payload: { prefix: "fuzz" } })
              const inspected = yield* tab.inspect(execId)
              return inspected !== null
            })
          ),
        { seed: seed + 7, executions: sqliteExecutions }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("TerminalSocket bridges binary/resize/control frames over loopback WebSocket and terminates cleanly on final close", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        access: Schema.Literals(["write", "read"]),
        payload: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
        cols: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 20, maximum: 200 }))),
        rows: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 5, maximum: 60 })))
      })
    )

    const wsExecutions = Math.min(executions, 8)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              const safePayload = decoder.decode(encoder.encode(input.payload))
              const peers = yield* Queue.unbounded<{
                readonly peer: Peer
                readonly frames: Queue.Queue<{ readonly binary: boolean; readonly text: string }, Cause.Done>
              }>()
              const server = yield* Effect.acquireRelease(
                Effect.callback<WebSocketServer>((resume) => {
                  const s = new WebSocketServer({ host: "127.0.0.1", port: 0 })
                  s.on("listening", () => resume(Effect.succeed(s)))
                }),
                (s) =>
                  Effect.callback<void>((resume) => {
                    for (const c of s.clients) c.terminate()
                    s.close(() => resume(Effect.void))
                  })
              )
              server.on("connection", (peer) => {
                const frames = Effect.runSync(
                  Queue.unbounded<{ readonly binary: boolean; readonly text: string }, Cause.Done>()
                )
                peer.on("message", (data, binary) => {
                  Queue.offerUnsafe(frames, { binary, text: Buffer.from(data as Buffer).toString("utf8") })
                })
                peer.on("close", () => Queue.endUnsafe(frames))
                Queue.offerUnsafe(peers, { peer, frames })
              })
              const { port } = server.address() as { readonly port: number }
              const url = `ws://127.0.0.1:${port}/terminal`

              const gotOut = yield* Deferred.make<Uint8Array>()
              const conn = yield* TerminalSocket.connect(url, {
                onOutput: (bytes) => {
                  Deferred.doneUnsafe(gotOut, Exit.succeed(bytes))
                }
              }).pipe(Effect.provide(TerminalSocket.layerWebSocket))
              const { frames, peer } = yield* Queue.take(peers)

              // Wait until ready status is reached
              const readyFiber = yield* conn.status.pipe(
                Stream.filter((st) => st._tag === "Open"),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkChild
              )
              peer.send(TerminalProtocol.encodeServerControl({ type: "ready", access: input.access }))
              yield* Fiber.join(readyFiber)

              // Client sends binary input + resize (dropped when read-only, forwarded when write)
              yield* conn.send(encoder.encode(safePayload))
              yield* conn.resize(input.cols, input.rows)

              if (input.access === "write") {
                const f1 = yield* Queue.take(frames)
                const f2 = yield* Queue.take(frames)
                if (!f1.binary || f1.text !== safePayload) return false
                const rDec = TerminalProtocol.decodeClientControl(f2.text)
                if (rDec?.type !== "resize" || rDec.cols !== input.cols || rDec.rows !== input.rows) return false
              }

              // Server sends output bytes -> client receives them
              peer.send(Buffer.from(safePayload, "utf8"))
              const outBytes = yield* Deferred.await(gotOut)
              if (decoder.decode(outBytes) !== safePayload) return false

              // Server sends ended + close 1000
              peer.send(TerminalProtocol.encodeServerControl({ type: "ended", reason: "closed" }))
              peer.close(TerminalProtocol.CloseCode.ended)
              void Deferred
              void Socket
              return true
            })
          ),
        { seed: seed + 8, executions: wsExecutions }
      )
    )
    assertPassed(report)
  }, 60_000)
})
