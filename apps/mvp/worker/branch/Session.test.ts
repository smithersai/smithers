import { Logger as StructuredLogger } from "@smthrs/observability"
import { Clock, ConfigProvider, Deferred, Effect, Exit, Fiber, Logger } from "effect"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"
import {
  asUser, configuredSessionOn, runOn, sandboxSessionTimeoutSeconds, sessionOn,
  type Container, type ExecOptions, type SessionOptions,
} from "./Session.ts"
import { envOf, idOf, provisionArgv, userOf } from "./Users.ts"

const TERMINAL = "12345678-1234-1234-1234-123456789abc"
type Line = ReturnType<typeof StructuredLogger.formatStructured.log>

/** An injected container service: provision launches successfully, but its process never exits. */
const stuckBox: Container = {
  exec: () => Effect.succeed({
    exitCode: Effect.never,
  }),
}

const run = <A, E>(effect: Effect.Effect<A, E>, lines: Array<Line>) => Effect.runPromise(effect.pipe(
  Effect.provide(TestClock.layer()),
  Effect.provideService(Logger.CurrentLoggers, new Set([
    Logger.make((options) => void lines.push(StructuredLogger.formatStructured.log(options))),
  ])),
))

/** Container API service with scoped processes, command receipts and optional injected faults. */
const container = (
  answer: (argv: Array<string>) => Effect.Effect<number, unknown> = () => Effect.succeed(0),
  ensure: (options: SessionOptions) => Effect.Effect<unknown, unknown> = () => Effect.void,
) => {
  const commands: Array<{ argv: Array<string>; options: ExecOptions }> = []
  const sessions: Array<SessionOptions> = []
  let released = 0
  const box: Container<unknown> = {
    exec: (argv, options) => Effect.acquireRelease(
      Effect.sync(() => {
        commands.push({ argv, options })
        return {
          exitCode: answer(argv),
        }
      }),
      () => Effect.sync(() => void released++),
    ),
  }
  return {
    box, commands, sessions, released: () => released,
    ensureSession: (options: SessionOptions) => Effect.suspend(() => {
      sessions.push(options)
      return ensure(options)
    }),
  }
}

const sessionLine = (lines: Array<Line>, level: "INFO" | "WARN") => {
  const matching = lines.filter((line) => line.message === "sandbox.session")
  expect(matching).toHaveLength(1)
  expect(matching[0]!.level).toBe(level)
  // This log has no content, ids, command arguments or exception text, even when downstream logs do.
  expect(Object.keys(matching[0]!.annotations).sort()).toEqual(
    Object.keys(matching[0]!.annotations).filter((key) =>
      ["outcome", "stage", "startMs", "provisionMs", "sessionMs", "errorCode", "errorName"].includes(key)).sort(),
  )
  expect(JSON.stringify(matching[0])).not.toContain("content-sentinel")
  expect(JSON.stringify(matching[0])).not.toContain(TERMINAL)
  return matching[0]!.annotations
}

test("sandbox configuration", () => {
  const read = (config: Record<string, unknown>) => Effect.runSyncExit(sandboxSessionTimeoutSeconds.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
  ))
  expect(read({})).toEqual(Exit.succeed(60))
  expect(read({ SANDBOX_SESSION_TIMEOUT_SECONDS: "7" })).toEqual(Exit.succeed(7))
  for (const value of ["0", "-1", "1.5", "bad"]) {
    expect(Exit.isFailure(read({ SANDBOX_SESSION_TIMEOUT_SECONDS: value }))).toBe(true)
  }
})

test("a provision process that never exits answers false at the session deadline and names its stage", async () => {
  const lines: Array<Line> = []
  const options = { box: stuckBox, ensureSession: () => Effect.void, start: Effect.void, touch: Effect.void, timeoutMs: 60_000 }
  await run(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(sessionOn(options)(TERMINAL, "person-content-sentinel"))
    yield* TestClock.adjust("60 seconds")
    expect(yield* Fiber.join(fiber)).toBe(false)
    expect(yield* Clock.currentTimeMillis).toBe(60_000)
  }), lines)
  expect(sessionLine(lines, "WARN")).toEqual({
    stage: "provision", outcome: "timeout", startMs: 0, provisionMs: 60_000, errorCode: "TimeoutError", errorName: "TimeoutError",
  })
}, 2_000)

