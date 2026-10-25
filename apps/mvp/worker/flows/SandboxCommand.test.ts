// A command as its `sandbox/Command` job (worker/flows/SandboxCommand.ts, docs/features/sandbox-tools.md#long-commands),
// on the Durable Object's handlers (worker/ExecutionHost.ts): every execution is an object with its own in-memory
// storage and alarm, routed to the others as Cloudflare routes them, over the compose Postgres (`pnpm db:up`). The
// branch's machine is a real box: a scratch checkout whose commands are real processes (worker/test/box.ts), standing in
// for the container, so a command really runs detached and really outlives the host that started it.
//
// The fault is the production one of 2026-10-22: the host driving the run dies while the command runs (Cloudflare ends
// an alarm at 15 minutes of wall time). Here the alarm in progress, or the first one to start, while the command runs is
// interrupted, and the next alarm is a new incarnation, as on Cloudflare.
import * as Pg from "@effect/sql-pg"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { SandboxTools } from "@smthrs/sandbox"
import { Cause, ConfigProvider, Context, type Duration, Effect, Exit, Fiber, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { commandMaxSeconds } from "../../src/features/sandbox/config.ts"
import { callExecutionId, COMMAND_LIMIT_SECONDS } from "../../src/features/sandbox/contract.ts"
import { Machines } from "../branch/Machines.ts"
import { userOf } from "../branch/Users.ts"
import { SandboxBranch } from "../branch/Sandboxes.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as Box from "../test/box.ts"
import { resetBranches, tracked } from "../test/branch.ts"
import { testFile } from "../test/harness.ts"
import * as SandboxCall from "./SandboxCall.ts"
import * as SandboxCommand from "./SandboxCommand.ts"

const runtime = testFile("sandbox_command")
beforeEach(() => resetBranches(runtime))

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-command-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const REPO = "github/octocat/spoon-knife"
const OWNER = "person-owner"

let boxes = 0
/** A fresh machine: an empty checkout and the homes its users' calls live in. */
const machine = () => {
  const workdir = join(root, `box-${++boxes}`)
  mkdirSync(workdir)
  return Box.boxAt({ workdir, homes: join(root, `homes-${boxes}`) })
}

/** A tracked branch with a `running` run call of `OWNER`: what `POST /api/sandbox/calls` starts `sandbox/Call` for. */
const running = async () => {
  const { branchId } = await tracked(runtime, REPO, `b-${crypto.randomUUID().slice(0, 8)}`)
  const callId = crypto.randomUUID()
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`INSERT INTO sandbox_calls (id, branch_id, person_id, tool) VALUES (${callId}, ${branchId}, ${OWNER}, 'run')`))
  const branch: SandboxBranch = { branchId, owner: "octocat", name: "Spoon-Knife", branch: "test-branch" }
  return { callId, branch }
}

/** Call `callId`'s row as Postgres holds it. */
const row = (callId: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly status: string; readonly failure: string | null; readonly result: unknown; readonly generation: string | null }>`
      SELECT status, failure, result, generation::text AS generation FROM sandbox_calls WHERE id = ${callId}`))
    .then((rows) => rows[0]!)

/** Waits until `ready` holds, checking every 10 ms. */
const until = (ready: () => boolean) =>
  Effect.gen(function* () {
    while (!ready()) yield* Effect.sleep("10 millis")
  })

/** What a test starts an object with: an execution's intent, as `ExecutionHost.intent` makes one. */
type Intent = Effect.Success<ReturnType<typeof ExecutionHost.intent>>

/** One execution's Durable Object: its alarm, and its handlers. */
interface DurableObject {
  readonly alarm: { at: number }
  readonly host: {
    readonly start: (intent: Intent) => Effect.Effect<unknown, unknown>
    readonly wake: () => Effect.Effect<unknown, unknown>
    readonly alarm: () => Effect.Effect<unknown, unknown>
  }
}

/**
 * The Durable Objects of one deployment over an engine schema of the compose Postgres: an object per execution, each
 * with its own storage and alarm, routed to one another as Cloudflare routes them, all running `flows`.
 */
