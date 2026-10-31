// The branches' machines' contract (worker/branch/Machines.ts): how a tool call's and a command operation's plain
// outcomes, as they cross a Durable Object's RPC, become the typed answers the flows read.
import { SandboxTools } from "@smthrs/sandbox"
import { Effect, Exit } from "effect"
import { describe, expect, test } from "vitest"
import {
  type CommandOutcome,
  type CommandRequest,
  commandsOver,
  type MachineObject,
  ranOf,
  routed,
  type SleepOutcome,
  type ToolOutcome,
} from "./Machines.ts"
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

describe("routed", () => {
  const call = { tool: "run", command: "true" } as const
  const branch = (machine?: string) => ({
    branchId: "job-1",
    owner: "acme",
    name: "widgets",
    branch: "a".repeat(40),
    kind: "job" as const,
    ...(machine === undefined ? {} : { machine }),
  })

  /** The deployment's machines: the default one and `gate`, each recording what reached it, and the keeps started. */
  const deployment = (answers: {
    readonly tool?: ToolOutcome
    readonly command?: CommandOutcome
    readonly sleep?: SleepOutcome | "unavailable"
  } = {}) => {
    const reached: Array<string> = []
    const kept: Array<[string, number, string | undefined]> = []
    const object = (name: string): MachineObject => ({
      tool: (target, _owner, _callId, _call) =>
        Effect.sync(() => (reached.push(`${name}:tool:${target.branchId}`), answers.tool ?? { _tag: "Done", result, generation: 2 })),
      command: (target, _owner, request) =>
        Effect.sync(() => (
          reached.push(`${name}:${request.op}:${target.branchId}`),
          answers.command ?? { _tag: "Started", started: { pid: 1, startedAt: 1 }, generation: 5 }
        )),
      sleepIfIdle: (generation) => Effect.sync(() => (reached.push(`${name}:sleep:${generation}`), answers.sleep ?? "slept")),
    })
    const objects: Record<string, MachineObject> = { default: object("default"), gate: object("gate") }
    const machines = routed(
      (_branchId, machine) => objects[machine ?? "default"],
      (branchId, generation, machine) => Effect.sync(() => void kept.push([branchId, generation, machine])),
    )
    return { machines, reached, kept }
  }

  test("each call reaches the object of the branch's machine, and its keep names the machine", async () => {
    const { machines, reached, kept } = deployment()
    expect(await Effect.runPromise(machines.tool(branch(), "ci", "c-1", call))).toEqual({ result, generation: 2 })
    expect(await Effect.runPromise(machines.tool(branch("gate"), "ci", "c-2", call))).toEqual({ result, generation: 2 })
    await Effect.runPromise(machines.commands(branch("gate"), "ci").start(call, "k"))
    expect(await Effect.runPromise(machines.sleepIfIdle("job-1", 2, 0, "gate"))).toBe("slept")
    expect(await Effect.runPromise(machines.sleepIfIdle("job-1", 2, 0))).toBe("slept")
    expect(reached).toEqual(["default:tool:job-1", "gate:tool:job-1", "gate:start:job-1", "gate:sleep:2", "default:sleep:2"])
    expect(kept).toEqual([["job-1", 2, undefined], ["job-1", 2, "gate"], ["job-1", 5, "gate"]])
  })

  test("a call that didn't run starts no keep; a machine that can't answer a sleep is unavailable", async () => {
    const { machines, kept } = deployment({ tool: { _tag: "Lost" }, sleep: "unavailable" })
    expect(await Effect.runPromise(Effect.flip(machines.tool(branch("gate"), "ci", "c-1", call)))).toEqual(
      new SandboxTools.ToolLost(),
    )
    expect(await Effect.runPromise(Effect.flip(machines.sleepIfIdle("job-1", 2, 0, "gate")))).toEqual(
      new SandboxUnavailable({ reason: "exec" }),
    )
    expect(kept).toEqual([])
  })

  test("a machine the deployment didn't declare wakes nothing: every call fails undeclared", async () => {
    const { machines, reached, kept } = deployment()
    const undeclared = new SandboxUnavailable({ reason: "undeclared" })
    expect(await Effect.runPromise(Effect.flip(machines.tool(branch("gpu"), "ci", "c-1", call)))).toEqual(undeclared)
    const commands = machines.commands(branch("gpu"), "ci")
    expect(await Effect.runPromise(Effect.flip(commands.start(call, "k")))).toEqual(undeclared)
    expect(await Effect.runPromise(Effect.flip(commands.observe("k")))).toEqual(undeclared)
    expect(await Effect.runPromise(Effect.flip(commands.collect("k")))).toEqual(undeclared)
    expect(await Effect.runPromise(Effect.flip(commands.cancel("k")))).toEqual(undeclared)
    expect(await Effect.runPromise(Effect.flip(machines.sleepIfIdle("job-1", 2, 0, "gpu")))).toEqual(undeclared)
    expect(reached).toEqual([])
    expect(kept).toEqual([])
  })
})
