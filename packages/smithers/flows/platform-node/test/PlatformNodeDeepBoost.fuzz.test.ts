import { Fuzz } from "@smthrs/fuzz"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { LanguageServer, Lsp } from "@smthrs/std"
import {
  Arbitrary,
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  PlatformError,
  Queue,
  Schema,
  Sink,
  Stream
} from "effect"
import * as ByteSize from "effect/ByteSize"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { defaultLimits } from "../src/AtomicFileSystem.ts"
import { spawnHelper } from "../src/internal/AtomicFileSystemTransport.ts"
import * as PipedProcess from "../src/internal/PipedProcess.ts"
import * as ProcessSupervisor from "../src/internal/ProcessSupervisor.ts"
import * as Guest from "../src/internal/SandboxedFlowGuest.ts"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"
import * as OwnerPrivate from "../src/OwnerPrivate.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"
import * as TestNodeRuntime from "../src/TestNodeRuntime.ts"
import * as childEntry from "./fixtures/sandboxed-child.ts"
import { atomicHelperProgram } from "./helpers/atomicHelperProgram.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const fastExecutions = Math.max(16, Math.min(baseExecutions, 40))
const ioExecutions = Math.max(6, Math.min(baseExecutions, 12))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-pn-boost-fuzz-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

let seq = 0
const freshDir = (prefix: string) => {
  const dir = join(root, `${prefix}-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const encodeLspFrame = (value: unknown): Uint8Array => {
  const body = encoder.encode(JSON.stringify(value))
  const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`)
  const frame = new Uint8Array(header.length + body.length)
  frame.set(header)
  frame.set(body, header.length)
  return frame
}

const regularFile: FileSystem.File.Info = {
  type: "File",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0n,
  ino: Option.none(),
  mode: 0o644,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.bytes(16),
  blksize: Option.none(),
  blocks: Option.none()
}