const deployment = <ROut, E, R>(url: string, schema: string, flows: ExecutionHost.Flows<ROut, E, R>) => {
  const objects = new Map<string, DurableObject>()
  const objectOf = (executionId: string): DurableObject => {
    const found = objects.get(executionId)
    if (found !== undefined) return found
    const values = new Map<string, unknown>()
    const alarm = { at: 0 }
    const storage: ExecutionHost.Storage = {
      get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
      put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
      delete: (key) => Effect.sync(() => values.delete(key)),
      setAlarm: (at) => Effect.sync(() => void (alarm.at = at)),
      deleteAlarm: () => Effect.sync(() => void (alarm.at = 0)),
    }
    const host = ExecutionHost.make(storage, {
      hostId: `object-${executionId}`,
      database: ExecutionHost.database(url, schema),
      flows,
      router: {
        start: (intent) => Effect.suspend(() => objectOf(intent.executionId).host.start(intent)),
        wake: (id) => Effect.suspend(() => objectOf(id).host.wake()),
      },
    })
    // What the registration needs beyond the engine's own services, each alarm's runtime provides, as on Cloudflare.
    const object: DurableObject = { alarm, host: host as unknown as DurableObject["host"] }
    objects.set(executionId, object)
    return object
  }
  /**
   * Runs the objects' alarms in the order they come due until `done` holds. `dies` says when the host dies: the alarm in
   * progress when it first holds, or the first alarm to start while it does, is interrupted, once.
   */
  const drive = (done: () => Effect.Effect<boolean>, dies: () => boolean) =>
    Effect.gen(function* () {
      let killed = 0
      for (let alarms = 0; !(yield* done()); alarms++) {
        if (alarms > 500) return yield* Effect.die("the deployment never finished")
        // A settled object's alarm is its retention's end, far off: only alarms due within a minute are work.
        const due = [...objects.values()].filter((object) => object.alarm.at > 0 && object.alarm.at < Date.now() + 60_000)
          .sort((a, b) => a.alarm.at - b.alarm.at)[0]
        if (due === undefined) return yield* Effect.die("nothing is due and the deployment isn't done")
        yield* Effect.sleep(Math.max(0, due.alarm.at - Date.now()))
        const alarm = yield* Effect.forkChild(due.host.alarm())
        if (killed > 0) {
          yield* Fiber.join(alarm)
          continue
        }
        const first = yield* Effect.raceFirst(
          Effect.as(Fiber.join(alarm), "done" as const),
          Effect.as(until(dies), "dies" as const),
        )
        if (first === "dies") {
          yield* Fiber.interrupt(alarm)
          killed++
        }
      }
      return killed
    })
  return { objectOf, drive }
}

