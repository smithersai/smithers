// `sandbox/Call` (worker/flows/SandboxCall.ts, docs/features/sandbox-tools.md#the-remote-flow) on the Node host
// (worker/test/flowHost.ts) and as its steps alone, over this file's schema of the compose Postgres (`pnpm db:up`). The
// branch's machine is a test `Machines`, standing in for the Cloudflare `SandboxObject` (worker/BranchSandboxes.ts),
// whose real container the e2e suite drives; the tools themselves run on real processes in @smthrs/sandbox's tests.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { ExternalJob, Sleep } from "@smthrs/flow"
import { type SandboxCommand, SandboxTools } from "@smthrs/sandbox"
import { Cause, Effect, Exit, Layer, Logger, Metric, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { COMMAND_LIMIT_SECONDS } from "../../src/features/sandbox/contract.ts"
import { type MachineFailure, Machines } from "../branch/Machines.vibe"
import { CheckoutFailed, type SandboxBranch, SandboxStartTimedOut, SandboxUnavailable } from "../branch/Sandboxes.vibe"
import { resetBranches, tracked } from "../test/branch.ts"
import { instantCommands } from "../test/commands.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as SandboxCall from "./SandboxCall.ts"
import * as SandboxCommandJob from "./SandboxCommand.ts"

const runtime = testFile("sandbox_call")
beforeEach(() => resetBranches(runtime))

const REPO = "github/octocat/spoon-knife"
const OWNER = "person-owner"
const SENTINEL = "sentinel-9a1f04"

type Tool = Machines["Service"]["tool"]

const ran = {
  tool: "run",
  exitCode: 1,
  timedOut: false,
  stdout: SENTINEL,
  stderr: "",
  stdoutBytes: SENTINEL.length,
  stderrBytes: 0,
  truncated: false,
} as const

/**
 * A branch's machine that answers each tool call from its script, in order, recording every call. Its commands finish
 * as they start, with exit code `exitCode`, unless `commands` is set.
 */
const machine = (
  answers: ReadonlyArray<ReturnType<Tool>>,
  commands: SandboxCommand.Commands<MachineFailure> = instantCommands(() => 0),
) => {
  const calls: Array<string> = []
  let called = 0
  const service = Machines.of({
    commands: () => commands,
    tool: (branch, ownerId, callId, call) =>
      Effect.suspend(() => {
        calls.push(`${branch.branchId} ${branch.owner}/${branch.name}@${branch.branch} ${ownerId} ${callId} ${call.tool}`)
        return answers[Math.min(called++, answers.length - 1)]!
      }),
    sleepIfIdle: () => Effect.die("sandbox/Call never puts a machine to sleep"),
  })
  return { calls, layer: Layer.succeed(Machines, service) }
}

/** A tracked branch with a `running` call of `OWNER`: what the flow is started for. */
const running = async (tool: SandboxTools.Tool = "run") => {
  const { branchId } = await tracked(runtime, REPO, `b-${crypto.randomUUID().slice(0, 8)}`)
  const callId = crypto.randomUUID()
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`INSERT INTO sandbox_calls (id, branch_id, person_id, tool) VALUES (${callId}, ${branchId}, ${OWNER}, ${tool})`))
  const branch: SandboxBranch = { branchId, owner: "octocat", name: "Spoon-Knife", branch: "test-branch" }
  return { branchId, callId, branch }
}

/** Call `callId`'s row as Postgres holds it. */
const row = (callId: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{
      readonly status: string
      readonly failure: string | null
      readonly result: unknown
      readonly generation: string | null
      readonly settled: boolean
    }>`
      SELECT status, failure, result, generation::text AS generation, settled_at IS NOT NULL AS settled
      FROM sandbox_calls WHERE id = ${callId}`)).then((rows) => rows[0]!)

const database = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))

const read = { tool: "read", path: "README.md" } as const
const readResult = { tool: "read", path: "README.md", content: SENTINEL, bytes: SENTINEL.length, truncated: false } as const

