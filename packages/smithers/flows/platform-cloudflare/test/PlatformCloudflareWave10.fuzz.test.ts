import { Fuzz } from "@smthrs/fuzz"
import { TerminalProtocol } from "@smthrs/sandbox"
import { Arbitrary, Effect, Exit, Fiber, FileSystem, Layer, Logger, Result, Schema, Sink, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  CloudflareRuntime,
  ContainerSession,
  ContainerTerminal,
  EdgeCache,
  ExecutionObject,
  ObjectDatabase,
  SandboxObject
} from "../src/index.ts"
import * as Refusals from "../src/internal/Refusals.ts"
import * as MemoryContainer from "./fixtures/MemoryContainer.ts"
import * as MemoryStorage from "./fixtures/MemoryStorage.ts"
import { Counter, flows, Holder, Parent, registration } from "./fixtures/NestedFlows.ts"
import * as SqliteStorage from "./fixtures/SqliteStorage.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "250")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const silentLogger = Logger.layer([])
const encoder = new TextEncoder()

const makeSessionContainer = (
  impl: (
    argv: ReadonlyArray<string>,
    options?: ContainerSession.ExecOptions
  ) => Effect.Effect<ContainerSession.Process<Error>, Error>
): ContainerSession.Container<Error> => ({
  exec: (argv, options) => impl(argv, options)
})