test("a started session logs each stage's elapsed time and runs as the person's numeric user", async () => {
  const lines: Array<Line> = []
  const host = container(() => Effect.as(Effect.sleep("5 seconds"), 0), () => Effect.sleep("18 seconds"))
  await run(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(sessionOn({
      ...host, start: Effect.sleep("1 second"), touch: Effect.sleep("2 seconds"), timeoutMs: 60_000,
    })(TERMINAL, "person-content-sentinel"))
    yield* TestClock.adjust("26 seconds")
    expect(yield* Fiber.join(fiber)).toBe(true)
  }), lines)
  expect(sessionLine(lines, "INFO")).toEqual({ outcome: "started", startMs: 3000, provisionMs: 5000, sessionMs: 18000 })
  const name = userOf("person-content-sentinel")
  expect(host.commands).toEqual([
    { argv: provisionArgv(name), options: { user: "0:0", env: envOf("root"), stdout: "ignore", stderr: "ignore" } },
  ])
  expect(host.sessions).toEqual([
    { name: TERMINAL, user: idOf(name), cwd: "/workspace", env: envOf(name) },
  ])
  expect(host.released()).toBe(1)
})

test.each(["start", "provision", "session"] as const)("a failure in %s logs its stage without error text", async (stage) => {
  const lines: Array<Line> = []
  const fault = Effect.fail(new TypeError("error-content-sentinel"))
  const host = container(() => stage === "provision" ? fault : Effect.succeed(0), () => stage === "session" ? fault : Effect.void)
  expect(await run(sessionOn({
    ...host, start: stage === "start" ? fault : Effect.void, touch: Effect.void, timeoutMs: 60_000,
  })(TERMINAL, "person-content-sentinel"), lines)).toBe(false)
  expect(sessionLine(lines, "WARN")).toMatchObject({ stage, outcome: "failed", [`${stage}Ms`]: 0, errorCode: "unknown", errorName: "TypeError" })
  expect(host.commands).toHaveLength(stage === "start" ? 0 : 1)
  expect(host.released()).toBe(host.commands.length)
})

test.each(["start", "touch", "exec", "session"] as const)("the whole deadline also bounds a stuck %s", async (stage) => {
  const lines: Array<Line> = []
  const host = container(() => Effect.succeed(0), () => Effect.never)
  const box = stage === "exec" ? { exec: () => Effect.never } : host.box
  await run(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(sessionOn({
      ...host, box, start: stage === "start" ? Effect.never : Effect.void,
      touch: stage === "touch" ? Effect.never : Effect.void, timeoutMs: 7000,
    })(TERMINAL, "person-content-sentinel"))
    yield* TestClock.adjust("7 seconds")
    expect(yield* Fiber.join(fiber)).toBe(false)
  }), lines)
  expect(sessionLine(lines, "WARN")).toMatchObject({
    stage: stage === "exec" ? "provision" : stage === "touch" ? "start" : stage,
    [`${stage === "exec" ? "provision" : stage === "touch" ? "start" : stage}Ms`]: 7000,
    outcome: "timeout", errorCode: "TimeoutError",
  })
  expect(host.released()).toBe(host.commands.length)
}, 2_000)

test("nonzero provisioning fails visibly and never creates a tmux session", async () => {
  const lines: Array<Line> = []
  const host = container(() => Effect.succeed(1))
  expect(await run(sessionOn({ ...host, start: Effect.void, touch: Effect.void, timeoutMs: 60_000 })(TERMINAL, "p"), lines)).toBe(false)
  expect(sessionLine(lines, "WARN")).toMatchObject({ stage: "provision", outcome: "failed", errorCode: "@smthrs/mvp/branch/SandboxUnavailable" })
  expect(host.commands).toHaveLength(1)
  expect(host.sessions).toHaveLength(0)
})

test("the deadline is shared by all stages and does not expire early", async () => {
  const lines: Array<Line> = []
  const host = container(() => Effect.as(Effect.sleep("4 seconds"), 0), () => Effect.never)
  await run(Effect.gen(function* () {
    const done = yield* Deferred.make<boolean>()
    const fiber = yield* Effect.forkChild(sessionOn({
      ...host, start: Effect.sleep("2 seconds"), touch: Effect.void, timeoutMs: 7000,
    })(TERMINAL, "p").pipe(Effect.tap((value) => Deferred.succeed(done, value))))
    yield* TestClock.adjust(6999)
    expect(yield* Deferred.isDone(done)).toBe(false)
    yield* TestClock.adjust(1)
    expect(yield* Fiber.join(fiber)).toBe(false)
  }), lines)
  expect(sessionLine(lines, "WARN")).toEqual({
    stage: "session", outcome: "timeout", startMs: 2000, provisionMs: 4000, sessionMs: 1000,
    errorCode: "TimeoutError", errorName: "TimeoutError",
  })
  expect(host.released()).toBe(1)
}, 2_000)

