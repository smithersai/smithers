// The branches' machines' contract (worker/branch/Machines.ts): how a tool call's and a command operation's plain
// outcomes, as they cross a Durable Object's RPC, become the typed answers the flows read.
import { SandboxTools } from "@smthrs/sandbox"
import { Effect, Exit } from "effect"
import { describe, expect, test } from "vitest"
import { type CommandOutcome, type CommandRequest, commandsOver, ranOf } from "./Machines.ts"
import { CheckoutFailed, SandboxStartTimedOut, SandboxUnavailable } from "./Sandboxes.ts"

const result = { tool: "read", path: "a", content: "a", bytes: 1, truncated: false } as const
const ran = {
  tool: "run",
  exitCode: 0,
  timedOut: false,
  stdout: "",
  stderr: "",
  stdoutBytes: 0,
  stderrBytes: 0,
  truncated: false,
} as const

describe("ranOf", () => {
  test("a done call is the tool's result on its generation; each failure is its typed error", async () => {
    expect(await Effect.runPromise(ranOf({ _tag: "Done", result, generation: 4 }))).toEqual({ result, generation: 4 })
    const failure = (outcome: Parameters<typeof ranOf>[0]) => Effect.runPromise(Effect.flip(ranOf(outcome)))
    expect(await failure({ _tag: "Refused", reason: "not_found" })).toEqual(
      new SandboxTools.ToolRefused({ reason: "not_found" }),
    )
    expect(await failure({ _tag: "Lost" })).toEqual(new SandboxTools.ToolLost())
    expect(await failure({ _tag: "CheckoutFailed" })).toEqual(new CheckoutFailed())
    expect(await failure({ _tag: "Unavailable", reason: "start_timeout" })).toEqual(new SandboxStartTimedOut())
    expect(await failure({ _tag: "Unavailable" })).toEqual(new SandboxUnavailable({ reason: "exec" }))
    // No machine free under the sandbox limits (worker/branch/Budget.ts): the step tries again.
    expect(await failure({ _tag: "Waiting" })).toEqual(new SandboxUnavailable({ reason: "waiting" }))
  })
})

describe("commandsOver", () => {
  /** Commands whose machine answers every request with `outcome`, and the requests and woken generations it saw. */
  const over = (outcome: CommandOutcome, callId?: string) => {
    const requests: Array<CommandRequest> = []
    const woken: Array<number> = []
    const commands = commandsOver(
      (request) => Effect.sync(() => (requests.push(request), outcome)),
      (generation) => Effect.sync(() => void woken.push(generation)),
      callId,
    )
    return { commands, requests, woken }
  }
  const call = { tool: "run", command: "true" } as const

  test("each operation asks the machine by key and answers its own outcome; a start's generation is woken", async () => {
    const start = over({ _tag: "Started", started: { pid: 9, startedAt: 1 }, generation: 3 })
    expect(await Effect.runPromise(start.commands.start(call, "k"))).toEqual({ pid: 9, startedAt: 1 })
    expect(start.requests).toEqual([{ op: "start", key: "k", call }])
    expect(start.woken).toEqual([3])

    // A start names the tool call the commands are for, when there is one.
    const named = over({ _tag: "Started", started: { pid: 9, startedAt: 1 }, generation: 3 }, "call-1")
    await Effect.runPromise(named.commands.start(call, "k"))
    expect(named.requests).toEqual([{ op: "start", key: "k", call, callId: "call-1" }])

    const observe = over({ _tag: "Observed", observed: { state: "running", pid: 9 } })
    expect(await Effect.runPromise(observe.commands.observe("k"))).toEqual({ state: "running", pid: 9 })
    expect(observe.requests).toEqual([{ op: "observe", key: "k" }])

    const collect = over({ _tag: "Collected", result: ran })
    expect(await Effect.runPromise(collect.commands.collect("k"))).toEqual(ran)

    const cancel = over({ _tag: "Cancelled" })
    expect(Exit.isSuccess(await Effect.runPromiseExit(cancel.commands.cancel("k")))).toBe(true)
    expect(cancel.requests).toEqual([{ op: "cancel", key: "k" }])
  })

  test("an outcome that isn't the operation's own is its typed failure, and wakes nothing", async () => {
    const failure = async (outcome: CommandOutcome) => {
      const machine = over(outcome)
      const error = await Effect.runPromise(Effect.flip(machine.commands.start(call, "k")))
      expect(machine.woken).toEqual([])
      return error
    }
    expect(await failure({ _tag: "Refused", reason: "path" })).toEqual(new SandboxTools.ToolRefused({ reason: "path" }))
    expect(await failure({ _tag: "Lost" })).toEqual(new SandboxTools.ToolLost())
    expect(await failure({ _tag: "CheckoutFailed" })).toEqual(new CheckoutFailed())
    expect(await failure({ _tag: "Unavailable", reason: "start_timeout" })).toEqual(new SandboxStartTimedOut())
    expect(await failure({ _tag: "Unavailable" })).toEqual(new SandboxUnavailable({ reason: "exec" }))
    expect(await failure({ _tag: "Waiting" })).toEqual(new SandboxUnavailable({ reason: "waiting" }))
    expect(await failure({ _tag: "ToolUnavailable", code: "unavailable" })).toEqual(
      new SandboxTools.ToolUnavailable({ code: "unavailable" }),
    )
    expect(await failure({ _tag: "ToolUnavailable", code: "unknown", exitCode: 125 })).toEqual(
      new SandboxTools.ToolUnavailable({ code: "unknown", exitCode: 125 }),
    )
    // A machine that answered another operation's outcome couldn't answer this one.
    expect(await failure({ _tag: "Cancelled" })).toEqual(new SandboxUnavailable({ reason: "exec" }))
    for (const operation of ["observe", "collect", "cancel"] as const) {
      const machine = over({ _tag: "Started", started: { pid: 1, startedAt: 1 }, generation: 1 })
      expect(await Effect.runPromise(Effect.flip(machine.commands[operation]("k")))).toEqual(
        new SandboxUnavailable({ reason: "exec" }),
      )
    }
  })
})