const run = async (
  started: Awaited<ReturnType<typeof running>>,
  machines: ReturnType<typeof machine>,
  call: typeof SandboxCall.SandboxCall.payloadSchema.Type["call"] = read,
) =>
  runFlow(
    SandboxCall.SandboxCall,
    { callId: started.callId, ownerId: OWNER, branch: started.branch, call },
    Layer.mergeAll(SandboxCall.registration(await database()), SandboxCommandJob.registration).pipe(
      Layer.provide(machines.layer),
    ),
  )

describe("sandbox/Call on the Node host", () => {
  test("runs the tool on the branch's machine as its owner and settles the call done with the result", async () => {
    const started = await running("read")
    const machines = machine([Effect.succeed({ result: readResult, generation: 3 })])
    const exit = await run(started, machines)

    expect(exit.exit).toEqual(Exit.succeed({ settled: true }))
    expect(exit.status).toBe("completed")
    expect(machines.calls).toEqual([
      `${started.branchId} octocat/Spoon-Knife@test-branch ${OWNER} ${started.callId} read`,
    ])
    expect(await row(started.callId)).toEqual({
      status: "done",
      failure: null,
      result: readResult,
      generation: "3",
      settled: true,
    })
  })

  test("a command runs as its own sandbox/Command job: started once, collected, and the call settles done", async () => {
    const started = await running()
    const commands: Array<string> = []
    const machines = machine([], instantCommands(() => 1, (key, call) => void commands.push(`${key} ${call.command}`)))
    const exit = await run(started, machines, { tool: "run", command: `echo ${SENTINEL}` })

    expect(exit.exit).toEqual(Exit.succeed({ settled: true }))
    // No tool step ran the command; its job started it once, by the job's key.
    expect(machines.calls).toEqual([])
    expect(commands).toEqual([expect.stringMatching(new RegExp(`#g1 echo ${SENTINEL}$`))])
    expect(await row(started.callId)).toEqual({
      status: "done",
      failure: null,
      result: { ...ran, stdout: "", stdoutBytes: 0 },
      generation: null,
      settled: true,
    })
  })

  test("a command past SandboxTools' 600 s, up to an hour, runs as its job; a tool step never takes one", async () => {
    const started = await running()
    const timeouts: Array<number | undefined> = []
    const machines = machine([], instantCommands(() => 0, (_key, call) => void timeouts.push(call.timeoutSeconds)))
    const exit = await run(started, machines, { tool: "run", command: "pnpm install", timeoutSeconds: 1200 })

    expect(exit.exit).toEqual(Exit.succeed({ settled: true }))
    expect(timeouts).toEqual([1200])
    expect(machines.calls).toEqual([])
    expect((await row(started.callId)).status).toBe("done")
    const call = (timeoutSeconds: number) => ({
      callId: started.callId,
      ownerId: OWNER,
      branch: started.branch,
      call: { tool: "run" as const, command: "pnpm install", timeoutSeconds },
    })
    expect(Schema.is(SandboxCall.SandboxCall.payloadSchema)(call(COMMAND_LIMIT_SECONDS))).toBe(true)
    expect(Schema.is(SandboxCall.SandboxCall.payloadSchema)(call(COMMAND_LIMIT_SECONDS + 1))).toBe(false)
    // The tool step, which holds the run while it runs, still stops at 600 s.
    expect(Schema.is(SandboxCall.Tool.payloadSchema)(call(600))).toBe(true)
    expect(Schema.is(SandboxCall.Tool.payloadSchema)(call(601))).toBe(false)
  })

  test("a command its machine lost settles lost; one the machine refused settles with why", async () => {
    const lostCall = await running()
    const lost = machine([], { ...instantCommands(() => 0), observe: () => Effect.succeed({ state: "lost" }) })
    expect((await run(lostCall, lost, { tool: "run", command: "true" })).exit).toEqual(Exit.succeed({ settled: true }))
    expect(await row(lostCall.callId)).toMatchObject({ status: "failed", failure: "lost" })

    const refusedCall = await running()
    const refused = machine([], {
      ...instantCommands(() => 0),
      start: () => Effect.fail(new SandboxTools.ToolRefused({ reason: "path" })),
    })
    expect((await run(refusedCall, refused, { tool: "run", command: "true" })).exit).toEqual(
      Exit.succeed({ settled: true }),
    )
    expect(await row(refusedCall.callId)).toMatchObject({ status: "failed", failure: "path" })
  }, 30_000)

  test("a machine that can't answer yet is asked again, and the call runs once it does", async () => {
    const started = await running("read")
    const machines = machine([
      Effect.fail(new SandboxUnavailable({ reason: "exec" })),
      Effect.succeed({ result: readResult, generation: 1 }),
    ])
    const exit = await run(started, machines)

    expect(exit.exit).toEqual(Exit.succeed({ settled: true }))
    expect(machines.calls).toHaveLength(2)
    expect(await row(started.callId)).toMatchObject({ status: "done", generation: "1" })
  }, 30_000)

  test.each<[string, ReturnType<Tool>, string]>([
    ["path", Effect.fail(new SandboxTools.ToolRefused({ reason: "path" })), "path"],
    ["not_found", Effect.fail(new SandboxTools.ToolRefused({ reason: "not_found" })), "not_found"],
    ["too_large", Effect.fail(new SandboxTools.ToolRefused({ reason: "too_large" })), "too_large"],
    ["a lost command", Effect.fail(new SandboxTools.ToolLost()), "lost"],
    ["a refused checkout", Effect.fail(new CheckoutFailed()), "checkout"],
    // The machine's start ran past SANDBOX_START_TIMEOUT_SECONDS: the call settles, never left `running`.
    ["a start that timed out", Effect.fail(new SandboxStartTimedOut()), "start_timeout"],
  ])("%s isn't retried: the call settles failed with why", async (_, answer, failure) => {
    const started = await running("read")
    const machines = machine([answer])
    const exit = await run(started, machines, { tool: "read", path: "README.md" })

    expect(exit.exit).toEqual(Exit.succeed({ settled: true }))
    expect(machines.calls).toHaveLength(1)
    expect(await row(started.callId)).toEqual({ status: "failed", failure, result: null, generation: null, settled: true })
  })

  test("a call no longer running is left as it is", async () => {
    const started = await running("read")
    await runtime.runPromise(SandboxCall.settle(started.callId, { status: "failed", failure: "lost" }))
    const exit = await run(started, machine([Effect.succeed({ result: readResult, generation: 9 })]))

    expect(exit.exit).toEqual(Exit.succeed({ settled: false }))
    expect(await row(started.callId)).toMatchObject({ status: "failed", failure: "lost", result: null })
  })
})

