// The `todo` run's agent's parts (worker/flows/TodoAgent.ts) without the engine: its task text, its one seat, and the
// sandbox tools bound to the attempt's machine. The machine and the run's identity are test services on the seams the
// tools read (`Machines`, `FlowRuntime.FlowInstance`); worker/flows/Todo.test.ts runs the same tools in a real run.
import { SeatResolver } from "@smthrs/agent"
import { FlowRuntime } from "@smthrs/flow"
import { Cell } from "@smthrs/harness"
import { Model } from "@smthrs/model"
import type { SandboxTools } from "@smthrs/sandbox"
import { Duration, Effect, Option, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { COMMAND_LIMIT_SECONDS } from "../../src/features/sandbox/contract.ts"
import { Machines } from "../branch/Machines.ts"
import { noCommands } from "../test/commands.ts"
import type { Seat } from "../ModelEndpoint.ts"
import * as TodoAgent from "./TodoAgent.ts"
import * as TodoMachine from "./TodoMachine.ts"

const ATTEMPT = "6f0e2b9c-1d4a-4c3b-9e8f-7a6b5c4d3e2f"

/** The attempt's base commit, which its machine checks out. */
const BASE = "0f".repeat(20)

const MACHINE = TodoMachine.machineOf({ attemptId: ATTEMPT, repoId: "github/octo/hello", checkout: BASE, ownerId: "maya" })

/** A machine that answers each call with `answer`, and the calls it took. */
const machine = (answer: (call: SandboxTools.Call) => ReturnType<Machines["Service"]["tool"]>) => {
  const calls: Array<{ readonly branch: string; readonly ownerId: string; readonly callId: string; readonly call: SandboxTools.Call }> = []
  const service = Machines.of({
    commands: () => noCommands,
    tool: (branch, ownerId, callId, call) =>
      Effect.suspend(() => {
        calls.push({ branch: branch.branch, ownerId, callId, call })
        return answer(call)
      }),
    sleepIfIdle: () => Effect.die("the tools never put a machine to sleep"),
  })
  return { calls, service }
}

/** A call of tool `name` with `input`, as the cell's harness makes one. */
const callOf = (name: string, input: unknown) =>
  new Cell.Call({
    flowName: name,
    input: input as never,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none(),
    identity: new Cell.CallIdentity({ session: "s", frame: 2, cell: "c", ordinal: 1, declaration: "d", layers: [] }),
  })

/** The run a tool call belongs to: only its execution id is read. */
const run = (executionId: string) => ({ executionId }) as unknown as FlowRuntime.FlowInstance["Service"]

/** The tool `name` bound over `service` and `resolve`, its commands running up to `commandSeconds`. */
const bound = <E>(
  service: Machines["Service"],
  resolve: (executionId: string) => Effect.Effect<Option.Option<TodoMachine.TodoMachine>, E>,
  name: string,
  commandSeconds = COMMAND_LIMIT_SECONDS,
) => TodoAgent.machineBindings(service, resolve, commandSeconds).find((found) => found.descriptor.name === name)!

/**
 * Calls tool `name` bound over `service` and `resolve`, its commands running up to `commandSeconds`, inside execution
 * `executionId`, or outside any run (`null`).
 */
const call = <E>(
  service: Machines["Service"],
  resolve: (executionId: string) => Effect.Effect<Option.Option<TodoMachine.TodoMachine>, E>,
  name: string,
  input: unknown,
  executionId: string | null = `todo:${ATTEMPT}`,
  commandSeconds = COMMAND_LIMIT_SECONDS,
) => {
  const binding = bound(service, resolve, name, commandSeconds)
  const ran = binding.run(callOf(name, input))
  return Effect.runPromise(
    executionId === null ? ran : ran.pipe(Effect.provideService(FlowRuntime.FlowInstance, run(executionId))),
  )
}

describe("the agent's task", () => {
  test("names the TODO and its prompt, and lists what done means when the TODO says", () => {
    const payload = {
      attemptId: ATTEMPT,
      todoId: "t",
      repoId: "github/octo/hello",
      number: 4,
      title: "Add a line",
      prompt: "Add a line to the README.",
      acceptance: [],
      branch: "smithers/t4-add-a-line",
    }
    expect(TodoAgent.promptOf(payload)).toBe("TODO T4: Add a line\n\nAdd a line to the README.")
    expect(TodoAgent.promptOf({ ...payload, acceptance: ["README has the line", "tests pass"] })).toBe(
      "TODO T4: Add a line\n\nAdd a line to the README.\n\nDone when:\n- README has the line\n- tests pass",
    )
  })
})

describe("the agent's seat", () => {
  const seat: Seat = {
    model: Model.make({ stream: () => Stream.die("unused") }),
    route: { prepare: () => Effect.die("unused") } as unknown as Seat["route"],
  }
  const resolve = (id: string) =>
    Effect.flatMap(SeatResolver.SeatResolver, (resolver) => resolver.resolve(id)).pipe(
      Effect.provide(TodoAgent.seats(seat)),
      Effect.exit,
      Effect.runPromise,
    )

  test("is the agent role, over the endpoint's model, with the browser agent's window", async () => {
    const resolved = await resolve(TodoAgent.AGENT_SEAT)
    expect(resolved._tag === "Success" && [resolved.value.id, resolved.value.model, resolved.value.contextWindowTokens])
      .toEqual(["agent", seat.model, TodoAgent.CONTEXT_WINDOW_TOKENS])
  })

  test("any other seat is unresolved", async () => {
    const resolved = await resolve("judge")
    expect(resolved._tag === "Failure" && String(resolved.cause)).toContain("The todo run has one seat, agent.")
  })
})

describe("the sandbox tools on the attempt's machine", () => {
  const found = () => Effect.succeed(Option.some(MACHINE))

  test("a call runs on the attempt's machine as its committer, once per call identity, and answers the tool's result", async () => {
    const box = machine(() =>
      Effect.succeed({ result: { tool: "read", path: "A.md", content: "a\n", bytes: 2, truncated: false }, generation: 1 })
    )
    const resolved: Array<string> = []
    const answered = await call(box.service, (executionId) => {
      resolved.push(executionId)
      return found()
    }, "sandbox/read", { path: "A.md" })
    expect(answered).toMatchObject({ outcome: "success", value: { tool: "read", path: "A.md", content: "a\n" } })
    expect(resolved).toEqual([`todo:${ATTEMPT}`])
    const callId = await Effect.runPromise(TodoAgent.callIdOf({ session: "s", frame: 2, cell: "c", ordinal: 1 }))
    expect(box.calls).toEqual([{ branch: BASE, ownerId: "maya", callId, call: { path: "A.md", tool: "read" } }])
  })

  test("outside a run, or for a run with no machine, nothing runs; a lookup that fails is unavailable", async () => {
    const box = machine(() => Effect.die("never called"))
    expect(await call(box.service, found, "sandbox/status", {}, null)).toMatchObject({
      outcome: "failure",
      message: "Flow sandbox/status failed: no_run",
    })
    expect(await call(box.service, () => Effect.succeed(Option.none()), "sandbox/status", {})).toMatchObject({
      outcome: "failure",
      message: "Flow sandbox/status failed: no_machine",
    })
    expect(await call(box.service, () => Effect.fail("postgres down"), "sandbox/status", {})).toMatchObject({
      outcome: "failure",
      message: "Flow sandbox/status failed: unavailable",
    })
    expect(box.calls).toEqual([])
  })

  test("the machine's refusal reaches the agent as its reason, and any other failure as its kind", async () => {
    const refused = machine(() =>
      Effect.fail({ _tag: "@smthrs/sandbox/SandboxTools/ToolRefused", reason: "not_found" } as never)
    )
    expect(await call(refused.service, found, "sandbox/read", { path: "NOPE.md" })).toMatchObject({
      outcome: "failure",
      message: "Flow sandbox/read failed: not_found",
    })
    const down = machine(() => Effect.fail({ _tag: "@smthrs/mvp/branch/SandboxUnavailable" } as never))
    expect(await call(down.service, found, "sandbox/status", {})).toMatchObject({
      outcome: "failure",
      message: "Flow sandbox/status failed: @smthrs/mvp/branch/SandboxUnavailable",
    })
  })

  test("the agent reads a failure as a refusal's reason, a lost command as ToolLost however it was lost, else its tag", () => {
    expect(TodoAgent.failedAs({ _tag: "@smthrs/sandbox/SandboxTools/ToolRefused", reason: "path" } as never)).toEqual(
      new TodoAgent.ToolFailed({ reason: "path" }),
    )
    expect(TodoAgent.failedAs({ _tag: "@smthrs/flow/ExternalJobLost" })).toEqual(
      new TodoAgent.ToolFailed({ reason: "@smthrs/sandbox/SandboxTools/ToolLost" }),
    )
    expect(TodoAgent.failedAs({ _tag: "@smthrs/flow/ExternalJobTimedOut" })).toEqual(
      new TodoAgent.ToolFailed({ reason: "@smthrs/flow/ExternalJobTimedOut" }),
    )
  })

  test("the run tool takes a command up to the deployment's limit, past SandboxTools' 600 s, and says the limit", async () => {
    const box = machine(() => Effect.die("a command never runs as a tool call"))
    const asked = (timeoutSeconds: number, commandSeconds?: number) =>
      call(box.service, found, "sandbox/run", { command: "pnpm install", timeoutSeconds }, undefined, commandSeconds)
    // A command the tool takes runs as its job, which needs a run: here there is none, so it gets that far and stops.
    const taken = { outcome: "failure", message: "Flow sandbox/run failed: @smthrs/mvp/sandbox/NoRun" }
    expect(await asked(1200)).toMatchObject(taken)
    expect(await asked(COMMAND_LIMIT_SECONDS)).toMatchObject(taken)
    expect(await asked(COMMAND_LIMIT_SECONDS + 1)).toMatchObject({ outcome: "failure", code: "invalid_input" })
    expect(await asked(900, 900)).toMatchObject(taken)
    expect(await asked(901, 900)).toMatchObject({ outcome: "failure", code: "invalid_input" })
    expect(bound(box.service, found, "sandbox/run").descriptor.description).toContain(
      `60 unless set, ${COMMAND_LIMIT_SECONDS} at most`,
    )
    expect(bound(box.service, found, "sandbox/run", 900).descriptor.description).toContain("60 unless set, 900 at most")
    expect(box.calls).toEqual([])
  })

  test("the agent's attempt has room for an hour's command beside its own 40 minutes: 100 minutes", () => {
    expect(Duration.toMinutes(TodoAgent.IMPLEMENT_TIMEOUT)).toBe(100)
  })

  test("a command runs as its own job of the run that asks: with no flow runtime to run it in, nothing runs", async () => {
    const box = machine(() => Effect.die("a command never runs as a tool call"))
    expect(await call(box.service, found, "sandbox/run", { command: "true" })).toMatchObject({
      outcome: "failure",
      message: "Flow sandbox/run failed: @smthrs/mvp/sandbox/NoRun",
    })
    expect(box.calls).toEqual([])
  })
})