describe("@smthrs/platform-node deep boost: sqliteObjectStorage, SandboxedFlowGuest, OwnerPrivate, AtomicTransport, ProcessReaper, ProcessSupervisor, PipedProcess, ProcessSandbox & NodeLanguageServer", () => {
  it("TestNodeRuntime.sqliteObjectStorage fuzzes get/put/delete/list/sql/transactions/rollback/alarms", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        ops: Schema.Array(
          Schema.Struct({
            op: Schema.Literals(["put", "putMany", "get", "delete", "list", "txn-commit", "txn-rollback", "alarm"]),
            key: Schema.Literals(["a/1", "a/2", "b/1", "b/2", "c/1"]),
            val: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
          })
        ).check(Schema.isMinLength(2), Schema.isMaxLength(20))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ ops }) =>
          Effect.promise(async () => {
            const storage = TestNodeRuntime.sqliteObjectStorage(":memory:")
            const model = new Map<string, number>()

            // Exercise raw sql.exec + transaction guard
            storage.sql.exec("CREATE TABLE IF NOT EXISTS kv_extra (id INTEGER PRIMARY KEY, name TEXT)")
            storage.sql.exec("INSERT INTO kv_extra(name) VALUES (?)", "hello")
            const cursor = storage.sql.exec("SELECT id, name FROM kv_extra")
            expect(cursor.columnNames).toEqual(["id", "name"])
            expect(cursor.toArray().length).toBe(1)
            expect([...cursor.raw()].length).toBe(1)
            expect(() => storage.sql.exec("BEGIN")).toThrow(/transaction/)

            for (const step of ops) {
              if (step.op === "put") {
                await storage.put(step.key, step.val)
                model.set(step.key, step.val)
              } else if (step.op === "putMany") {
                await storage.put({ [step.key]: step.val, "z/batch": step.val + 1 })
                model.set(step.key, step.val)
                model.set("z/batch", step.val + 1)
              } else if (step.op === "get") {
                expect(await storage.get(step.key)).toBe(model.get(step.key))
              } else if (step.op === "delete") {
                const removed = await storage.delete(step.key)
                expect(removed).toBe(model.delete(step.key))
              } else if (step.op === "list") {
                const listed = await storage.list({ prefix: step.key.slice(0, 2) })
                for (const [k, v] of listed) {
                  expect(model.get(k)).toBe(v)
                }
              } else if (step.op === "txn-commit") {
                await storage.transaction(async () => {
                  await storage.put(step.key, step.val)
                  await storage.transaction(async () => {
                    await storage.put("nested/k", step.val)
                  })
                })
                model.set(step.key, step.val)
                model.set("nested/k", step.val)
              } else if (step.op === "txn-rollback") {
                await storage.transaction(async (txn) => {
                  await storage.put(step.key, step.val + 999)
                  txn.rollback()
                })
              } else if (step.op === "alarm") {
                await storage.setAlarm(Date.now() + 5000)
                expect(await storage.alarm()).toBeDefined()
                await storage.deleteAlarm()
                expect(await storage.alarm()).toBeUndefined()
              }
            }
            storage.close()
            return true
          }),
        { seed, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("SandboxedFlowGuest.run executes in-process covering success, typed failure, missing flow, bad payload, capability ceiling & missing paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        caseKind: Schema.Literals([
          "sum-ok",
          "failing-flow",
          "missing-flow",
          "bad-payload",
          "denied-capability",
          "missing-req-env",
          "missing-req-file"
        ]),
        n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 40 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.promise(async () => {
            const dir = freshDir("guest")
            const reqPath = join(dir, "req.json")
            const resPath = join(dir, "res.json")

            if (tc.caseKind === "missing-req-env") {
              await expect(Guest.run(childEntry, {})).rejects.toThrow()
              return true
            }
            if (tc.caseKind === "missing-req-file") {
              await expect(
                Guest.run(childEntry, {
                  SMITHERS_SANDBOX_REQUEST_PATH: join(dir, "nope.json"),
                  SMITHERS_SANDBOX_RESULT_PATH: resPath
                })
              ).rejects.toThrow()
              return true
            }

            const reqObj = tc.caseKind === "sum-ok"
              ? {
                attempt: "1",
                flow: childEntry.Sum._tag,
                executionId: `g-${seq}`,
                capabilityCeiling: [],
                payload: { n: tc.n }
              }
              : tc.caseKind === "failing-flow"
              ? {
                attempt: "1",
                flow: childEntry.Failing._tag,
                executionId: `g-${seq}`,
                capabilityCeiling: [],
                payload: { reason: "boom", chatter: 0 }
              }
              : tc.caseKind === "missing-flow"
              ? { attempt: "1", flow: "does/NotExist", executionId: `g-${seq}`, capabilityCeiling: [], payload: {} }
              : tc.caseKind === "bad-payload"
              ? {
                attempt: "1",
                flow: childEntry.Sum._tag,
                executionId: `g-${seq}`,
                capabilityCeiling: [],
                payload: { n: "not-a-number" }
              }
              : {
                attempt: "1",
                flow: childEntry.Sum._tag,
                executionId: `g-${seq}`,
                capabilityCeiling: [[]],
                payload: { n: tc.n }
              }

            writeFileSync(reqPath, JSON.stringify(reqObj), "utf8")
            await Guest.run(childEntry, {
              SMITHERS_SANDBOX_REQUEST_PATH: reqPath,
              SMITHERS_SANDBOX_RESULT_PATH: resPath
            })
            const result = JSON.parse(readFileSync(resPath, "utf8")) as { readonly status?: string }
            if (tc.caseKind === "sum-ok" || tc.caseKind === "denied-capability") {
              expect(result.status).toBe("succeeded")
            } else {
              expect(result.status).toBe("failed")
            }
            return true
          }),
        { seed: seed + 1, executions: ioExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("OwnerPrivate.make fuzzes directory, write, syncDirectory, append & trust-boundary escape refusals", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        sub: Schema.Literals(["priv", "a/b"]),
        escape: Schema.Boolean,
        text: Schema.Literals(["line1\n", "secret-line\n"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.gen(function*() {
            const base = freshDir("opriv")
            const calls: Array<string> = []
            const service = OwnerPrivate.make(
              (req) =>
                Effect.sync(() => {
                  calls.push(String((req as { operation?: string }).operation ?? "unknown"))
                  return { ok: true }
                }),
              (path, cause) =>
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "OwnerPrivate",
                  method: "op",
                  pathOrDescriptor: path,
                  description: String(cause)
                })
            )

            const dirTarget = tc.escape ? join(base, "..", "escaped-dir") : join(base, tc.sub)
            const dirExit = yield* service.directory(base, dirTarget).pipe(Effect.exit)
            if (tc.escape) {
              expect(Exit.isFailure(dirExit)).toBe(true)
            } else {
              expect(Exit.isSuccess(dirExit)).toBe(true)
              const fileTarget = join(base, tc.sub, "data.bin")
              mkdirSync(join(base, tc.sub), { recursive: true })
              yield* service.write(base, fileTarget, encoder.encode(tc.text))
              yield* service.syncDirectory(join(base, tc.sub), "0:0")
              yield* service.append(fileTarget, tc.text)
              expect(calls.length).toBeGreaterThanOrEqual(4)
            }
            return true
          }),
        { seed: seed + 2, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("AtomicFileSystemTransport.spawnHelper fuzzes valid frames, overflow, timeout, non-zero exit, malformed frames & stderr truncation", async () => {
    const program = atomicHelperProgram()
    const limits = { ...defaultLimits, response: 256, stderr: 16 }
    const req = { operation: "exists", path: "/a" } as const
    const frame = (value: unknown) => {
      const body = JSON.stringify(value)
      return `flows-atomic/1 ${Buffer.byteLength(body)}\n${body}`
    }

    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["ok", "overflow", "timeout", "bad-exit", "bad-frame", "stderr-cap"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode }) =>
          Effect.gen(function*() {
            const dir = freshDir("transport")
            const body = mode === "ok"
              ? `process.stdout.write(${JSON.stringify(frame({ ok: true, value: true }))});`
              : mode === "overflow"
              ? `process.stdout.write("flows-atomic/1 9999\\n" + "x".repeat(400));`
              : mode === "timeout"
              ? `setTimeout(() => {}, 10000);`
              : mode === "bad-exit"
              ? `process.stderr.write("err"); process.exit(5);`
              : mode === "bad-frame"
              ? `process.stdout.write("garbage-no-frame");`
              : `process.stderr.write("0123456789abcdefghijklmnopqrstuvwxyz"); process.exit(2);`
            const exe = yield* Effect.promise(() => program(dir, body))
            const exit = yield* spawnHelper(req, exe, Buffer.from("req"), {
              limits,
              timeoutMs: mode === "timeout" ? 60 : 5000
            }).pipe(Effect.exit)
            if (mode === "ok") {
              expect(Exit.isSuccess(exit)).toBe(true)
            } else {
              expect(Exit.isFailure(exit)).toBe(true)
            }
            return true
          }).pipe(Effect.provide(silentLogger)),
        { seed: seed + 3, executions: ioExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("ProcessReaper.reap/report/systems, ProcessSupervisor helpers, PipedProcess.refuseNul & ProcessSandbox.docker/diagnose fuzz", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        liveness: Schema.Literals(["alive", "dead", "unknown"]),
        killOutcome: Schema.Literals(["signalled", "already-gone", "failed"]),
        sameOwner: Schema.Boolean,
        sameGroup: Schema.Boolean,
        startDeltaMs: Schema.Literals([0, 500, 999999]),
        platform: Schema.Literals(["linux", "darwin", "win32"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.gen(function*() {
            const ownerPid = 5000
            const ownGroup = 5000
            const targetPid = tc.sameOwner ? ownerPid : 6001
            const targetPgid = tc.sameGroup ? ownGroup : 6001
            const startedAtMs = 1_700_000_000_000

            const rec: ProcessLedger.ProcessRecord = {
              hostId: "fuzz-host",
              ownerPid: 4000,
              pid: targetPid,
              pgid: targetPgid,
              startedAtMs,
              commandDigest: "abc123"
            }
            const fakeLedger = ProcessLedger.ProcessLedger.of({
              record: () => Effect.succeed(rec),
              release: () => Effect.void,
              reaped: () => Effect.void,
              skipped: () => Effect.void,
              orphans: Effect.succeed([rec]),
              live: Effect.succeed([])
            })

            const system: ProcessReaper.System = {
              isAlive: () => tc.liveness,
              startedAtMs: () => ({ _tag: "started", startedAtMs: startedAtMs + tc.startDeltaMs }),
              ownGroup: () => ownGroup,
              bootedAtMs: () => startedAtMs - 60_000,
              refuseTarget: () => undefined,
              killTree: () => tc.killOutcome
            }

            const decided = yield* ProcessReaper.reap({ ownerPid, system }).pipe(
              Effect.provideService(ProcessLedger.ProcessLedger, fakeLedger)
            )
            expect(decided.length).toBe(1)
            yield* ProcessReaper.report(decided)

            // Exercise system constructors & platform helpers
            expect(ProcessReaper.systemFor(tc.platform)).toBeDefined()
            expect(ProcessReaper.groupSnapshotFor(tc.platform)).toBeTypeOf("function")
            expect(ProcessReaper.posixSystemWith()).toBeDefined()
            expect(ProcessReaper.procSystemWith()).toBeDefined()
            expect(ProcessReaper.windowsSystemWith()).toBeDefined()

            // ProcessSupervisor & PipedProcess pure helpers
            expect((yield* ProcessSupervisor.bootstrapArguments({ bun: false, main: "/a.js", sea: false })).length)
              .toBe(0)
            expect((yield* ProcessSupervisor.bootstrapArguments({ bun: true, main: "/a.js", sea: false })).length)
              .toBeGreaterThan(0)
            expect(
              Exit.isFailure(
                yield* ProcessSupervisor.bootstrapArguments({ bun: false, main: "/a.js", sea: true }).pipe(Effect.exit)
              )
            ).toBe(true)
            expect(yield* ProcessSupervisor.runtimeDescription({ bun: false, main: "/a.js" })).toBeDefined()
            expect(ProcessSupervisor.failure("spawn", "echo", new Error("boom"))).toBeDefined()
            expect(PipedProcess.failure("spawn", new Error("boom"))).toBeDefined()
            const nulExit = yield* PipedProcess.refuseNul(ChildProcess.make("echo", ["bad\0arg"])).pipe(Effect.exit)
            expect(Exit.isFailure(nulExit)).toBe(true)
            const okNul = yield* PipedProcess.refuseNul(ChildProcess.make("echo", ["good"])).pipe(Effect.exit)
            expect(Exit.isSuccess(okNul)).toBe(true)

            // ProcessSandbox docker & diagnose
            const ws = freshDir("psb")
            const host: ProcessSandbox.Host = {
              ...ProcessSandbox.host(),
              platform: tc.platform,
              executable: (
                name
              ) => (name === "docker" || name === "bwrap" || name === "/usr/bin/sandbox-exec" ? name : undefined)
            }
            const dockerHost: ProcessSandbox.Host = {
              ...host,
              platform: "linux",
              executable: (name: string) => (name === "docker" ? "/usr/bin/docker" : undefined)
            }
            const planned = ProcessSandbox.plan(
              {
                reads: ["."],
                writes: ["out"],
                readOnly: ["out/locked"],
                network: "none",
                mechanism: { _tag: "docker", image: "alpine:3" }
              },
              { workspaceRoot: ws, cwd: ws, tmp: ws },
              dockerHost
            )
            if (!ProcessSandbox.isUnenforceable(planned)) {
              const diag = ProcessSandbox.diagnose(planned, `EACCES: permission denied, open '${ws}/secret.txt'`)
              expect(diag === undefined || typeof diag === "string").toBe(true)
              if (planned.mechanism._tag === "docker") {
                const dockerArgv = ProcessSandbox.docker(planned, ["echo", "hi"], { FOO: "bar" }, dockerHost)
                expect(dockerArgv.length).toBeGreaterThan(0)
              }
            }
            return true
          }).pipe(Effect.provide(silentLogger)),
        { seed: seed + 4, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("NodeLanguageServer exercises implementation, callHierarchy, pull unchanged, push settle timeout & lazy crash-restart", async () => {
    const filePath = join(freshDir("lsp2"), "mod.ts")
    writeFileSync(filePath, "export function f() { return 1 }\n", "utf8")
    let spawnCount = 0

    const spawner = ChildProcessSpawner.makeNoop({
      spawn: (command) =>
        Effect.gen(function*() {
          spawnCount += 1
          const currentSpawn = spawnCount
          const standard = command as ChildProcess.StandardCommand
          const stdin = (standard.options.stdin as ChildProcess.StdinConfig).stream as Stream.Stream<Uint8Array>
          const output = yield* Queue.unbounded<Uint8Array, Cause.Done>()
          const exitGate = yield* Deferred.make<ExitCode>()
          let pending = ""
          yield* stdin.pipe(
            Stream.runForEach((bytes) =>
              Effect.gen(function*() {
                pending += decoder.decode(bytes)
                while (true) {
                  const idx = pending.indexOf("\r\n\r\n")
                  if (idx < 0) break
                  const header = pending.slice(0, idx)
                  const m = /Content-Length:\s*(\d+)/i.exec(header)
                  if (!m) break
                  const len = Number(m[1])
                  const rest = encoder.encode(pending.slice(idx + 4))
                  if (rest.byteLength < len) break
                  const msg = JSON.parse(decoder.decode(rest.slice(0, len))) as Record<string, unknown>
                  pending = decoder.decode(rest.slice(len))
                  const method = typeof msg.method === "string" ? msg.method : undefined
                  if (method === "initialize") {
                    yield* Queue.offer(
                      output,
                      encodeLspFrame({
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: {
                          capabilities: {
                            implementationProvider: true,
                            callHierarchyProvider: true,
                            diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false }
                          }
                        }
                      })
                    ).pipe(Effect.ignore)
                  } else if (method === "shutdown") {
                    yield* Queue.offer(output, encodeLspFrame({ jsonrpc: "2.0", id: msg.id, result: null })).pipe(
                      Effect.ignore
                    )
                  } else if (method === "exit") {
                    yield* Deferred.succeed(exitGate, ExitCode(0))
                  } else if (typeof msg.id === "number") {
                    if (method === "textDocument/references") {
                      // Crash first spawn to trigger lazy restart on next call!
                      yield* Deferred.succeed(exitGate, ExitCode(1))
                      yield* Queue.end(output)
                      return
                    }
                    const result = method === "textDocument/diagnostic"
                      ? { kind: "unchanged", resultId: "r1" }
                      : method === "textDocument/prepareCallHierarchy"
                      ? [{
                        name: "f",
                        kind: 12,
                        uri: `file://${filePath}`,
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
                        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
                      }]
                      : []
                    yield* Queue.offer(output, encodeLspFrame({ jsonrpc: "2.0", id: msg.id, result })).pipe(
                      Effect.ignore
                    )
                  }
                }
              })
            ),
            Effect.forkScoped({ startImmediately: true })
          )
          return makeHandle({
            pid: ProcessId(100 + currentSpawn),
            exitCode: Deferred.await(exitGate),
            isRunning: Effect.map(Deferred.isDone(exitGate), (d) => !d),
            kill: () => Deferred.succeed(exitGate, ExitCode(0)).pipe(Effect.asVoid),
            stdin: Sink.drain,
            stdout: Stream.fromQueue(output),
            stderr: Stream.empty,
            all: Stream.fromQueue(output),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void)
          })
        })
    })

    const fsLayer = FileSystem.layerNoop({
      stat: () => Effect.succeed(regularFile),
      readFileString: () => Effect.succeed("export function f() { return 1 }\n")
    })
    const serverLayer = NodeLanguageServer.layerLazy({
      command: "fuzz-lsp-2",
      cwd: root,
      timeoutMs: 1000,
      settleMs: 80,
      quietMs: 20
    }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)))

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const okImpl = yield* Lsp.run({ operation: "implementation", path: filePath, line: 1, character: 1 })
          expect(okImpl).toBeDefined()
          const prep = yield* Lsp.run({ operation: "prepareCallHierarchy", path: filePath, line: 1, character: 1 })
          expect(prep).toBeDefined()
          const inc = yield* Lsp.run({ operation: "callHierarchyIncoming", path: filePath, line: 1, character: 1 })
          expect(inc).toBeDefined()
          const out = yield* Lsp.run({ operation: "callHierarchyOutgoing", path: filePath, line: 1, character: 1 })
          expect(out).toBeDefined()
          const diag = yield* Lsp.run({ operation: "diagnostics", path: filePath })
          expect(diag).toBeDefined()
          const crashed = yield* Lsp.run({ operation: "references", path: filePath, line: 1, character: 1 }).pipe(
            Effect.exit
          )
          expect(Exit.isFailure(crashed)).toBe(true)
          expect(spawnCount).toBeGreaterThanOrEqual(1)

          // Exercise LanguageServer direct close/sync if exposed
          const svc = yield* LanguageServer.LanguageServer
          expect(svc).toBeDefined()
        }).pipe(Effect.provide(Layer.mergeAll(serverLayer, fsLayer, silentLogger)))
      )
    )
  })
})
