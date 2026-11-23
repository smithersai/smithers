import { ImmutableCache } from "@smthrs/artifacts"
import * as Dialect from "@smthrs/database/Dialect"
import { OwnerIdentity } from "@smthrs/engine-store"
import { Flow } from "@smthrs/flow"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import * as Jj from "@smthrs/jj"
import { Node } from "@smthrs/plan"
import { TerminalProtocol } from "@smthrs/sandbox"
import { Arbitrary, Cause, Clock, Effect, Exit, Fiber, Layer, Metric, Option, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as SqlClient from "effect/sql/SqlClient"
import * as Stream from "effect/Stream"
import * as nodeFs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  CloudflareHost,
  CloudflareRuntime,
  ContainerSession,
  ContainerTerminal,
  EdgeCache,
  ExecutionObject,
  ObjectDatabase,
  SandboxObject
} from "../src/index.ts"
import * as FailureDetail from "../src/internal/FailureDetail.ts"
import * as Observed from "../src/internal/Observed.ts"
import * as AnswerFlow from "./fixtures/AnswerFlow.ts"
import * as MemoryContainer from "./fixtures/MemoryContainer.ts"
import * as MemoryStorage from "./fixtures/MemoryStorage.ts"
import * as ProcessContainer from "./fixtures/ProcessContainer.ts"
import * as SqliteStorage from "./fixtures/SqliteStorage.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const encoder = new TextEncoder()

