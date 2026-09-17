import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import { Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import * as DemoScript from "../src/DemoScript.ts"
import * as Driver from "../src/Driver.ts"
import * as ScriptedDriver from "../src/ScriptedDriver.ts"
import { run, until } from "./Harness.ts"

const input: Driver.StartInput = { sessionID: "ses_test", messageID: "msg_test", prompt: "hello" }

const recorder = () => {
  const events: Array<AgentEvent.AgentEvent> = []
  const outcomes: Array<Driver.Outcome> = []
  const sink: Driver.Sink = {
    event: (event) => Effect.sync(() => void events.push(event)),
    closed: (outcome) => Effect.sync(() => void outcomes.push(outcome))
  }
  return { events, outcomes, sink }
}

const driver = (delay = 0) => ScriptedDriver.make({ script: DemoScript.script, delay })

describe("ScriptedDriver", () => {
  it("plays the script up to the park, then the allowed continuation on once", async () => {
    const log = recorder()
    const result = await run(
      Effect.gen(function*() {
        const scripted = yield* driver()
        yield* scripted.start(input, log.sink)
        const parked = log.outcomes[0]
        const tags = log.events.map((event) => event._tag)
        const permissionID = (log.events.find((event) => event._tag === "permission-required") as
          | AgentEvent.PermissionRequired
          | undefined)?.request.requestId
        const busy = yield* Effect.flip(scripted.start(input, log.sink))
        const steered = yield* scripted.steer("ses_test", "also this")
        const notSteered = yield* scripted.steer("ses_other", "nothing")
        const wrong = yield* Effect.flip(
          scripted.permission({ sessionID: "ses_test", permissionID: "per_nope", response: "once" })
        )
        const unknown = yield* Effect.flip(
          scripted.permission({ sessionID: "ses_other", permissionID: "x", response: "once" })
        )
        yield* scripted.permission({ sessionID: "ses_test", permissionID: permissionID!, response: "once" })
        yield* scripted.resumeOnBoot(() => Effect.succeed(log.sink))
        return { parked, tags, busy, steered, notSteered, wrong, unknown }
      })
    )
    expect(result.parked).toEqual({ _tag: "suspended" })
    expect(result.tags.slice(-2)).toEqual(["permission-required", "suspended"])
    expect(result.busy.code).toBe("busy")
    expect(result.steered).toBe(true)
    expect(result.notSteered).toBe(false)
    expect(result.wrong.code).toBe("unknown_permission")
    expect(result.unknown.code).toBe("unknown_session")
    await until(async () => log.outcomes.length === 2)
    expect(log.outcomes[1]).toEqual({ _tag: "completed" })
    expect(log.events.map((event) => event._tag).filter((tag) => tag === "resolved")).toEqual(["resolved"])
    const bash = log.events.filter((event) => event._tag === "cell-call-settled" && event.flowName === "bash")
    expect(bash.length).toBe(1)
    expect((bash[0] as AgentEvent.CellCallSettled).result.outcome).toBe("success")
  })

  it("plays the rejected continuation on reject, and a new turn after the end", async () => {
    const log = recorder()
    await run(
      Effect.gen(function*() {
        const scripted = yield* driver()
        yield* scripted.start(input, log.sink)
        const permission = log.events.find((event) =>
          event._tag === "permission-required"
        ) as AgentEvent.PermissionRequired
        yield* scripted.permission({
          sessionID: "ses_test",
          permissionID: permission.request.requestId,
          response: "reject"
        })
        yield* Effect.promise(() => until(async () => log.outcomes.length === 2))
        // The turn ended; the session is free again.
        yield* scripted.start(input, log.sink)
      })
    )
    const bash = log.events.filter((event) => event._tag === "cell-call-settled" && event.flowName === "bash")
    expect((bash[0] as AgentEvent.CellCallSettled).result.outcome).toBe("failure")
    expect(log.outcomes.map((outcome) => outcome._tag)).toEqual(["suspended", "completed", "suspended"])
  })

  it("interrupts a running turn and a parked one", async () => {
    const running = recorder()
    const parked = recorder()
    const result = await run(
      Effect.gen(function*() {
        const scripted = yield* driver(5)
        const fiber = yield* Effect.forkChild(scripted.start(input, running.sink))
        yield* Effect.promise(() => until(async () => running.events.length > 2))
        const interrupted = yield* scripted.interrupt("ses_test")
        yield* Fiber.join(fiber)
        const none = yield* scripted.interrupt("ses_test")

        const instant = yield* driver()
        yield* instant.start({ ...input, sessionID: "ses_parked" }, parked.sink)
        const parkedInterrupted = yield* instant.interrupt("ses_parked")
        return { interrupted, none, parkedInterrupted }
      })
    )
    expect(result).toEqual({ interrupted: true, none: false, parkedInterrupted: true })
    expect(running.outcomes).toEqual([{ _tag: "interrupted" }])
    expect(parked.outcomes).toEqual([{ _tag: "suspended" }, { _tag: "interrupted" }])
  })

  it("accepts a fixed script and answers a permission inside a plain segment as unknown", async () => {
    const log = recorder()
    const script: ScriptedDriver.Script = { segments: [{ _tag: "events", events: [] }] }
    const result = await run(
      Effect.gen(function*() {
        const scripted = yield* ScriptedDriver.make({ script, delay: 0 })
        yield* scripted.start(input, log.sink)
        return yield* Effect.gen(function*() {
          const service = yield* Driver.Driver
          return typeof service.start
        }).pipe(Effect.provide(ScriptedDriver.layer({ script })))
      })
    )
    expect(result).toBe("function")
    expect(log.outcomes).toEqual([{ _tag: "completed" }])
  })
})