describe("@smthrs/platform-cloudflare Wave 10 deep fuzz", () => {
  it("ExecutionObject & Routing cover continueHere, parent/child wake routing, WakeBus admitted shortcut, invalid/poisoned intents, unknown flow, settled retention & cancel", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "continueHereLineage",
          "parentChildRouted",
          "parentChildAdmittedFail",
          "poisonedJsonIntent",
          "invalidPayloadIntent",
          "unknownFlowRetry",
          "cancelBeforeAdmit",
          "settledCallbackRetryAndForget",
          "holderCancelCleanup"
        ]),
        target: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, target }) =>
          Effect.gen(function*() {
            const store = SqliteStorage.make()
            const memory = MemoryStorage.make()
            const started: Array<ExecutionObject.Intent> = []
            const woken: Array<string> = []
            let failRouter = mode === "parentChildAdmittedFail"
            let settledAttempts = 0

            const router: ExecutionObject.Router<string> = {
              start: (intent) =>
                failRouter
                  ? Effect.fail("router-temp-down")
                  : Effect.sync(() => {
                    started.push(intent)
                  }),
              wake: (id) =>
                Effect.sync(() => {
                  woken.push(id)
                })
            }

            const host = ExecutionObject.make(memory.storage, {
              flows,
              runtime: (intent) =>
                CloudflareRuntime.layer(
                  { hostId: "w10-host", executionId: intent.executionId, flow: intent.flow },
                  registration((label) => Effect.succeed(label))
                ).pipe(Layer.provide(ObjectDatabase.layer(store.storage))),
              router,
              settledRetentionMs: 0,
              ...(mode === "continueHereLineage"
                ? { continueHere: (intent) => intent.flow === Counter._tag }
                : {}),
              ...(mode === "settledCallbackRetryAndForget"
                ? {
                  settled: () =>
                    Effect.suspend(() => {
                      settledAttempts++
                      return settledAttempts === 1 ? Effect.fail(new Error("transient")) : Effect.void
                    })
                }
                : {})
            })

            switch (mode) {
              case "continueHereLineage": {
                const intent = yield* ExecutionObject.intent(Counter, {
                  executionId: "lin-1",
                  payload: { value: 0, target }
                })
                yield* host.start(intent)
                let sawContinued = false
                let sawSettled = false
                let sawForgotten = false
                for (let i = 0; i < target + 4; i++) {
                  const out = yield* host.alarm()
                  if (out._tag === "Continued") sawContinued = true
                  if (out._tag === "Settled") sawSettled = true
                  if (out._tag === "Forgotten") {
                    sawForgotten = true
                    break
                  }
                }
                return (target === 1 || sawContinued) && (sawSettled || sawForgotten)
              }
              case "parentChildRouted":
              case "parentChildAdmittedFail": {
                const intent = yield* ExecutionObject.intent(Parent, {
                  executionId: `par-${target}`,
                  payload: { label: "hi" }
                })
                yield* host.start(intent)
                if (mode === "parentChildAdmittedFail") {
                  const r1 = yield* host.alarm()
                  failRouter = false
                  const r2 = yield* host.alarm()
                  return r1._tag === "Retrying" && (r2._tag === "Parked" || r2._tag === "Settled")
                }
                const out = yield* host.alarm()
                if (started.length === 0) return false
                const childIntent = started[0]!
                const childMem = MemoryStorage.make()
                const childHost = ExecutionObject.make(childMem.storage, {
                  flows,
                  runtime: (i) =>
                    CloudflareRuntime.layer(
                      { hostId: "w10-child", executionId: i.executionId, flow: i.flow },
                      registration((label) => Effect.succeed(label))
                    ).pipe(Layer.provide(ObjectDatabase.layer(store.storage))),
                  router,
                  settledRetentionMs: 0
                })
                yield* childHost.start(childIntent)
                const childOut = yield* childHost.alarm()
                yield* host.wake()
                const parFinal = yield* host.alarm()
                return out._tag === "Parked" && childOut._tag === "Settled" && woken.includes(`par-${target}`) && parFinal._tag === "Settled"
              }
              case "poisonedJsonIntent": {
                yield* memory.storage.put(ExecutionObject.intentKey, "{not-valid-json")
                const out = yield* host.alarm()
                return out._tag === "Forgotten" || out._tag === "Settled"
              }
              case "invalidPayloadIntent": {
                yield* memory.storage.put(
                  ExecutionObject.intentKey,
                  JSON.stringify({ flow: Counter._tag, executionId: "bad-pay", payload: { wrong: true } })
                )
                const out = yield* host.alarm()
                return out._tag === "Forgotten" || out._tag === "Settled"
              }
              case "unknownFlowRetry": {
                yield* memory.storage.put(
                  ExecutionObject.intentKey,
                  JSON.stringify({ flow: "no-such-flow", executionId: "unk-1", payload: {} })
                )
                const out = yield* host.alarm()
                return out._tag === "Retrying"
              }
              case "cancelBeforeAdmit": {
                const intent = yield* ExecutionObject.intent(Counter, {
                  executionId: "can-1",
                  payload: { value: 0, target: 1 }
                })
                yield* host.start(intent)
                yield* host.cancel()
                const out = yield* host.alarm()
                return out._tag === "Settled" || out._tag === "Forgotten"
              }
              case "settledCallbackRetryAndForget": {
                const intent = yield* ExecutionObject.intent(Counter, {
                  executionId: "set-1",
                  payload: { value: 1, target: 1 }
                })
                yield* host.start(intent)
                const out1 = yield* host.alarm()
                const out2 = yield* host.alarm()
                return out1._tag === "Retrying" && (out2._tag === "Forgotten" || out2._tag === "Settled")
              }
              case "holderCancelCleanup": {
                const intent = yield* ExecutionObject.intent(Holder, {
                  executionId: "hold-1",
                  payload: { label: "x" }
                })
                yield* host.start(intent)
                const out1 = yield* host.alarm()
                yield* host.cancel()
                const out2 = yield* host.alarm()
                return out1._tag === "Parked" && (out2._tag === "Settled" || out2._tag === "Forgotten")
              }
            }
          }).pipe(Effect.provide(silentLogger)),
        { seed, executions: Math.min(executions, 30) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  }, 120_000)

  it("ContainerTerminal covers ensureSession create/race/fail and attach Blob/ArrayBuffer/oversize/missing-streams/send-failure/stdin-failure", async () => {
    const id = "0b6c8a52-5f0e-4d4e-9a9e-1f2b3c4d5e6f"
    const attachOpts = (access: TerminalProtocol.Access): ContainerTerminal.AttachOptions => ({
      name: id,
      user: "1000:1000",
      access,
      cols: 80,
      rows: 24
    })

    // 1. ensureSession: created, race-existing, failed
    const cCreated = MemoryContainer.make((argv) => (argv[1] === "has-session" ? 1 : 0))
    const rCreated = await Effect.runPromise(
      ContainerTerminal.ensureSession(cCreated.container, { name: id, cwd: "/workspace", user: "1000:1000" }).pipe(Effect.provide(silentLogger))
    )
    expect(rCreated).toBe("created")

    let hasCalls = 0
    const cRace = MemoryContainer.make((argv) => {
      if (argv[1] === "has-session") return hasCalls++ === 0 ? 1 : 0
      return 1
    })
    const rRace = await Effect.runPromise(
      ContainerTerminal.ensureSession(cRace.container, { name: id, cwd: "/workspace", user: "1000:1000" }).pipe(Effect.provide(silentLogger))
    )
    expect(rRace).toBe("existing")

    const cFail = MemoryContainer.make(() => 1)
    const rFail = await Effect.runPromise(
      Effect.result(ContainerTerminal.ensureSession(cFail.container, { name: id, cwd: "/workspace", user: "1000:1000" }).pipe(Effect.provide(silentLogger)))
    )
    expect(Result.isFailure(rFail)).toBe(true)

    // 2. attach: ArrayBuffer, Blob (good & failing), oversize text, invalid binary, missing stdout/stdin, send failure, stdin sink failure
    const shell = (argv: ReadonlyArray<string>) => (argv[1] === "attach-session" ? "interactive" as const : 0)

    // Good Blob + ArrayBuffer + resize + clean EOF
    {
      const mem = MemoryContainer.make(shell)
      const viewer = MemoryContainer.socket()
      const rep = await Effect.runPromise(
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(ContainerTerminal.attach(mem.container, viewer.socket, attachOpts("write")))
          const proc = yield* mem.started
          yield* viewer.next // ready
          viewer.emit("message", encoder.encode("ab").buffer)
          viewer.emit("message", new Blob([encoder.encode("cd")]))
          viewer.emit("message", JSON.stringify({ type: "resize", cols: 100, rows: 30 }))
          yield* proc.typed
          yield* proc.typed
          yield* proc.resized
          yield* proc.exit(0)
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(silentLogger))
      )
      expect(rep.outcome).toBe("ended")
    }

    // Failing Blob read -> failed verdict
    {
      const mem = MemoryContainer.make(shell)
      const viewer = MemoryContainer.socket()
      const rep = await Effect.runPromise(
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(ContainerTerminal.attach(mem.container, viewer.socket, attachOpts("write")))
          yield* mem.started
          yield* viewer.next // ready
          viewer.emit("message", { size: 4, arrayBuffer: () => Promise.reject(new Error("blob boom")) })
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(silentLogger))
      )
      expect(rep.outcome).toBe("failed")
    }

    // Oversized text frame (> maxFrameBytes) -> too_big
    {
      const mem = MemoryContainer.make(shell)
      const viewer = MemoryContainer.socket()
      const rep = await Effect.runPromise(
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(ContainerTerminal.attach(mem.container, viewer.socket, attachOpts("write")))
          yield* mem.started
          yield* viewer.next
          viewer.emit("message", "x".repeat(TerminalProtocol.maxFrameBytes + 10))
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(silentLogger))
      )
      expect(rep.outcome).toBe("too_big")
    }

    // Non-binary/non-string invalid payload -> unsupported
    {
      const mem = MemoryContainer.make(shell)
      const viewer = MemoryContainer.socket()
      const rep = await Effect.runPromise(
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(ContainerTerminal.attach(mem.container, viewer.socket, attachOpts("write")))
          yield* mem.started
          yield* viewer.next
          viewer.emit("message", { size: 4 })
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(silentLogger))
      )
      expect(rep.outcome).toBe("unsupported")
    }

    // Missing stdout / missing stdin / stdin sink failure / output break -> failed
    for (const faults of [{ noStdout: true }, { noStdin: true }, { stdin: true }] as ReadonlyArray<MemoryContainer.Faults>) {
      const mem = MemoryContainer.make(shell, faults)
      const viewer = MemoryContainer.socket()
      const rep = await Effect.runPromise(
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(ContainerTerminal.attach(mem.container, viewer.socket, attachOpts("write")))
          yield* mem.started
          if (faults.stdin) {
            yield* viewer.next
            viewer.emit("message", encoder.encode("hi"))
          }
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(silentLogger))
      )
      expect(rep.outcome).toBe("failed")
    }

    // Output stream break -> failed
    {
      const mem = MemoryContainer.make(shell)
      const viewer = MemoryContainer.socket()
      const rep = await Effect.runPromise(
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(ContainerTerminal.attach(mem.container, viewer.socket, attachOpts("read")))
          const proc = yield* mem.started
          yield* viewer.next
          yield* proc.breakOutput
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(silentLogger))
      )
      expect(rep.outcome).toBe("failed")
    }

    // Socket throws on initial ready send -> closed
    {
      const mem = MemoryContainer.make(shell)
      const viewer = MemoryContainer.socket()
      viewer.breakSends()
      const rep = await Effect.runPromise(
        ContainerTerminal.attach(mem.container, viewer.socket, attachOpts("read")).pipe(Effect.provide(silentLogger))
      )
      expect(rep.outcome).toBe("closed")
    }
  }, 60_000)

  it("ContainerSession, SandboxObject, Refusals, and EdgeCache cover error, unset env, byte limits, ping, timeouts, egress, and refused streams", async () => {
    const basicContainer = (
      mode: "ok" | "notFound" | "otherErr" | "writeFail" | "pingFail" | "noStdout" | "execFail" | "bigOut"
    ) =>
      makeSessionContainer((_argv, opts) => {
        if (mode === "execFail") return Effect.fail(new Error("exec boom"))
        const code =
          mode === "notFound" ? 44
          : mode === "otherErr" ? 2
          : mode === "writeFail" ? 3
          : mode === "pingFail" ? 1
          : 0
        const stdout =
          mode === "noStdout"
            ? undefined
            : mode === "bigOut"
            ? Stream.make(encoder.encode("x".repeat(64)))
            : Stream.make(encoder.encode("ok"))
        return Effect.succeed({
          stdin: opts?.stdin === "pipe" ? Sink.drain : undefined,
          stdout,
          stderr: Stream.empty,
          exitCode: Effect.succeed(code)
        })
      })

    // Invalid user
    const sBadUser = await Effect.runPromise(
      ContainerSession.make(basicContainer("ok"), { id: "s1", workdir: "/work", user: "root" }).pipe(Effect.provide(silentLogger))
    )
    const rBadUser = await Effect.runPromise(Effect.scoped(Effect.result(sBadUser.spawn("echo hi", {}))))
    expect(Result.isFailure(rBadUser)).toBe(true)

    // Valid session: invalid env name, unset env, relative & absolute cwd, ping ok
    const sess = await Effect.runPromise(
      ContainerSession.make(basicContainer("ok"), {
        id: "s2",
        workdir: "/work",
        user: "1000:1000",
        env: { KEEP: "1", DROP: "2" },
        maxFileBytes: 16
      }).pipe(Effect.provide(silentLogger))
    )
    const rBadEnv = await Effect.runPromise(Effect.scoped(Effect.result(sess.spawn("true", { env: { "1BAD": "x" } }))))
    expect(Result.isFailure(rBadEnv)).toBe(true)

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const p1 = yield* sess.spawn("true", { cwd: "sub", env: { DROP: undefined } })
      expect(yield* p1.exitCode).toBe(0)
      const p2 = yield* sess.spawn("true", { cwd: "/abs" })
      expect(yield* p2.exitCode).toBe(0)
    })))
    await Effect.runPromise(sess.ping!)

    // readFile 44 -> not_found, readFile 2 -> unknown, writeFile fail, ping fail, noStdout, execFail, bigOut
    const s44 = await Effect.runPromise(ContainerSession.make(basicContainer("notFound"), { id: "s44", workdir: "/work" }).pipe(Effect.provide(silentLogger)))
    const rf44 = await Effect.runPromise(Effect.result(s44.readFile("/missing")))
    expect(Result.isFailure(rf44) && rf44.failure.code === "not_found").toBe(true)

    const s2 = await Effect.runPromise(ContainerSession.make(basicContainer("otherErr"), { id: "s2e", workdir: "/work" }).pipe(Effect.provide(silentLogger)))
    const rf2 = await Effect.runPromise(Effect.result(s2.readFile("/err")))
    expect(Result.isFailure(rf2) && rf2.failure.code === "unknown").toBe(true)

    const swf = await Effect.runPromise(ContainerSession.make(basicContainer("writeFail"), { id: "swf", workdir: "/work" }).pipe(Effect.provide(silentLogger)))
    const wfFail = await Effect.runPromise(Effect.result(swf.writeFile("/f", encoder.encode("hi"))))
    expect(Result.isFailure(wfFail)).toBe(true)

    const spf = await Effect.runPromise(ContainerSession.make(basicContainer("pingFail"), { id: "spf", workdir: "/work" }).pipe(Effect.provide(silentLogger)))
    const pf = await Effect.runPromise(Effect.result(spf.ping!))
    expect(Result.isFailure(pf)).toBe(true)

    const sns = await Effect.runPromise(ContainerSession.make(basicContainer("noStdout"), { id: "sns", workdir: "/work" }).pipe(Effect.provide(silentLogger)))
    const rMiss = await Effect.runPromise(Effect.scoped(Effect.result(sns.spawn("true", {}))))
    expect(Result.isFailure(rMiss)).toBe(true)

    const sef = await Effect.runPromise(ContainerSession.make(basicContainer("execFail"), { id: "sef", workdir: "/work" }).pipe(Effect.provide(silentLogger)))
    const rExecFail = await Effect.runPromise(Effect.scoped(Effect.result(sef.spawn("true", {}))))
    expect(Result.isFailure(rExecFail)).toBe(true)

    const sbig = await Effect.runPromise(ContainerSession.make(basicContainer("bigOut"), { id: "sbig", workdir: "/work", maxFileBytes: 16 }).pipe(Effect.provide(silentLogger)))
    const rBig = await Effect.runPromise(Effect.result(sbig.readFile("/huge")))
    expect(Result.isFailure(rBig)).toBe(true)

    // SandboxObject: startTimeoutMs -> StartTimedOut, and egress interceptAllOutboundHttp + interceptOutboundHttps
    const slowMach: SandboxObject.Machine<string, Error> = {
      running: Effect.succeed(false),
      start: () => Effect.sleep("200 millis"),
      setInactivityTimeout: () => Effect.void,
      interceptOutboundHttp: () => Effect.void,
      interceptAllOutboundHttp: () => Effect.void,
      interceptOutboundHttps: () => Effect.void
    }
    const rTimeout = await Effect.runPromise(
      Effect.result(
        SandboxObject.wake(slowMach, {
          intercepts: [],
          startTimeoutMs: 20
        }).pipe(Effect.provide(silentLogger))
      )
    )
    expect(Result.isFailure(rTimeout)).toBe(true)

    const egressMach = MemoryContainer.machine(true)
    const wakeRes = await Effect.runPromise(
      SandboxObject.wake(egressMach.machine, {
        intercepts: [{ host: "forge.internal", fetcher: "forge-fetcher" }],
        egress: "egress-fetcher",
        inactivityTimeoutMs: 60_000
      }).pipe(Effect.provide(silentLogger))
    )
    expect(wakeRes).toBe("running")
    expect(egressMach.calls.some((c) => c._tag === "interceptAll")).toBe(true)
    expect(egressMach.calls.some((c) => c._tag === "interceptHttps")).toBe(true)

    // Refusals.layerFileSystem: sink, stream, watch
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const e1 = yield* Effect.exit(Stream.runDrain(fs.stream("/a")))
        const e2 = yield* Effect.exit(Stream.runDrain(fs.watch("/a")))
        const e3 = yield* Effect.exit(Stream.run(Stream.make(encoder.encode("hi")), fs.sink("/a")))
        expect(Exit.isFailure(e1) && Exit.isFailure(e2) && Exit.isFailure(e3)).toBe(true)
      }).pipe(Effect.provide(Refusals.layerFileSystem))
    )

    // EdgeCache.layer default
    expect(EdgeCache.layer()).toBeDefined()
  }, 60_000)
})