describe("@smthrs/platform-cloudflare fuzz invariants", () => {
  let tempRoot = ""

  beforeAll(() => {
    tempRoot = nodeFs.mkdtempSync(join(tmpdir(), "smthrs-cf-fuzz-"))
  })

  afterAll(() => {
    if (tempRoot !== "") {
      nodeFs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("CloudflareHost refuses all FileSystem, ChildProcessSpawner, and Jj calls while minting unique OwnerIdentity", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        hostId: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
        path: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
        fsOp: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 19 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const ownerSvc = yield* OwnerIdentity.OwnerIdentity
            const a = yield* ownerSvc.ownerId(input.hostId)
            const b = yield* ownerSvc.ownerId(input.hostId)
            if (a.hostId !== input.hostId || b.hostId !== input.hostId) return false
            if (a.pid === b.pid || a.nonce === b.nonce) return false

            const fs = yield* FileSystem.FileSystem
            const p = `/${input.path.replace(/\0/g, "_")}`
            const fsCalls: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
              fs.access(p),
              fs.chmod(p, 0o644),
              fs.chown(p, 1, 1),
              fs.copy(p, `${p}.2`),
              fs.copyFile(p, `${p}.2`),
              fs.exists(p),
              fs.link(p, `${p}.l`),
              fs.makeDirectory(p),
              fs.makeTempDirectory(),
              fs.readDirectory(p),
              fs.readFile(p),
              fs.readFileString(p),
              fs.readLink(p),
              fs.realPath(p),
              fs.remove(p),
              fs.rename(p, `${p}.r`),
              fs.stat(p),
              fs.symlink(p, `${p}.s`),
              fs.truncate(p),
              fs.writeFileString(p, "x")
            ]
            const fsExit = yield* Effect.exit(fsCalls[input.fsOp]!)
            if (!Exit.isFailure(fsExit)) return false

            const spawner = yield* ChildProcessSpawner
            const spExit = yield* Effect.exit(Effect.scoped(spawner.spawn(ChildProcess.make("echo", ["hi"]))))
            if (!Exit.isFailure(spExit)) return false

            const jj = yield* Jj.Jj
            const jjExit = yield* Effect.exit(jj.status())
            if (!Exit.isFailure(jjExit)) return false
            const jjErr = Cause.squash(jjExit.cause)
            return Jj.isJjError(jjErr) && jjErr.code === "not_installed"
          }).pipe(Effect.provide(CloudflareHost.layer)),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("EdgeCache preserves byte roundtrips, respects maxEntryBytes, and fails unavailable when CacheStorage refuses", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["default_rw", "named_rw", "too_large", "no_default", "open_throws"]),
        scope: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
        part: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(24))),
        payload: Schema.Array(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 })))).pipe(
          Schema.check(Schema.isMaxLength(64))
        )
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const safeScope = "s" + input.scope.toLowerCase().replace(/[^a-z0-9-]/g, "a")
            const safePart = input.part.replace(/[^a-zA-Z0-9._-]/g, "b") || "p"
            const key = ImmutableCache.key(safeScope, safePart)
            const bytes = Uint8Array.from(input.payload)

            if (input.mode === "no_default") {
              const caches: EdgeCache.CacheStorage = {
                open: async () => ImmutableCache.makeMemoryWebCache()
              }
              const exit = yield* Effect.exit(
                Effect.provide(
                  Effect.flatMap(ImmutableCache.ImmutableCache, (c) => c.get(key)),
                  EdgeCache.layer({ caches })
                )
              )
              return Exit.isFailure(exit)
            }

            if (input.mode === "open_throws") {
              const caches: EdgeCache.CacheStorage = {
                open: async () => {
                  throw new Error("cache denied")
                }
              }
              const exit = yield* Effect.exit(
                Effect.provide(
                  Effect.flatMap(ImmutableCache.ImmutableCache, (c) => c.get(key)),
                  EdgeCache.layer({ caches, name: "repo" })
                )
              )
              return Exit.isFailure(exit)
            }

            const defaultCache = ImmutableCache.makeMemoryWebCache()
            const namedCaches = new Map<string, ImmutableCache.WebCache>()
            const caches: EdgeCache.CacheStorage = {
              default: defaultCache,
              open: async (name) => {
                let c = namedCaches.get(name)
                if (c === undefined) {
                  c = ImmutableCache.makeMemoryWebCache()
                  namedCaches.set(name, c)
                }
                return c
              }
            }

            if (input.mode === "too_large") {
              const big = new Uint8Array(64)
              const layer = EdgeCache.layer({ caches, name: "bounded", maxEntryBytes: 16 })
              const got = yield* Effect.provide(
                Effect.gen(function*() {
                  const cache = yield* ImmutableCache.ImmutableCache
                  yield* cache.put(key, { bytes: big, metadata: { kind: "bin" } })
                  return yield* cache.get(key)
                }),
                layer
              )
              return Option.isNone(got)
            }

            const layer = input.mode === "named_rw"
              ? EdgeCache.layer({ caches, name: "named-ns" })
              : EdgeCache.layer({ caches })

            return yield* Effect.provide(
              Effect.gen(function*() {
                const cache = yield* ImmutableCache.ImmutableCache
                const before = yield* cache.get(key)
                if (Option.isSome(before)) return false
                yield* cache.put(key, { bytes, metadata: { kind: "bin" } })
                const after = yield* cache.get(key)
                if (Option.isNone(after)) return false
                const got = after.value.bytes
                if (got.length !== bytes.length) return false
                for (let i = 0; i < bytes.length; i++) {
                  if (got[i] !== bytes[i]) return false
                }
                return true
              }),
              layer
            )
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  })

  it("ObjectDatabase maintains transaction atomicity, savepoint rollback, and readTransaction over DO SQLite storage", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        ops: Schema.Array(
          Schema.Struct({
            val: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -1000, maximum: 1000 }))),
            kind: Schema.Literals(["commit", "rollback", "nested_rollback"])
          })
        ).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8)))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) => {
          const store = SqliteStorage.make()
          return Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql`CREATE TABLE items (v INTEGER NOT NULL)`
            const expected: Array<number> = []

            for (const op of input.ops) {
              if (op.kind === "commit") {
                yield* sql.withTransaction(sql`INSERT INTO items (v) VALUES (${op.val})`)
                expected.push(op.val)
              } else if (op.kind === "rollback") {
                const exit = yield* Effect.exit(
                  sql.withTransaction(
                    Effect.andThen(sql`INSERT INTO items (v) VALUES (${op.val})`, Effect.fail("abort"))
                  )
                )
                if (!Exit.isFailure(exit)) return false
              } else {
                yield* sql.withTransaction(
                  Effect.gen(function*() {
                    yield* sql`INSERT INTO items (v) VALUES (${op.val})`
                    yield* Effect.exit(
                      sql.withTransaction(
                        Effect.andThen(sql`INSERT INTO items (v) VALUES (${op.val + 1})`, Effect.fail("inner"))
                      )
                    )
                  })
                )
                expected.push(op.val)
              }
            }

            const rows = yield* Dialect.readTransaction(
              sql,
              sql<{ readonly v: number }>`SELECT v FROM items ORDER BY rowid`
            )
            if (rows.length !== expected.length) return false
            for (let i = 0; i < expected.length; i++) {
              if (rows[i]!.v !== expected[i]) return false
            }
            return store.transactions() >= input.ops.length + 1
          }).pipe(Effect.provide(ObjectDatabase.layer(store.storage)))
        },
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)
  })

  it("SandboxObject.wake, rearm, and run preserve offline-first ordering, intercept registration, and fault propagation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        initiallyRunning: Schema.Boolean,
        interceptCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 4 }))),
        timeoutMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1000, maximum: 3_600_000 }))),
        instanceKind: Schema.Literals(["none", "preset", "custom"]),
        failPhase: Schema.Literals(["none", "start", "timeout", "intercept"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const intercepts = Array.from({ length: input.interceptCount }, (_, i) => ({
              host: `svc-${i}.smithers.internal`,
              fetcher: `fetcher-${i}`
            }))
            const { calls, machine } = MemoryContainer.machine(
              input.initiallyRunning,
              input.failPhase === "none" ? undefined : input.failPhase
            )

            const instance: SandboxObject.Instance | undefined = input.instanceKind === "none"
              ? undefined
              : input.instanceKind === "preset"
              ? "standard-1"
              : { vcpu: 2, memoryMib: 2048, diskMb: 4000 }

            const wakeExit = yield* Effect.exit(
              SandboxObject.wake(machine, {
                intercepts,
                inactivityTimeoutMs: input.timeoutMs,
                ...(instance === undefined ? {} : { instance })
              })
            )

            const shouldFail = (input.failPhase === "start" && !input.initiallyRunning) ||
              input.failPhase === "timeout" ||
              (input.failPhase === "intercept" && input.interceptCount > 0)

            if (shouldFail) {
              return Exit.isFailure(wakeExit)
            }
            if (!Exit.isSuccess(wakeExit)) return false

            if (input.initiallyRunning) {
              if (wakeExit.value !== "running") return false
              if (calls.length !== 1 + intercepts.length || calls[0]!._tag !== "timeout") return false
            } else {
              if (wakeExit.value !== "started") return false
              const first = calls[0]
              if (
                first === undefined || first._tag !== "start" ||
                (first.options as { readonly enableInternet?: boolean }).enableInternet !== false
              ) return false
              if (calls[1]?._tag !== "timeout") return false
              const registered = calls.slice(2)
              if (registered.length !== intercepts.length) return false
            }

            // Rearm returns boolean depending on running state (MemoryContainer keeps initial running flag)
            const beforeRearm = calls.length
            const rearmed = yield* SandboxObject.rearm(machine, input.timeoutMs)
            if (input.initiallyRunning) {
              if (rearmed !== "rearmed" || calls.length !== beforeRearm + 1) return false
            } else {
              if (rearmed !== "stopped" || calls.length !== beforeRearm) return false
            }

            // SandboxObject.run executes command & captures exit code
            const mem = MemoryContainer.make(() => 0)
            const runRes = yield* SandboxObject.run(mem.container, ["echo", "ok"])
            return runRes === 0
          }),
        { seed: seed + 3, executions }
      )
    )
    assertPassed(report)
  })

  it("ContainerSession rejects non-numeric uid:gid users before exec and preserves file bytes", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["bad_user", "file_rw", "spawn_stdin"]),
        badUser: Schema.Literals(["root", "1000", "1000:2000;id", " 1000:2000", "-1:0", "a:b", "1000:"]),
        bytes: Schema.Array(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 })))).pipe(
          Schema.check(Schema.isMaxLength(48))
        ),
        envVal: Schema.String.pipe(Schema.check(Schema.isMaxLength(24)))
      })
    )

    const sessionExecutions = Math.min(executions, 25)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const workdir = nodeFs.mkdtempSync(join(tempRoot, "cs-"))
            try {
              const { commands, container } = ProcessContainer.make()
              if (input.mode === "bad_user") {
                const session = yield* ContainerSession.make(container, {
                  id: "fuzz-bad",
                  workdir,
                  user: input.badUser
                })
                const spawnExit = yield* Effect.exit(Effect.scoped(session.spawn("true", {})))
                const pingExit = yield* Effect.exit(session.ping!)
                return Exit.isFailure(spawnExit) && Exit.isFailure(pingExit) && commands.length === 0
              }

              const session = yield* ContainerSession.make(container, { id: "fuzz-ok", workdir })
              if (input.mode === "file_rw") {
                const data = Uint8Array.from(input.bytes)
                const filePath = join(workdir, "sub/data.bin")
                yield* session.writeFile(filePath, data)
                const readBack = yield* session.readFile(filePath)
                if (readBack.length !== data.length) return false
                for (let i = 0; i < data.length; i++) {
                  if (readBack[i] !== data[i]) return false
                }
                const missingExit = yield* Effect.exit(session.readFile(join(workdir, "does-not-exist")))
                return Exit.isFailure(missingExit)
              }

              const safeVal = input.envVal.replace(/[\0\r\n]/g, "")
              const stdinBytes = encoder.encode(safeVal)
              const out = yield* Effect.scoped(
                Effect.gen(function*() {
                  const proc = yield* session.spawn("cat", { stdin: stdinBytes })
                  const chunks = yield* Stream.runCollect(proc.stdout)
                  const code = yield* proc.exitCode
                  return { chunks, code }
                })
              )
              const totalLen = Array.from(out.chunks).reduce((acc, c) => acc + c.length, 0)
              return out.code === 0 && totalLen === stdinBytes.length
            } finally {
              nodeFs.rmSync(workdir, { recursive: true, force: true })
            }
          }),
        { seed: seed + 4, executions: sessionExecutions }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("ContainerTerminal enforces read-only isolation, bad-control rejection, resize forwarding, and clean close", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["normal", "bad_control", "too_big", "invalid_opts", "ensure_session"]),
        access: Schema.Literals(["write", "read"]),
        cols: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 20, maximum: 240 }))),
        rows: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 5, maximum: 80 }))),
        inputLen: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 64 }))),
        outLen: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 128 }))),
        badControl: Schema.Literals([
          "{not-json",
          "{\"type\":\"unknown\"}",
          "{\"type\":\"resize\",\"cols\":-1,\"rows\":0}"
        ]),
        exitCode: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 2 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const shell = (argv: ReadonlyArray<string>) => argv[1] === "attach-session" ? ("interactive" as const) : 0
            const memory = MemoryContainer.make(shell)
            const viewer = MemoryContainer.socket()

            if (input.mode === "invalid_opts") {
              // Root uid 0:0 or non-UUID name MUST be rejected with unsupported before exec
              const r = yield* ContainerTerminal.attach(memory.container, viewer.socket, {
                name: "not-a-uuid",
                user: "0:0",
                access: input.access,
                cols: input.cols,
                rows: input.rows
              })
              return r.outcome === "unsupported" && r.closeCode === TerminalProtocol.CloseCode.unsupported &&
                memory.commands.length === 0
            }

            if (input.mode === "ensure_session") {
              const out = yield* ContainerTerminal.ensureSession(memory.container, {
                name: "0195a8f0-1234-7000-8000-000000000001",
                user: "1000:2000",
                cwd: "/workspace"
              })
              return out === "existing" || out === "created"
            }

            const fiber = yield* Effect.forkChild(
              ContainerTerminal.attach(memory.container, viewer.socket, {
                name: "0195a8f0-1234-7000-8000-000000000001",
                user: "1000:2000",
                access: input.access,
                cols: input.cols,
                rows: input.rows
              })
            )
            const client = yield* memory.started

            const readyFrame = yield* viewer.next
            if (typeof readyFrame !== "string") return false
            const ready = TerminalProtocol.decodeServerControl(readyFrame)
            if (ready?.type !== "ready" || ready.access !== input.access) return false

            if (input.mode === "bad_control") {
              viewer.emit("message", input.badControl)
              const result = yield* Fiber.join(fiber)
              return result.outcome === "unsupported" && result.closeCode === TerminalProtocol.CloseCode.unsupported
            }

            if (input.mode === "too_big") {
              viewer.emit("message", new Uint8Array(TerminalProtocol.maxFrameBytes + 1))
              const result = yield* Fiber.join(fiber)
              return result.outcome === "too_big" && result.closeCode === TerminalProtocol.CloseCode.tooBig
            }

            const payload = Uint8Array.from({ length: input.inputLen }, (_, i) => (i + 65) & 0xff)
            if (input.access === "write") yield* Effect.yieldNow
            viewer.emit("message", TerminalProtocol.encodeResize(input.cols + 1, input.rows + 1))
            viewer.emit("message", payload)

            if (input.access === "write") {
              const typed = yield* client.typed
              if (typed.length !== payload.length) return false
            }

            const outBytes = Uint8Array.from({ length: input.outLen }, (_, i) => (i * 7) & 0xff)
            yield* client.write(outBytes)
            const received = yield* viewer.next
            if (!(received instanceof Uint8Array) || received.length !== outBytes.length) return false

            yield* client.exit(input.exitCode)
            const endFrame = yield* viewer.next
            if (typeof endFrame !== "string") return false
            const ended = TerminalProtocol.decodeServerControl(endFrame)
            if (ended?.type !== "ended") return false

            const result = yield* Fiber.join(fiber)
            if (input.access === "read") {
              if (client.resizes.length !== 0) return false
              if (result.bytes.in !== 0) return false
            } else {
              if (result.bytes.in !== payload.length) return false
            }
            return result.bytes.out === outBytes.length
          }),
        { seed: seed + 5, executions: Math.min(executions, 60) }
      )
    )
    assertPassed(report)
  })

  it("FailureDetail redacts URL credentials, bounds length, and hides SQLSTATE 22xxx row payloads", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        secretUser: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
        secretPass: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
        sqlState: Schema.Literals(["22001", "22P02", "23505", "42601", "08006", "not-a-state"]),
        reasonTag: Schema.Literals(["ConnectionError", "SqlSyntaxError", "UnknownError"]),
        isMigration: Schema.Boolean,
        repeat: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 20 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const safeUser = input.secretUser.replace(/[\s/@:]/g, "u") || "u"
            const safePass = input.secretPass.replace(/[\s/@:]/g, "p") || "p"
            const secretUrl = `postgres://${safeUser}:${safePass}@db.internal:5432/app`

            const innerDbErr = {
              message: `sensitive payload ${secretUrl} `.repeat(input.repeat),
              code: input.sqlState
            }
            const reasonErr = {
              _tag: input.reasonTag,
              message: `driver failed at ${secretUrl} `.repeat(input.repeat),
              cause: innerDbErr
            }
            const sqlErr = {
              _tag: "SqlError",
              message: "sql error",
              cause: reasonErr
            }
            const topErr = input.isMigration
              ? {
                _tag: "MigrationError",
                kind: "MigrationFailed",
                message: `Migration "0001_init" failed`,
                cause: sqlErr
              }
              : sqlErr

            const detail = FailureDetail.detail(Cause.fail(topErr), `SELECT '${secretUrl}'`)

            for (const val of Object.values(detail)) {
              if (val.length > 1000) return false
              if (val.includes(`${safeUser}:${safePass}@`)) return false
            }

            if (input.isMigration && input.sqlState.startsWith("22") && input.reasonTag !== "ConnectionError") {
              if (detail["db.error.message"] !== undefined) return false
            }

            const [exit, stmt] = yield* FailureDetail.withFailedStatement(
              Effect.fail("boom").pipe(
                Effect.withSpan("sql.exec", { kind: "client", attributes: { "db.query.text": "SELECT 1" } })
              )
            )
            if (!Exit.isFailure(exit) || stmt !== "SELECT 1") return false

            const counter = Metric.counter("fuzz_observed_counter", { incremental: true })
            const obs = yield* Observed.observed(
              Effect.succeed("ok" as const),
              { span: "fuzz.span", attributes: {}, attribute: "outcome", counter, log: "fuzz.log" }
            )
            return obs === "ok"
          }),
        { seed: seed + 6, executions }
      )
    )
    assertPassed(report)
  })

  it(
    "ExecutionObject & CloudflareRuntime drive durable flows over ObjectDatabase with start, conflict, alarm, cancel, and retention",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          question: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(24))),
          scenario: Schema.Literals([
            "complete",
            "idle_before_start",
            "intent_conflict",
            "cancel_before_alarm",
            "settled_retry",
            "with_retention",
            "admission_refused"
          ])
        })
      )

      const engineExecutions = Math.min(executions, 20)
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.gen(function*() {
              const memStorage = MemoryStorage.make()
              const dbStore = SqliteStorage.make()
              const database = ObjectDatabase.layer(dbStore.storage)
              const recorded: Array<string> = []
              const safeQ = new TextDecoder().decode(new TextEncoder().encode(input.question.replace(/\0/g, "_")))
              const execId = `exec-${Math.abs(safeQ.length * 97 + 13)}`

              let settledAttempts = 0
              const settledDown = () => input.scenario === "settled_retry" && settledAttempts === 1

              const runtimeFor = (intent: ExecutionObject.Intent) =>
                CloudflareRuntime.layer(
                  {
                    hostId: "do-fuzz-1",
                    executionId: intent.executionId,
                    flow: intent.flow,
                    ...(input.scenario === "with_retention" ? { retention: { olderThanMs: 0, limit: 10 } } : {})
                  },
                  AnswerFlow.registration((label) =>
                    Effect.sync(() => {
                      recorded.push(label)
                      return `done:${label}`
                    })
                  )
                ).pipe(Layer.provide(database))

              const router: ExecutionObject.Router = {
                start: () => Effect.void,
                wake: () => Effect.void
              }

              const obj = ExecutionObject.make(memStorage.storage, {
                flows: [AnswerFlow.Answer],
                runtime: runtimeFor,
                router,
                canStart: input.scenario === "admission_refused" ? () => Effect.succeed(false) : undefined,
                settled: () =>
                  Effect.suspend(() => {
                    settledAttempts++
                    return settledDown() ? Effect.fail("transient-db-down") : Effect.void
                  })
              })

              if (input.scenario === "idle_before_start") {
                const idle = yield* obj.alarm()
                return idle._tag === "Idle"
              }

              const startIntent = yield* ExecutionObject.intent(AnswerFlow.Answer, {
                executionId: execId,
                payload: { question: safeQ, pauseMs: 0 }
              })

              yield* obj.start(startIntent)
              // Duplicate start with same intent is idempotent
              yield* obj.start(startIntent)

              if (input.scenario === "intent_conflict") {
                const otherIntent = yield* ExecutionObject.intent(AnswerFlow.Answer, {
                  executionId: execId,
                  payload: { question: `${safeQ}-different`, pauseMs: 0 }
                })
                const conflictExit = yield* Effect.exit(obj.start(otherIntent))
                if (!Exit.isFailure(conflictExit)) return false
                const err = Cause.squash(conflictExit.cause)
                return err instanceof ExecutionObject.IntentConflict
              }

              if (input.scenario === "admission_refused") {
                const out = yield* obj.alarm()
                return out._tag === "Forgotten" || out._tag === "Idle" || out._tag === "Settled"
              }

              if (input.scenario === "cancel_before_alarm") {
                yield* obj.cancel()
                const outcome = yield* obj.alarm()
                return outcome._tag === "Settled" || outcome._tag === "Forgotten" || outcome._tag === "Idle"
              }

              let outcome = yield* obj.alarm()
              for (let i = 0; i < 4 && (outcome._tag === "Parked" || outcome._tag === "Yielded"); i++) {
                outcome = yield* obj.alarm()
              }

              if (input.scenario === "settled_retry") {
                if (outcome._tag !== "Retrying") return false
                if (memStorage.alarm() === null) return false
                const retryOut = yield* obj.alarm()
                return retryOut._tag === "Settled" && settledAttempts >= 2
              }

              return outcome._tag === "Settled" && recorded.includes(`ask:${safeQ}`)
            }),
          { seed: seed + 7, executions: engineExecutions }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it("ExecutionObject concurrent start & wake calls are idempotent under FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nStarters: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 5 }))),
        nWakers: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const mem = MemoryStorage.make()
            const startIntent = yield* ExecutionObject.intent(AnswerFlow.Answer, {
              executionId: "sim-exec-1",
              payload: { question: "hi", pauseMs: 0 }
            })
            const now = yield* Clock.currentTimeMillis
            const startCalls = Array.from({ length: input.nStarters }, () =>
              ExecutionObject.start(mem.storage, startIntent, Effect.void))
            const wakeCalls = Array.from({ length: input.nWakers }, () =>
              ExecutionObject.wake(mem.storage))

            const [starts, wakes] = yield* Effect.all(
              [
                Effect.all(startCalls, { concurrency: "unbounded" }),
                Effect.all(wakeCalls, { concurrency: "unbounded" })
              ],
              { concurrency: 2 }
            )

            if (starts.length !== input.nStarters) return false
            if (mem.values.get(ExecutionObject.intentKey) === undefined) return false
            const armed = mem.alarm()
            if (armed === null || armed < now) return false
            return wakes.every((w) => typeof w === "boolean")
          }),
        { seed: seed + 8, executions, execution: FuzzSimulation.execution() }
      )
    )
    assertPassed(report)
  })

  it("ExecutionObject.intent rejects lone UTF-16 surrogates in typed SchemaError instead of dying with CanonicalError", async () => {
    const EchoFlow = Flow.make("cloudflare-test/LoneSurrogate", {
      payload: Schema.Struct({ question: Schema.String }),
      success: Schema.String,
      body: (p) => Node.succeed(p.question)
    })
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(
          Schema.Struct({
            prefix: Schema.String.pipe(Schema.check(Schema.isMaxLength(16))),
            surrogate: Schema.Literals(["\ud800", "\udbff", "\udc00", "\udfff"])
          })
        ),
        ({ prefix, surrogate }) =>
          Effect.gen(function*() {
            const bad = prefix.replace(/[\uD800-\uDFFF]/g, "x") + surrogate
            const exit = yield* ExecutionObject.intent(EchoFlow, {
              executionId: "exec-surrogate-1",
              payload: { question: bad }
            }).pipe(Effect.exit)
            if (exit._tag !== "Failure") return false
            // Must fail cleanly in the typed error channel, never die with CanonicalError
            const err = exit.cause.reasons.find((r) => r._tag === "Fail")
            const die = exit.cause.reasons.find((r) => r._tag === "Die")
            return err !== undefined && die === undefined
          }),
        { seed: seed + 99, executions: 60 }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