/** Runs `effect` with a logger and metric registry of its own: its exit, log lines and the calls it counted. */
const observed = async <A, E>(effect: Effect.Effect<A, E>) => {
  const lines: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const logger = Logger.make((options) => void lines.push(StructuredLogger.formatStructured.log(options)))
  const registry: Metric.MetricRegistry = new Map()
  const exit = await Effect.runPromiseExit(
    effect.pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
    ),
  )
  const counted = (tool: string, outcome: string) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(SandboxCall.calls, { tool, outcome })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    ).count
  return { exit, lines, counted }
}

describe("the steps", () => {
  test("tool answers the done outcome, and logs a failure by its code, never the call's content", async () => {
    const steps = SandboxCall.steps(await database())
    const branch: SandboxBranch = { branchId: "b-1", owner: "octocat", name: "Spoon-Knife", branch: "main" }
    const call = { tool: "run", command: `echo ${SENTINEL}` } as const
    const done = await observed(
      steps.tool({ branch, ownerId: OWNER, callId: crypto.randomUUID(), call }).pipe(
        Effect.provide(machine([Effect.succeed({ result: ran, generation: 2 })]).layer),
      ),
    )
    expect(done.exit).toEqual(Exit.succeed({ status: "done", result: ran, generation: 2 }))
    expect(done.lines).toEqual([])

    const lost = await observed(
      steps.tool({ branch, ownerId: OWNER, callId: "c-1", call }).pipe(
        Effect.provide(machine([Effect.fail(new SandboxTools.ToolLost())]).layer),
      ),
    )
    expect(Exit.isFailure(lost.exit) && Cause.squash(lost.exit.cause)).toEqual(new SandboxTools.ToolLost())
    expect(lost.lines).toMatchObject([
      {
        message: "sandbox.tool",
        level: "WARN",
        annotations: { callId: "c-1", branchId: "b-1", tool: "run", errorCode: "@smthrs/sandbox/SandboxTools/ToolLost" },
      },
    ])
    expect(JSON.stringify(lost.lines)).not.toContain(SENTINEL)
  })

  test("failed names the failure: a refusal's reason, lost, checkout, start_timeout, else unavailable", async () => {
    const steps = SandboxCall.steps(await database())
    const failed = (error: Parameters<typeof steps.failed>[0]["error"]) => Effect.runPromise(steps.failed({ error }))
    expect(await failed(new SandboxTools.ToolRefused({ reason: "not_a_directory" }))).toEqual({
      status: "failed",
      failure: "not_a_directory",
    })
    expect(await failed(new SandboxTools.ToolLost())).toEqual({ status: "failed", failure: "lost" })
    expect(await failed(new CheckoutFailed())).toEqual({ status: "failed", failure: "checkout" })
    expect(await failed(new SandboxStartTimedOut())).toEqual({ status: "failed", failure: "start_timeout" })
    for (const reason of ["start", "exec"] as const) {
      expect(await failed(new SandboxUnavailable({ reason }))).toEqual({ status: "failed", failure: "unavailable" })
    }
    // A command job's own failures: lost once its replacements are spent, else unavailable.
    expect(await failed(new ExternalJob.ExternalJobLost({ key: "k", message: "m" }))).toEqual({
      status: "failed",
      failure: "lost",
    })
    for (
      const error of [
        new ExternalJob.ExternalJobTimedOut({ key: "k", message: "m" }),
        new SandboxTools.ToolUnavailable({ code: "unknown" }),
        new Sleep.SleepRequestInvalid({ code: "missing_deadline", message: "m" }),
      ]
    ) {
      expect(await failed(error)).toEqual({ status: "failed", failure: "unavailable" })
    }
  })

  test("record counts and logs a call it settled, with a command's exit code; one it didn't, it only logs", async () => {
    const steps = SandboxCall.steps(await database())
    const done = await running()
    const settled = await observed(
      steps.record({ callId: done.callId, tool: "run", outcome: { status: "done", result: ran, generation: 1 } }),
    )
    expect(settled.exit).toEqual(Exit.succeed({ settled: true }))
    expect(settled.counted("run", "done")).toBe(1)
    expect(settled.lines).toMatchObject([
      {
        message: "sandbox.call",
        level: "INFO",
        annotations: { callId: done.callId, tool: "run", outcome: "done", settled: true, exitCode: 1, timedOut: false },
      },
    ])
    expect(JSON.stringify(settled.lines)).not.toContain(SENTINEL)

    const read = await running("read")
    const result = { tool: "read", path: "a", content: SENTINEL, bytes: 1, truncated: false } as const
    const other = await observed(
      steps.record({ callId: read.callId, tool: "read", outcome: { status: "done", result, generation: 1 } }),
    )
    expect(other.lines[0]!.annotations).not.toHaveProperty("exitCode")

    const failing = await running("diff")
    const refused = await observed(
      steps.record({ callId: failing.callId, tool: "diff", outcome: { status: "failed", failure: "not_a_repository" } }),
    )
    expect(refused.counted("diff", "not_a_repository")).toBe(1)
    expect(refused.lines).toMatchObject([
      { message: "sandbox.call", level: "WARN", annotations: { outcome: "not_a_repository", settled: true } },
    ])

    // The same outcome again finds the call settled: nothing counted, the line says so.
    const again = await observed(
      steps.record({ callId: failing.callId, tool: "diff", outcome: { status: "failed", failure: "not_a_repository" } }),
    )
    expect(again.exit).toEqual(Exit.succeed({ settled: false }))
    expect(again.counted("diff", "not_a_repository")).toBe(0)
    expect(again.lines).toMatchObject([{ message: "sandbox.call", annotations: { settled: false } }])
  })

  test("record fails as SettleUnavailable when Postgres can't be reached, for the engine to retry", async () => {
    const steps = SandboxCall.steps(Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("connection refused"))))
    const exit = await Effect.runPromiseExit(
      steps.record({ callId: crypto.randomUUID(), tool: "run", outcome: { status: "failed", failure: "lost" } }),
    )
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(SandboxCall.SettleUnavailable)
  })
})