/** Runs `body` with a fresh engine schema of the compose Postgres, dropped after; `status` reads a run's status there. */
const withEngine = <A, E>(
  body: (url: string, schema: string, status: (executionId: string) => Effect.Effect<string | undefined>) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const url = (yield* TestDatabase.serverUrl).toString()
    const admin = yield* Layer.build(Pg.PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))
    const sql = Context.get(admin, SqlClient.SqlClient)
    const schema = `flows_${crypto.randomUUID().replaceAll("-", "")}`
    yield* Effect.addFinalizer(() => Effect.orDie(sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`))
    const status = (executionId: string) =>
      Effect.orDie(sql<{ readonly status: string }>`
        SELECT status FROM ${sql(schema)}.flows_runs WHERE run_id = ${executionId}`).pipe(
        Effect.map((rows) => rows[0]?.status),
        // The schema exists once the first alarm migrated it.
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
    return yield* body(url, schema, status)
  })))

const database = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))

/** `sandbox/Call`'s flows, the command job's among them, on a deployment whose machine is `box`. */
const sandboxTools = async (box: ReturnType<typeof machine>) =>
  ExecutionHost.withSandboxTools(
    { flows: [], registration: Layer.empty },
    await database(),
    Layer.succeed(Machines, Box.machinesOn(box.box)),
  )

/** Starts `sandbox/Call` for `started`'s call of `command` on `objects`, as `POST /api/sandbox/calls` does. */
const startCall = (
  objects: ReturnType<typeof deployment>,
  started: Awaited<ReturnType<typeof running>>,
  command: string,
) =>
  Effect.gen(function* () {
    const executionId = callExecutionId(started.callId)
    const intent = yield* ExecutionHost.intent(SandboxCall.SandboxCall, {
      executionId,
      payload: { callId: started.callId, ownerId: OWNER, branch: started.branch, call: { tool: "run", command } },
    })
    yield* objects.objectOf(executionId).host.start(intent)
  })

/** Whether call `callId` settled. */
const settled = (callId: string) => () => Effect.promise(() => row(callId).then((found) => found.status !== "running"))

describe("a run call on a host that dies mid-command", { timeout: 120_000 }, () => {
  test("the command runs once, outlives the host driving it, and the call settles done with its result", async () => {
    const box = machine()
    const started = await running()
    const flows = await sandboxTools(box)
    const marker = (name: string) => existsSync(join(box.workdir, name))
    const killed = await withEngine((url, schema) =>
      Effect.gen(function* () {
        const objects = deployment(url, schema, flows)
        yield* startCall(objects, started, "echo ran >> runs.log; touch started; sleep 2; touch finished; echo done-$((2+3))")
        return yield* objects.drive(settled(started.callId), () => marker("started") && !marker("finished"))
      })
    )
    expect(killed).toBe(1)
    expect(await row(started.callId)).toEqual({
      status: "done",
      failure: null,
      result: {
        tool: "run",
        exitCode: 0,
        timedOut: false,
        stdout: "done-5\n",
        stderr: "",
        stdoutBytes: 7,
        stderrBytes: 0,
        truncated: false,
      },
      generation: null,
    })
    expect(readFileSync(join(box.workdir, "runs.log"), "utf8")).toBe("ran\n")
    // The command was started once, under its job's key, in the person's own home.
    expect(readdirSync(join(box.homes, userOf(OWNER), ".smithers", "calls"))).toEqual([
      expect.stringMatching(/^command-[0-9A-Za-z._-]+_23g1$/),
    ])
  })

  test("a command whose machine stopped is lost: the call settles lost, and nothing starts it again", async () => {
    const box = machine()
    const started = await running()
    const flows = await sandboxTools(box)
    await withEngine((url, schema) =>
      Effect.gen(function* () {
        const objects = deployment(url, schema, flows)
        yield* startCall(objects, started, "echo ran >> runs.log; touch started; sleep 3")
        yield* objects.drive(() => Effect.sync(() => existsSync(join(box.workdir, "started"))), () => false)
        // The machine stops: its next generation's disk holds nothing of the command.
        box.state.running = false
        yield* objects.drive(settled(started.callId), () => false)
      })
    )
    expect(await row(started.callId)).toMatchObject({ status: "failed", failure: "lost", result: null })
    expect(readFileSync(join(box.workdir, "runs.log"), "utf8")).toBe("ran\n")
  })
})

// The TODO agent's `sandbox/run` tool runs its command with `SandboxCommand.run` from inside a step of the run that asks
// (worker/flows/TodoAgent.ts). This step does the same, so the job is a child the step's execution waits on.
const RunIt = Action.make("probe/RunIt", {
  payload: { callId: Schema.String, branch: SandboxBranch, command: Schema.String },
  success: Schema.String,
})
const RunCommand = Flow.make("probe/RunCommand", {
  payload: RunIt.payloadSchema,
  success: Schema.String,
  body: Node.capture({ run: RunIt.name }, (payload) => RunIt.call(payload)),
})

describe("a command a run's own step runs, on a host that dies mid-command", { timeout: 120_000 }, () => {
  /**
   * `RunCommand` and the sandbox flows on `box`, the step running its command through `SandboxCommand.run` with `wait`,
   * and the run of `command` on that host, whose alarm is cut off once the command started and before it finished.
   */
  const killedMidCommand = async (wait: Duration.Input, command: string) => {
    const box = machine()
    const branch: SandboxBranch = { branchId: "b-probe", owner: "octocat", name: "Spoon-Knife", branch: "test-branch" }
    const sandbox = await sandboxTools(box)
    const machines = Box.machinesOn(box.box)
    const flows = {
      flows: [...sandbox.flows, RunCommand],
      registration: Layer.mergeAll(
        sandbox.registration,
        Interpreter.layerWithImplementations(
          RunCommand,
          RunIt.toLayer(({ branch, callId, command }) =>
            SandboxCommand.run(machines, { branch, ownerId: OWNER }, callId, { tool: "run", command }, wait).pipe(
              Effect.orDie,
              Effect.flatMap((result) =>
                result.stdout === "done-5\n" ? Effect.succeed(result.stdout) : Effect.die(`read ${result.stdout}`)
              ),
            )
          ),
        ).pipe(Layer.provideMerge(Action.layerImplementations)),
      ),
    }
    const marker = (name: string) => existsSync(join(box.workdir, name))
    const executionId = `probe-${crypto.randomUUID()}`
    const callId = crypto.randomUUID()
    const outcome = await withEngine((url, schema, status) =>
      Effect.gen(function* () {
        const objects = deployment(url, schema, flows)
        const payload = { callId, branch, command }
        yield* objects.objectOf(executionId).host.start(yield* ExecutionHost.intent(RunCommand, { executionId, payload }))
        const killed = yield* objects.drive(
          () => Effect.map(status(executionId), (found) => found === "completed" || found === "failed"),
          () => marker("started") && !marker("finished"),
        )
        return {
          killed,
          status: yield* status(executionId),
          job: yield* status(SandboxCommand.commandExecutionId(callId)),
        }
      })
    )
    return { outcome, runs: readFileSync(join(box.workdir, "runs.log"), "utf8") }
  }

  test("a command that ends within the step's wait runs once in the step, which reads its output", async () => {
    expect(SandboxCommand.stepWait({ tool: "run", command: "true", timeoutSeconds: 600 })).toBe(615_000)
    const { outcome, runs } = await killedMidCommand(
      SandboxCommand.stepWait({ tool: "run", command: "sleep 2" }),
      "echo ran >> runs.log; touch started; sleep 2; touch finished; echo done-$((2+3))",
    )
    // The step completed only if it read `done-5`: anything else died. No job execution was made.
    expect(outcome).toEqual({ killed: 1, status: "completed", job: undefined })
    expect(runs).toBe("ran\n")
  })

  test("a longer one goes on as its job, which runs it once, and the step's run parks until it ends", async () => {
    const { outcome, runs } = await killedMidCommand(
      "1 second",
      "echo ran >> runs.log; sleep 2; touch started; sleep 2; touch finished; echo done-$((2+3))",
    )
    expect(outcome).toEqual({ killed: 1, status: "completed", job: "completed" })
    expect(runs).toBe("ran\n")
  })
})

describe("SandboxCommand.run", () => {
  test("names a call's job after the call, and outside a flow runtime runs nothing", async () => {
    expect(SandboxCommand.commandExecutionId("c-1")).toBe("sandbox-command:c-1")
    const box = machine()
    const exit = await Effect.runPromiseExit(
      SandboxCommand.run(
        Box.machinesOn(box.box),
        { branch: { branchId: "b", owner: "o", name: "n", branch: "main" }, ownerId: OWNER },
        "c-1",
        { tool: "run", command: "touch ran" },
      ),
    )
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(new SandboxCommand.NoRun())
    expect(existsSync(join(box.workdir, "ran"))).toBe(false)
  })
})

describe("how long a command runs", () => {
  /** `SANDBOX_COMMAND_MAX_SECONDS` read from `env`, as the hosts read it: the limit, or why it was refused. */
  const limitOf = (env: Record<string, string>) =>
    Effect.runSync(Effect.exit(commandMaxSeconds.parse(ConfigProvider.fromUnknown(env))))

  test("SANDBOX_COMMAND_MAX_SECONDS is an hour unless set, and any whole number of seconds from 60 to an hour", () => {
    expect(COMMAND_LIMIT_SECONDS).toBe(3600)
    expect(limitOf({})).toEqual(Exit.succeed(3600))
    expect(limitOf({ SANDBOX_COMMAND_MAX_SECONDS: "1200" })).toEqual(Exit.succeed(1200))
    expect(limitOf({ SANDBOX_COMMAND_MAX_SECONDS: "60" })).toEqual(Exit.succeed(60))
    expect(limitOf({ SANDBOX_COMMAND_MAX_SECONDS: "3600" })).toEqual(Exit.succeed(3600))
    // An empty setting is an unset one.
    expect(limitOf({ SANDBOX_COMMAND_MAX_SECONDS: "" })).toEqual(Exit.succeed(3600))
    // Under 60, a command that names no timeout would outrun it; past an hour, the job's own limit and deadline.
    expect(SandboxTools.limits.defaultTimeoutSeconds).toBe(60)
    for (const invalid of ["59", "3601", "0", "-5", "1.5", "an hour"]) {
      const exit = limitOf({ SANDBOX_COMMAND_MAX_SECONDS: invalid })
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause), invalid).toMatchObject({ _tag: "ConfigError" })
    }
  })

  test("SANDBOX_COMMAND_STEP_WAIT_SECONDS is an hour unless set, any whole number of seconds from 0, and caps the step's wait", () => {
    const waitOf = (env: Record<string, string>) =>
      Effect.runSync(Effect.exit(SandboxCommand.stepWaitSeconds.parse(ConfigProvider.fromUnknown(env))))
    expect(waitOf({})).toEqual(Exit.succeed(3600))
    expect(waitOf({ SANDBOX_COMMAND_STEP_WAIT_SECONDS: "0" })).toEqual(Exit.succeed(0))
    expect(waitOf({ SANDBOX_COMMAND_STEP_WAIT_SECONDS: "120" })).toEqual(Exit.succeed(120))
    expect(waitOf({ SANDBOX_COMMAND_STEP_WAIT_SECONDS: "" })).toEqual(Exit.succeed(3600))
    for (const invalid of ["-1", "3601", "1.5", "a minute"]) {
      const exit = waitOf({ SANDBOX_COMMAND_STEP_WAIT_SECONDS: invalid })
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause), invalid).toMatchObject({ _tag: "ConfigError" })
    }
    // A step waits as long as its command may run and stop, at most the cap; 0 sends every command to its job.
    const call = { tool: "run" as const, command: "pnpm install", timeoutSeconds: 600 }
    expect(SandboxCommand.stepWait(call)).toBe(615_000)
    expect(SandboxCommand.stepWait(call, 120)).toBe(120_000)
    expect(SandboxCommand.stepWait({ tool: "run", command: "true" }, 3600)).toBe(75_000)
    expect(SandboxCommand.stepWait(call, 0)).toBe(0)
  })

  test("the job takes a command up to an hour, past SandboxTools' 600 s, and refuses one past it", () => {
    const payload = (timeoutSeconds: number) => ({
      target: { branch: { branchId: "b", owner: "o", name: "n", branch: "main" }, ownerId: OWNER, callId: "c" },
      call: { tool: "run" as const, command: "pnpm install", timeoutSeconds },
    })
    const takes = Schema.is(SandboxCommand.Command.payloadSchema)
    expect([600, 601, 1200, COMMAND_LIMIT_SECONDS].map((seconds) => takes(payload(seconds)))).toEqual([true, true, true, true])
    expect(takes(payload(COMMAND_LIMIT_SECONDS + 1))).toBe(false)
  })

  test("a tool call takes a run up to the limit it is given, and every other tool as SandboxTools does", () => {
    const takes = (limit: number) => Schema.is(SandboxCommand.ToolCall(limit))
    const run = (timeoutSeconds: number) => ({ tool: "run", command: "pnpm install", timeoutSeconds })
    expect(takes(COMMAND_LIMIT_SECONDS)(run(1200))).toBe(true)
    expect(takes(900)(run(900))).toBe(true)
    expect(takes(900)(run(901))).toBe(false)
    expect(takes(900)({ tool: "read", path: "README.md" })).toBe(true)
    expect(takes(900)({ tool: "status" })).toBe(true)
    expect(takes(900)({ tool: "format-disk" })).toBe(false)
  })
})