test("cancelling a session releases its provision process without reporting started", async () => {
  const lines: Array<Line> = []
  const host = container(() => Effect.never)
  await run(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(sessionOn({ ...host, start: Effect.void, touch: Effect.void, timeoutMs: 60_000 })(TERMINAL, "p"))
    yield* TestClock.adjust(0)
    expect(host.commands).toHaveLength(1)
    yield* Fiber.interrupt(fiber)
  }), lines)
  expect(host.released()).toBe(1)
  expect(lines.filter((line) => line.annotations.outcome === "started")).toHaveLength(0)
})

test("a defect is recorded and the next call has fresh stage times", async () => {
  const lines: Array<Line> = []
  let attempts = 0
  const host = container()
  const session = sessionOn({
    ...host,
    start: Effect.suspend(() => attempts++ === 0 ? Effect.die("error-content-sentinel") : Effect.void),
    touch: Effect.void, timeoutMs: 60_000,
  })
  expect(await run(session(TERMINAL, "p"), lines)).toBe(false)
  expect(sessionLine(lines, "WARN")).toEqual({ stage: "start", outcome: "failed", startMs: 0, errorCode: "unknown", errorName: "string" })
  lines.length = 0
  expect(await run(session(TERMINAL, "p"), lines)).toBe(true)
  expect(sessionLine(lines, "INFO")).toEqual({ outcome: "started", startMs: 0, provisionMs: 0, sessionMs: 0 })
})

test("initialization captures the deadline once before later session requests", async () => {
  const lines: Array<Line> = []
  const host = container(() => Effect.never)
  let activeAt: number | undefined
  await run(Effect.gen(function* () {
    const configured = yield* configuredSessionOn.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ SANDBOX_SESSION_TIMEOUT_SECONDS: "7" })),
    )
    const session = configured({
      ...host,
      start: Effect.void,
      touch: Effect.map(Clock.currentTimeMillis, (now) => void (activeAt = now)),
    })
    // The caller's config cannot replace the deadline captured at initialization.
    const fiber = yield* Effect.forkChild(session(TERMINAL, "person-content-sentinel").pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ SANDBOX_SESSION_TIMEOUT_SECONDS: "999" })),
    ))
    yield* TestClock.adjust("7 seconds")
    expect(yield* Fiber.join(fiber)).toBe(false)
    expect(activeAt).toBe(0)
    expect(host.released()).toBe(1)
    expect(host.sessions).toHaveLength(0)
  }), lines)
  expect(sessionLine(lines, "WARN")).toMatchObject({ stage: "provision", outcome: "timeout" })
}, 2_000)

test("a command refuses an unknown user before launching a process", async () => {
  const host = container()
  expect(Exit.isFailure(Effect.runSyncExit(asUser("unknown-user")))).toBe(true)
  await expect(Effect.runPromise(runOn(host.box, ["true"], "unknown-user"))).rejects.toThrow("the machine has no uid for this user")
  expect(host.commands).toHaveLength(0)
})

/**
 * An injected container that answers as `alchemy dev`'s does (workerd over Docker): a process with a piped stream
 * nobody reads never reports its exit. On 2026-10-22 every first provision of a person's user hung there, because
 * `useradd` warns on stderr that the person's uid is outside UID_MIN..UID_MAX.
 */
const unreadPipesHold = (): Container => ({
  exec: (_argv, options) =>
    Effect.succeed({
      exitCode: options.stdout === "ignore" && options.stderr === "ignore" ? Effect.succeed(0) : Effect.never,
    }),
})

test("a command whose output nobody reads still answers its exit: its streams are never piped", async () => {
  const exit = await Effect.runPromise(
    runOn(unreadPipesHold(), provisionArgv(userOf("person")), "root").pipe(Effect.timeout("2 seconds")),
  )
  expect(exit).toBe(0)
})
