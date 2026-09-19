import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as AgentEvents from "@smthrs/harness/AgentEvent"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Option } from "effect"
import * as SqlError from "effect/unstable/sql/SqlError"
import { afterAll, describe, expect, it } from "vitest"
import * as DemoScript from "../src/DemoScript.ts"
import * as Driver from "../src/Driver.ts"
import * as Events from "../src/Events.ts"
import * as Health from "../src/Health.ts"
import * as Ids from "../src/Ids.ts"
import * as Protocol from "../src/Protocol.ts"
import * as ScriptedDriver from "../src/ScriptedDriver.ts"
import * as Store from "../src/Store.ts"
import * as Turns from "../src/Turns.ts"
import { run, scratchDirectory, until } from "./Harness.ts"

const scratch = scratchDirectory()
afterAll(() => scratch.remove())

const session = (id: string): Protocol.Session => ({
  id,
  slug: "quiet-harbor",
  projectID: "p",
  directory: scratch.directory,
  path: "",
  title: "New session - now",
  version: "test",
  agent: "smithers",
  model: { id: "demo", providerID: "scripted" },
  cost: 0,
  tokens: Protocol.noTokens,
  time: { created: 1, updated: 1 }
})

const options: Turns.Options = {
  directory: scratch.directory,
  agent: "smithers",
  model: { providerID: "scripted", modelID: "demo" }
}

const stack = (driver: Layer.Layer<Driver.Driver>, file: string) => {
  const store = Store.layerSqlite(`${scratch.directory}/${file}.sqlite`)
  const hub = Events.layer({ directory: scratch.directory, project: "p" })
  return Layer.mergeAll(Turns.layer(options), store, hub).pipe(
    Layer.provideMerge(Layer.mergeAll(driver, store, hub, Evaluator.layerUnavailable()))
  )
}

const scripted = ScriptedDriver.layer({ script: DemoScript.script, delay: 0 })

/** A driver whose every operation fails or misbehaves, for the error paths. */
const broken = (behaviour: "start-fails" | "closes-early" | "reports-failure"): Layer.Layer<Driver.Driver> =>
  Layer.succeed(Driver.Driver, {
    start: (_input, sink) =>
      behaviour === "start-fails"
        ? Effect.fail(new Driver.DriverError({ code: "engine_failed", message: "no engine" }))
        : behaviour === "reports-failure"
        ? sink.closed({ _tag: "failed", message: "the body threw" })
        : Effect.gen(function*() {
          yield* sink.closed({ _tag: "completed" })
          // Anything after the end is ignored.
          yield* sink.closed({ _tag: "interrupted" })
          yield* sink.event(new AgentEvents.Aborted({ eventType: "flows.harness.aborted.v1", reason: "late" }))
        }),
    interrupt: () => Effect.succeed(false),
    permission: () => Effect.fail(new Driver.DriverError({ code: "engine_failed", message: "no engine" })),
    steer: () => Effect.succeed(false),
    resumeOnBoot: () => Effect.void
  })

describe("Turns", () => {
  it("runs a prompt through the scripted driver, stores every part, and answers the permission", async () => {
    const result = await run(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        const hub = yield* Events.Events
        yield* store.putSession(session("ses_1"))
        const unknown = yield* Effect.flip(
          turns.prompt({ sessionID: "ses_missing", parts: [{ type: "text", text: "x" }] })
        )
        const empty = yield* Effect.flip(turns.prompt({ sessionID: "ses_1", parts: [{ type: "file" }] }))
        yield* turns.prompt({
          sessionID: "ses_1",
          messageID: "msg_0000000000010000000000000u",
          agent: "smithers",
          model: { providerID: "scripted", modelID: "demo" },
          parts: [{ type: "text", text: "Read package.json" }]
        })
        yield* Effect.promise(() =>
          until(() => Effect.runPromise(Effect.map(store.listPermissions("ses_1"), (list) => list.length === 1)))
        )
        const busy = yield* turns.status()
        // A prompt while busy is stored and steered, not started.
        yield* turns.prompt({ sessionID: "ses_1", parts: [{ type: "text", text: "and also this" }] })
        const pending = yield* store.listPermissions("ses_1")
        const wrongPermission = yield* Effect.flip(
          turns.permission({ sessionID: "ses_1", permissionID: "per_nope", response: "once" })
        )
        yield* turns.permission({ sessionID: "ses_1", permissionID: pending[0]!.id, response: "once" })
        // The answer ends the turn; the resumed frame's health decision may
        // land just after it, so the history is read once both are stored.
        yield* Effect.promise(() =>
          until(() =>
            Effect.runPromise(
              Effect.map(store.listMessages("ses_1"), (messages) =>
                messages.some((message) =>
                  message.info.role === "assistant" && message.info.finish === "stop" &&
                  message.parts.filter((part) => part.type === "tool" && part.tool === "health").length === 3
                ))
            )
          )
        )
        const messages = yield* store.listMessages("ses_1")
        const idle = yield* turns.status()
        const replayed = yield* hub.replay()
        const aborted = yield* turns.abort("ses_1")
        return { unknown, empty, busy, pending, wrongPermission, messages, idle, replayed, aborted }
      }).pipe(Effect.provide(stack(scripted, "turns")))
    )
    expect(result.unknown).toMatchObject({ code: "unknown_session" })
    expect(result.empty).toMatchObject({ code: "empty_prompt" })
    expect(result.busy).toEqual({ ses_1: { type: "busy" } })
    expect(result.pending.length).toBe(1)
    expect(result.wrongPermission).toMatchObject({ code: "unknown_permission" })
    expect(result.messages.map((message) => message.info.role)).toEqual(["user", "assistant", "user"])
    // Seven cards from the script, plus the health cards: frame zero's
    // settle (gray, no Jev key), the park (red), and the resumed frame's
    // settle (gray again), each under the frame that produced it.
    expect(
      result.messages[1]!.parts.flatMap((part) => part.type === "tool" ? [`${part.tool}:${part.state.status}`] : [])
    ).toEqual([
      "cell:completed",
      "read:completed",
      "list:completed",
      "classify:completed",
      "health:completed",
      "cell:completed",
      "bash:completed",
      "demand:completed",
      "health:completed",
      "health:completed"
    ])
    expect(result.idle).toEqual({})
    expect(result.replayed.map((envelope) => envelope.payload.type)).toContain("permission.replied")
    expect(result.aborted).toBe(false)
  })

  it("takes down a card a frame opened after the Stop, and asks again for an open card at boot", async () => {
    const park = new Permission.PermissionRequired({
      requestId: "per_late_1_deadbeef_0",
      runId: "msg_late",
      capability: Capability.make("proc:spawn", "bash"),
      tier: "irreversible",
      meta: { flow: "bash", input: { command: "ls -la" }, identity: { frame: 1, cell: "deadbeef", ordinal: 0 } }
    })
    /**
     * A driver whose frame parks a moment after the Stop: the request is
     * written after the abort has already swept, and its card would outlive
     * the turn. The engine driver does exactly this when a Stop lands on the
     * frame that then asks.
     */
    const late = Layer.succeed(Driver.Driver, {
      // The projection is open before the driver is forked, so a body that
      // has not reported anything yet is still a busy session.
      start: () => Effect.void,
      interrupt: (sessionID) =>
        Effect.gen(function*() {
          const sink = sinks.get(sessionID)!
          yield* sink.event(
            new AgentEvents.PermissionRequired({
              eventType: "flows.harness.permission-required.v1",
              request: park
            })
          )
          yield* sink.closed({ _tag: "interrupted" })
          return true
        }),
      permission: () => Effect.void,
      steer: () => Effect.succeed(false),
      resumeOnBoot: () => Effect.void
    })
    const sinks = new Map<string, Driver.Sink>()
    const remembering = Layer.effect(
      Driver.Driver,
      Effect.map(Driver.Driver, (driver) => ({
        ...driver,
        start: (input: Driver.StartInput, sink: Driver.Sink) => {
          sinks.set(input.sessionID, sink)
          return driver.start(input, sink)
        }
      }))
    ).pipe(Layer.provide(late))
    const result = await run(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        const hub = yield* Events.Events
        yield* store.putSession(session("ses_stopped"))
        yield* turns.prompt({ sessionID: "ses_stopped", parts: [{ type: "text", text: "run ls" }] })
        yield* Effect.promise(() =>
          until(() => Effect.runPromise(Effect.map(turns.status(), (status) => status["ses_stopped"] !== undefined)))
        )
        const before = (yield* hub.replay()).length
        const aborted = yield* turns.abort("ses_stopped")
        yield* Effect.promise(() =>
          until(() => Effect.runPromise(Effect.map(turns.status(), (status) => status["ses_stopped"] === undefined)))
        )
        return {
          aborted,
          left: yield* store.listPermissions("ses_stopped"),
          after: (yield* hub.replay()).slice(before).map((envelope) => envelope.payload)
        }
      }).pipe(Effect.provide(stack(remembering, "turns-stopped")))
    )
    expect(result.aborted).toBe(true)
    // The card the frame opened after the Stop is asked and then taken down:
    // a request left pending would keep a card on a session that reads idle.
    expect(result.after.map((event) => event.type)).toContain("permission.asked")
    expect(result.after.filter((event) => event.type === "permission.replied")).toMatchObject([{
      properties: { sessionID: "ses_stopped", requestID: park.requestId, reply: "reject" }
    }])
    expect(result.left).toEqual([])
  })

  it("logs a driver that refuses the answer to a card it asked for", async () => {
    const park = new Permission.PermissionRequired({
      requestId: "per_refused_1_feedface_0",
      runId: "msg_refused",
      capability: Capability.make("proc:spawn", "bash"),
      tier: "irreversible",
      meta: { flow: "bash", input: { command: "ls -la" }, identity: { frame: 1, cell: "feedface", ordinal: 0 } }
    })
    const asking = Layer.succeed(Driver.Driver, {
      start: (_input, sink) =>
        sink.event(
          new AgentEvents.PermissionRequired({ eventType: "flows.harness.permission-required.v1", request: park })
        ),
      interrupt: () => Effect.succeed(true),
      permission: () => Effect.fail(new Driver.DriverError({ code: "engine_failed", message: "no engine" })),
      steer: () => Effect.succeed(false),
      resumeOnBoot: () => Effect.void
    })
    const result = await run(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        yield* store.putSession(session("ses_refused"))
        yield* turns.prompt({ sessionID: "ses_refused", parts: [{ type: "text", text: "run ls" }] })
        yield* Effect.promise(() =>
          until(() => Effect.runPromise(Effect.map(store.listPermissions("ses_refused"), (list) => list.length === 1)))
        )
        const pending = yield* store.listPermissions("ses_refused")
        // The answer is taken and the row goes down; the driver's refusal is
        // logged, never thrown at the app.
        yield* turns.permission({ sessionID: "ses_refused", permissionID: pending[0]!.id, response: "once" })
        yield* Effect.sleep("50 millis")
        return { left: yield* store.listPermissions("ses_refused") }
      }).pipe(Effect.provide(stack(asking, "turns-refused")))
    )
    expect(result.left).toEqual([])
  })

  it("closes an interrupted turn with an aborted message", async () => {
    const result = await run(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        yield* store.putSession(session("ses_slow"))
        yield* turns.prompt({ sessionID: "ses_slow", parts: [{ type: "text", text: "go" }] })
        yield* Effect.promise(() =>
          until(() =>
            Effect.runPromise(
              Effect.map(store.listMessages("ses_slow"), (list) => (list[1]?.parts.length ?? 0) > 2)
            )
          )
        )
        yield* store.putPermission({
          id: "per_slow",
          sessionID: "ses_slow",
          permission: "bash",
          patterns: [],
          metadata: {},
          always: [],
          tool: { messageID: "m", callID: "c" }
        })
        const aborted = yield* turns.abort("ses_slow")
        const pending = yield* store.listPermissions("ses_slow")
        yield* Effect.promise(() =>
          until(() =>
            Effect.runPromise(
              Effect.map(
                store.listMessages("ses_slow"),
                (list) => list.some((message) => message.info.role === "assistant" && message.info.error !== undefined)
              )
            )
          )
        )
        const list = yield* store.listMessages("ses_slow")
        return {
          aborted,
          pending,
          error: (list[1]!.info as Protocol.AssistantMessage).error,
          tools: list[1]!.parts.filter((part): part is Protocol.ToolPart => part.type === "tool"),
          status: yield* turns.status()
        }
      }).pipe(
        Effect.provide(stack(ScriptedDriver.layer({ script: DemoScript.script, delay: "20 millis" }), "turns-slow"))
      )
    )
    expect(result.aborted).toBe(true)
    expect(result.pending).toEqual([])
    expect(result.error?.name).toBe("MessageAbortedError")
    // Stop leaves no card spinning: what was running reads as interrupted.
    expect(result.tools.length).toBeGreaterThan(0)
    expect(result.tools.every((part) => part.state.status !== "running")).toBe(true)
    expect(result.tools.some((part) => part.state.status === "error" && part.state.error === "interrupted")).toBe(true)
    expect(result.status).toEqual({})
  })

  it("aborts a parked turn: rejects the card, settles the cell, and goes idle on the stream", async () => {
    const result = await run(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        const hub = yield* Events.Events
        yield* store.putSession(session("ses_park"))
        yield* turns.prompt({ sessionID: "ses_park", parts: [{ type: "text", text: "run ls" }] })
        yield* Effect.promise(() =>
          until(() => Effect.runPromise(Effect.map(store.listPermissions("ses_park"), (list) => list.length === 1)))
        )
        const pending = yield* store.listPermissions("ses_park")
        const before = (yield* hub.replay()).length
        const aborted = yield* turns.abort("ses_park")
        yield* Effect.promise(() =>
          until(() =>
            Effect.runPromise(
              Effect.map(
                store.listMessages("ses_park"),
                (list) => list.some((message) => message.info.role === "assistant" && message.info.error !== undefined)
              )
            )
          )
        )
        const list = yield* store.listMessages("ses_park")
        return {
          aborted,
          request: pending[0]!,
          left: yield* store.listPermissions("ses_park"),
          status: yield* turns.status(),
          error: (list[1]!.info as Protocol.AssistantMessage).error,
          tools: list[1]!.parts.filter((part): part is Protocol.ToolPart => part.type === "tool"),
          after: (yield* hub.replay()).slice(before).map((envelope) => envelope.payload)
        }
      }).pipe(Effect.provide(stack(scripted, "turns-park")))
    )
    expect(result.aborted).toBe(true)
    expect(result.left).toEqual([])
    expect(result.status).toEqual({})
    expect(result.error?.name).toBe("MessageAbortedError")
    // The stream says what takes the app's card down, then what ends the turn.
    expect(result.after[0]).toMatchObject({
      type: "permission.replied",
      properties: { sessionID: "ses_park", requestID: result.request.id, reply: "reject" }
    })
    expect(result.after.some((event) => event.type === "session.idle")).toBe(true)
    expect(result.after.find((event) => event.type === "session.status")?.properties["status"]).toEqual({
      type: "idle"
    })
    // Nothing stays spinning: the parked frame's cell and its bash card settle.
    expect(result.tools.every((part) => part.state.status !== "running")).toBe(true)
    expect(result.tools.filter((part) => part.state.status === "error").map((part) => part.tool)).toEqual([
      "cell",
      "bash"
    ])
  })

  it("opens the next turn for a prompt the running turn could not take", async () => {
    const sinks: Array<Driver.Sink> = []
    const inputs: Array<Driver.StartInput> = []
    // A turn that returns at once and stays open until its sink is closed,
    // and a steer that always misses: the turn ended between the busy check
    // and the steer, as it does when the person types right after Stop.
    const late = Layer.succeed(Driver.Driver, {
      start: (input, sink) =>
        Effect.sync(() => {
          inputs.push(input)
          sinks.push(sink)
        }),
      interrupt: () => Effect.succeed(false),
      permission: () => Effect.void,
      steer: () => Effect.succeed(false),
      resumeOnBoot: () => Effect.void
    })
    const result = await run(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        yield* store.putSession(session("ses_late"))
        yield* turns.prompt({ sessionID: "ses_late", parts: [{ type: "text", text: "first" }] })
        yield* turns.prompt({ sessionID: "ses_late", parts: [{ type: "text", text: "second" }] })
        yield* Effect.sleep("80 millis")
        const waited = inputs.length
        yield* sinks[0]!.closed({ _tag: "completed" })
        yield* Effect.promise(() => until(async () => inputs.length === 2))
        const list = yield* store.listMessages("ses_late")
        return { waited, roles: list.map((message) => message.info.role), busy: yield* turns.status() }
      }).pipe(Effect.provide(stack(late, "turns-late")))
    )
    // The second prompt waited for the first turn to close, then ran as its own turn.
    expect(result.waited).toBe(1)
    expect(inputs.map((input) => input.prompt)).toEqual(["first", "second"])
    expect(inputs[1]!.history).toBe("Person: first")
    expect(result.roles).toEqual(["user", "assistant", "user", "assistant"])
    expect(result.busy).toEqual({ ses_late: { type: "busy" } })

    // A store that refuses the history read while the next turn opens: the
    // failure is logged and the session goes idle rather than wedging.
    let reads = 0
    const refusing: Layer.Layer<Store.Store, Store.StoreError> = Layer.effect(
      Store.Store,
      Effect.map(Store.make, (store) => ({
        ...store,
        listMessages: (sessionID, listOptions) =>
          Effect.suspend(() => {
            reads += 1
            return reads === 2
              ? Effect.fail(new Store.StoreError({ message: "refused" }))
              : store.listMessages(sessionID, listOptions)
          })
      }))
    ).pipe(
      Layer.provide(
        (await import("@smthrs/database/node/NodeDatabase")).layer({
          filename: `${scratch.directory}/late-refused.sqlite`
        })
      )
    )
    inputs.length = 0
    sinks.length = 0
    const hub = Events.layer({ directory: scratch.directory, project: "p" })
    const refused = await run(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        yield* store.putSession(session("ses_late2"))
        yield* turns.prompt({ sessionID: "ses_late2", parts: [{ type: "text", text: "first" }] })
        yield* turns.prompt({ sessionID: "ses_late2", parts: [{ type: "text", text: "second" }] })
        yield* Effect.sleep("80 millis")
        yield* sinks[0]!.closed({ _tag: "completed" })
        yield* Effect.sleep("120 millis")
        return { started: inputs.length, status: yield* turns.status() }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(Turns.layer(options), refusing, hub).pipe(
            Layer.provideMerge(Layer.mergeAll(late, refusing, hub, Evaluator.layerUnavailable()))
          )
        )
      )
    )
    expect(refused).toEqual({ started: 1, status: {} })
  })

  it("takes a retried prompt once: answered, busy, or lost, it never runs twice", async () => {
    const steers: Array<string> = []
    const starts: Array<Driver.StartInput> = []
    const sinks: Array<Driver.Sink> = []
    const driver = Layer.succeed(Driver.Driver, {
      start: (input, sink) =>
        Effect.sync(() => {
          starts.push(input)
          sinks.push(sink)
        }),
      interrupt: () => Effect.succeed(false),
      permission: () => Effect.void,
      steer: (_session, text) =>
        Effect.sync(() => {
          steers.push(text)
          return true
        }),
      resumeOnBoot: () => Effect.void
    })
    const user = "msg_0000000000020000000000000u"
    const result = await run(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        yield* store.putSession(session("ses_retry"))
        const prompt = (text: string, messageID = user) =>
          turns.prompt({ sessionID: "ses_retry", messageID, parts: [{ type: "text", text }] })
        yield* prompt("first")
        // Retried while the turn runs: not stored again, not steered.
        yield* prompt("first")
        const during = yield* store.listMessages("ses_retry")
        // A different prompt while busy is steered; its retry is not.
        yield* prompt("more", "msg_0000000000030000000000000u")
        yield* prompt("more", "msg_0000000000030000000000000u")
        yield* Effect.sleep("30 millis")
        yield* sinks[0]!.closed({ _tag: "completed" })
        yield* Effect.promise(() =>
          until(() => Effect.runPromise(Effect.map(turns.status(), (s) => s["ses_retry"] === undefined)))
        )
        // Retried after the answer: nothing runs.
        const answered = yield* store.listMessages("ses_retry")
        yield* prompt("first")
        yield* Effect.sleep("30 millis")
        const after = yield* store.listMessages("ses_retry")
        // The steered prompt's answer was lost (idle, no finish): its retry runs the same execution.
        yield* prompt("more", "msg_0000000000030000000000000u")
        yield* Effect.promise(() => until(async () => starts.length === 2))
        const reopened = yield* store.listMessages("ses_retry")
        return { during, answered, after, reopened, status: yield* turns.status() }
      }).pipe(Effect.provide(stack(driver, "turns-retry")))
    )
    expect(result.during.map((m) => m.info.id)).toEqual([user, Ids.reply(user)])
    expect(steers).toEqual(["more"])
    expect(result.answered.map((m) => m.info.role)).toEqual(["user", "assistant", "user"])
    expect(result.after.map((m) => m.info.id)).toEqual(result.answered.map((m) => m.info.id))
    expect(result.after[0]!.info.time.created).toBe(result.answered[0]!.info.time.created)
    expect(starts.map((input) => input.messageID)).toEqual([
      Ids.reply(user),
      Ids.reply("msg_0000000000030000000000000u")
    ])
    expect(starts[1]!.history).toBe("Person: first")
    expect(result.reopened.map((m) => m.info.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(result.reopened[2]!.info.time.created).toBe(result.answered[2]!.info.time.created)
    expect(result.status).toEqual({ ses_retry: { type: "busy" } })
  })

  it("closes an open turn on abort even when the driver has nothing to interrupt", async () => {
    const silent = Layer.succeed(Driver.Driver, {
      start: () => Effect.never,
      interrupt: () => Effect.succeed(false),
      permission: () => Effect.void,
      steer: () => Effect.succeed(false),
      resumeOnBoot: () => Effect.void
    })
    const result = await run(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        yield* store.putSession(session("ses_silent"))
        yield* turns.prompt({ sessionID: "ses_silent", parts: [{ type: "text", text: "go" }] })
        const busy = yield* turns.status()
        const aborted = yield* turns.abort("ses_silent")
        const list = yield* store.listMessages("ses_silent")
        return {
          busy,
          aborted,
          error: (list[1]!.info as Protocol.AssistantMessage).error?.name,
          idle: yield* turns.status()
        }
      }).pipe(Effect.provide(stack(silent, "turns-silent")))
    )
    expect(result).toEqual({
      busy: { ses_silent: { type: "busy" } },
      aborted: true,
      error: "MessageAbortedError",
      idle: {}
    })
  })

  it("closes the projection when the driver cannot start, ends early, or fails", async () => {
    for (const behaviour of ["start-fails", "closes-early", "reports-failure"] as const) {
      const messages = await run(
        Effect.gen(function*() {
          const turns = yield* Turns.Turns
          const store = yield* Store.Store
          yield* store.putSession(session("ses_2"))
          yield* turns.prompt({ sessionID: "ses_2", parts: [{ type: "text", text: "go" }] })
          yield* Effect.promise(() =>
            until(() =>
              Effect.runPromise(
                Effect.map(
                  store.listMessages("ses_2"),
                  (list) => list.some((message) => message.info.role === "assistant" && message.info.finish === "error")
                )
              )
            )
          )
          const idle = yield* turns.status()
          const failed = yield* Effect.flip(
            turns.permission({ sessionID: "ses_2", permissionID: "per_x", response: "once" })
          )
          return { list: yield* store.listMessages("ses_2"), idle, failed }
        }).pipe(Effect.provide(stack(broken(behaviour), `turns-${behaviour}`)))
      )
      const assistant = messages.list.find((message) => message.info.role === "assistant")!
        .info as Protocol.AssistantMessage
      expect(assistant.error?.name).toBe("UnknownError")
      expect(messages.idle).toEqual({})
      expect(messages.failed).toMatchObject({ code: "unknown_permission" })
    }
  })

  it("logs and continues when the store refuses a projected event, and hands a driver permission failure to the log", async () => {
    let refuse = false
    const flaky: Layer.Layer<Store.Store, Store.StoreError> = Layer.effect(
      Store.Store,
      Effect.map(Store.make, (store) => ({
        ...store,
        apply: (event) => refuse ? Effect.fail(new Store.StoreError({ message: "refused" })) : store.apply(event)
      }))
    ).pipe(
      Layer.provide(
        (await import("@smthrs/database/node/NodeDatabase")).layer({ filename: `${scratch.directory}/flaky.sqlite` })
      )
    )
    const events: Array<AgentEvent.AgentEvent> = [
      new AgentEvents.Aborted({ eventType: "flows.harness.aborted.v1", reason: "quota" })
    ]
    const driver = Layer.succeed(Driver.Driver, {
      start: (_input, sink) =>
        Effect.gen(function*() {
          refuse = true
          for (const event of events) yield* sink.event(event)
          yield* sink.closed({ _tag: "completed" })
        }),
      interrupt: () => Effect.succeed(true),
      permission: () => Effect.fail(new Driver.DriverError({ code: "unknown_permission", message: "gone" })),
      steer: () => Effect.succeed(true),
      resumeOnBoot: () => Effect.void
    })
    const hub = Events.layer({ directory: scratch.directory, project: "p" })
    const flakyStack = Layer.mergeAll(Turns.layer(options), flaky, hub).pipe(
      Layer.provideMerge(Layer.mergeAll(driver, flaky, hub, Evaluator.layerUnavailable()))
    )
    const result = await run(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        yield* store.putSession(session("ses_3"))
        yield* store.putPermission({
          id: "per_3",
          sessionID: "ses_3",
          permission: "bash",
          patterns: [],
          metadata: {},
          always: [],
          tool: { messageID: "m", callID: "c" }
        })
        // The row is there and no turn of this session is running here, which
        // is what a second server started over the same directory sees: the
        // answer is refused rather than taking the row down and handing it to
        // a driver with nothing to resume.
        const orphan = yield* Effect.flip(
          turns.permission({ sessionID: "ses_3", permissionID: "per_3", response: "always" })
        )
        refuse = true
        yield* turns.prompt({ sessionID: "ses_3", parts: [{ type: "text", text: "go" }] })
        yield* Effect.sleep("50 millis")
        return { orphan, status: yield* turns.status(), aborted: yield* turns.abort("ses_3") }
      }).pipe(Effect.provide(flakyStack))
    )
    expect(result.orphan).toMatchObject({ code: "unknown_permission" })
    expect(result.status).toEqual({})
    expect(result.aborted).toBe(true)
    expect(Turns.promptText([{ type: "text", text: "a" }, { type: "file" }, { type: "text", text: "b" }])).toBe("a\nb")
  })

  it("reads a lock off the SqlError reason and retries the write until it lands", async () => {
    const locked = new Store.StoreError({
      message: "The part could not be stored",
      cause: new SqlError.SqlError({
        reason: new SqlError.LockTimeoutError({
          cause: new Error("database is locked"),
          message: "Failed to execute statement"
        })
      })
    })
    // `String(cause)` never says "locked": the lock is on the reason.
    expect(String(locked.cause)).not.toContain("locked")
    expect(Turns.isLocked(locked)).toBe(true)
    expect(
      Turns.isLocked(
        new Store.StoreError({
          message: "x",
          cause: new SqlError.SqlError({
            reason: new SqlError.UnknownError({ cause: new Error("database is locked") })
          })
        })
      )
    ).toBe(true)
    expect(
      Turns.isLocked(
        new Store.StoreError({ message: "x", cause: { reason: { _tag: "UnknownError", message: "SQLITE_BUSY" } } })
      )
    ).toBe(true)
    expect(Turns.isLocked(new Store.StoreError({ message: "x", cause: new Error("database is locked") }))).toBe(true)
    expect(Turns.isLocked(new Store.StoreError({ message: "refused" }))).toBe(false)

    let refusals = 0
    const flaky: Layer.Layer<Store.Store, Store.StoreError> = Layer.effect(
      Store.Store,
      Effect.map(Store.make, (store) => ({
        ...store,
        // The first two part writes find the database held; the retry lands them.
        apply: (event) =>
          Effect.suspend(() => {
            if (event.type !== "message.part.updated" || refusals >= 2) return store.apply(event)
            refusals += 1
            return Effect.fail(locked)
          })
      }))
    ).pipe(
      Layer.provide(
        (await import("@smthrs/database/node/NodeDatabase")).layer({ filename: `${scratch.directory}/locked.sqlite` })
      )
    )
    const hub = Events.layer({ directory: scratch.directory, project: "p" })
    const lockedStack = Layer.mergeAll(Turns.layer(options), flaky, hub).pipe(
      Layer.provideMerge(Layer.mergeAll(scripted, flaky, hub, Evaluator.layerUnavailable()))
    )
    const result = await run(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        const hub = yield* Events.Events
        yield* store.putSession(session("ses_lock"))
        yield* turns.prompt({ sessionID: "ses_lock", parts: [{ type: "text", text: "Read package.json" }] })
        yield* Effect.promise(() =>
          until(() => Effect.runPromise(Effect.map(store.listPermissions("ses_lock"), (list) => list.length === 1)))
        )
        const messages = yield* store.listMessages("ses_lock")
        return { messages, published: (yield* hub.replay()).map((envelope) => envelope.payload.type) }
      }).pipe(Effect.provide(lockedStack))
    )
    expect(refusals).toBe(2)
    // The user's text part was the first write refused: it is stored, and published after it was.
    expect(result.messages[0]!.parts.map((part) => part.type)).toEqual(["text"])
    expect(result.published.filter((type) => type === "message.part.updated").length).toBeGreaterThan(2)
  })

  it("keeps the dot and the card when a health decision cannot be recorded", async () => {
    const file = `${scratch.directory}/health-refused.sqlite`
    const refusing: Layer.Layer<Store.Store, Store.StoreError> = Layer.effect(
      Store.Store,
      Effect.map(Store.make, (store) => ({
        ...store,
        putHealth: () => Effect.fail(new Store.StoreError({ message: "refused" }))
      }))
    ).pipe(Layer.provide((await import("@smthrs/database/node/NodeDatabase")).layer({ filename: file })))
    const hub = Events.layer({ directory: scratch.directory, project: "p" })
    const evaluator = Evaluator.layerScripted(() => ({
      progress: { score: 3 },
      stuck: { probability: 0.05 },
      needsHuman: { probability: 0.05 }
    }))
    const stackWithoutRecords = Layer.mergeAll(Turns.layer(options), refusing, hub).pipe(
      Layer.provideMerge(Layer.mergeAll(scripted, refusing, hub, evaluator))
    )
    const result = await run(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        yield* store.putSession(session("ses_h"))
        yield* turns.prompt({ sessionID: "ses_h", parts: [{ type: "text", text: "Read package.json" }] })
        const cards = (messages: ReadonlyArray<Store.MessageWithParts>) =>
          messages.flatMap((message) =>
            message.parts.filter((part): part is Protocol.ToolPart => part.type === "tool" && part.tool === "health")
          )
        // Frame zero settles green, then the park turns the dot red; either
        // way a card and a dot landed while every record was refused.
        yield* Effect.promise(() =>
          until(() => Effect.runPromise(Effect.map(store.listMessages("ses_h"), (list) => cards(list).length >= 1)))
        )
        const title = Option.getOrThrow(yield* store.getSession("ses_h")).title
        return { title, cards: cards(yield* store.listMessages("ses_h")), records: yield* store.listHealth("ses_h") }
      }).pipe(Effect.provide(stackWithoutRecords))
    )
    expect(result.title.endsWith(" Read package.json")).toBe(true)
    expect(Health.colorOf(result.title)).toBeDefined()
    expect(result.cards[0]!.state).toMatchObject({ title: "verifying" })
    expect(result.records).toEqual([])
  })

  it("records a decision that outlived its turn without folding it into a closed one", async () => {
    // Health runs on a fiber of its own, so a slow evaluator answers after the
    // turn it was asked about has closed and its state has been dropped. The
    // decision is still recorded; what it cannot do is reopen a finished turn.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = Evaluator.layerScripted(() =>
      Effect.as(Effect.promise(() => gate), {
        progress: { score: 3 },
        stuck: { probability: 0.05 },
        needsHuman: { probability: 0.05 }
      })
    )
    const store = Store.layerSqlite(`${scratch.directory}/health-late.sqlite`)
    const hub = Events.layer({ directory: scratch.directory, project: "p" })
    const late = Layer.mergeAll(Turns.layer(options), store, hub).pipe(
      Layer.provideMerge(Layer.mergeAll(scripted, store, hub, slow))
    )
    const healthCards = (messages: ReadonlyArray<Store.MessageWithParts>) =>
      messages.flatMap((message) => message.parts.filter((part) => part.type === "tool" && part.tool === "health"))
    const result = await run(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        yield* store.putSession(session("ses_late"))
        yield* turns.prompt({ sessionID: "ses_late", parts: [{ type: "text", text: "Read package.json" }] })
        yield* Effect.promise(() =>
          until(() => Effect.runPromise(Effect.map(store.listPermissions("ses_late"), (list) => list.length === 1)))
        )
        const pending = yield* store.listPermissions("ses_late")
        yield* turns.permission({ sessionID: "ses_late", permissionID: pending[0]!.id, response: "once" })
        // The turn finishes while every evaluation is still waiting on the gate.
        yield* Effect.promise(() =>
          until(() =>
            Effect.runPromise(
              Effect.map(store.listMessages("ses_late"), (messages) =>
                messages.some((message) => message.info.role === "assistant" && message.info.finish === "stop"))
            )
          )
        )
        const closed = yield* turns.status()
        const duringTurn = healthCards(yield* store.listMessages("ses_late"))
        release()
        yield* Effect.promise(() =>
          until(() => Effect.runPromise(Effect.map(store.listHealth("ses_late"), (list) => list.length > 0)))
        )
        return {
          closed,
          duringTurn,
          records: yield* store.listHealth("ses_late"),
          cards: healthCards(yield* store.listMessages("ses_late"))
        }
      }).pipe(Effect.provide(late))
    )
    expect(result.closed).toEqual({})
    expect(result.duringTurn).toEqual([])
    expect(result.records.length).toBeGreaterThan(0)
    // Recorded, never folded: a closed turn grows no card from a late verdict.
    expect(result.cards).toEqual([])
  })

  it("renders the conversation tail a follow-up carries, newest last and cut from the front", () => {
    const message = (id: string, role: "user" | "assistant", texts: ReadonlyArray<string>): Store.MessageWithParts => ({
      info: role === "user"
        ? { id, sessionID: "s", role, time: { created: 1 }, agent: "a", model: { providerID: "p", modelID: "m" } }
        : {
          id,
          sessionID: "s",
          role,
          time: { created: 1 },
          parentID: "u",
          modelID: "m",
          providerID: "p",
          mode: "a",
          agent: "a",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: Protocol.noTokens
        },
      parts: texts.map((text, index): Protocol.Part =>
        index === 0
          ? { id: `${id}_${index}`, sessionID: "s", messageID: id, type: "text", text }
          : { id: `${id}_${index}`, sessionID: "s", messageID: id, type: "step-start" }
      )
    })
    expect(Turns.history([])).toBeUndefined()
    expect(Turns.history([message("u1", "user", ["  "]), message("a1", "assistant", [])])).toBeUndefined()
    expect(Turns.history([message("u1", "user", ["hi"]), message("a1", "assistant", ["hello", "x"])])).toBe(
      "Person: hi\n\nAssistant: hello"
    )
    // The run summary is synthetic: it never reaches the model as an answer.
    const summarized: Store.MessageWithParts = {
      ...message("a2", "assistant", ["done"]),
      parts: [
        { id: "a2_0", sessionID: "s", messageID: "a2", type: "text", text: "done" },
        { id: "a2_1", sessionID: "s", messageID: "a2", type: "text", text: "1 frame · 0 calls", synthetic: true }
      ]
    }
    expect(Turns.history([message("u1", "user", ["hi"]), summarized])).toBe("Person: hi\n\nAssistant: done")
    const long = Turns.history([message("u1", "user", ["a".repeat(30)]), message("a1", "assistant", ["done"])], 20)
    expect(long?.startsWith("[earlier turns omitted]\n")).toBe(true)
    expect(long?.endsWith("Assistant: done")).toBe(true)
  })

  it("re-opens the turns the driver finds at boot, and leaves finished ones alone", async () => {
    const file = `${scratch.directory}/turns-boot.sqlite`
    // The rows a previous process left behind: a session with an answered
    // turn and one that was still running, and an empty session.
    await run(
      Effect.gen(function*() {
        const store = yield* Store.Store
        yield* store.putSession(session("ses_r"))
        yield* store.putSession(session("ses_s"))
        yield* store.putSession(session("ses_t"))
        const header = (id: string, extra: Partial<Protocol.AssistantMessage>): Protocol.AssistantMessage => ({
          id,
          sessionID: "ses_r",
          role: "assistant",
          time: { created: 5 },
          parentID: "msg_user",
          modelID: "demo",
          providerID: "scripted",
          mode: "smithers",
          agent: "smithers",
          path: { cwd: scratch.directory, root: scratch.directory },
          cost: 0,
          tokens: Protocol.noTokens,
          ...extra
        })
        yield* store.putMessage(header("msg_done", { finish: "stop" }))
        yield* store.putMessage(header("msg_open", {}))
      }).pipe(Effect.provide(Store.layerSqlite(file)))
    )
    const sinks: Array<Driver.Sink> = []
    const booting = Layer.succeed(Driver.Driver, {
      start: () => Effect.never,
      interrupt: () => Effect.succeed(false),
      permission: () => Effect.void,
      steer: () => Effect.succeed(false),
      resumeOnBoot: (open) =>
        Effect.gen(function*() {
          for (
            const turn of [
              { sessionID: "ses_missing", messageID: "msg_x", prompt: "x" },
              { sessionID: "ses_r", messageID: "msg_done", prompt: "answered" },
              { sessionID: "ses_r", messageID: "msg_open", prompt: "still running" },
              { sessionID: "ses_s", messageID: "msg_fresh", prompt: "no header" },
              {
                sessionID: "ses_t",
                messageID: "msg_named",
                prompt: "named",
                agent: "other",
                model: { providerID: "p", modelID: "m" }
              },
              // A second open turn of a session already re-opened joins it.
              { sessionID: "ses_r", messageID: "msg_second", prompt: "second" }
            ]
          ) {
            const sink = yield* Effect.orDie(open(turn))
            sinks.push(sink)
            // An inert sink swallows everything; a live one folds it.
            yield* sink.event(
              new AgentEvents.CellPrinted({ eventType: "flows.harness.cell-printed.v1", cell: "c", text: "noted" })
            )
            yield* sink.closed({ _tag: "suspended" })
          }
        })
    })
    const store = Store.layerSqlite(file)
    const hub = Events.layer({ directory: scratch.directory, project: "p" })
    const result = await run(
      Effect.gen(function*() {
        const turns = yield* Turns.Turns
        const store = yield* Store.Store
        const busy = yield* turns.status()
        yield* sinks[2]!.closed({ _tag: "interrupted" })
        yield* Effect.promise(() =>
          until(() => Effect.runPromise(Effect.map(turns.status(), (status) => status["ses_r"] === undefined)))
        )
        const reopened = (yield* store.listMessages("ses_r")).find((message) => message.info.id === "msg_open")!
          .info as Protocol.AssistantMessage
        const fresh = (yield* store.listMessages("ses_s")).map((message) => message.info)
        const named = (yield* store.listMessages("ses_t")).map((message) => message.info)
        return { busy, reopened, fresh, named, sessions: yield* store.listSessions() }
      }).pipe(Effect.provide(
        Layer.mergeAll(Turns.layer(options), store, hub).pipe(
          Layer.provideMerge(Layer.mergeAll(booting, store, hub, Evaluator.layerUnavailable()))
        )
      ))
    )
    expect(sinks.length).toBe(6)
    expect(Object.keys(result.busy).sort()).toEqual(["ses_r", "ses_s", "ses_t"])
    // The re-opened turn kept its header and closed the way the driver said; the finished one stayed.
    expect(result.reopened.time.created).toBe(5)
    expect(result.reopened.parentID).toBe("msg_user")
    expect(result.reopened.error?.name).toBe("MessageAbortedError")
    expect(result.fresh.map((info) => info.role)).toEqual(["user", "assistant"])
    expect(result.fresh[0]!.agent).toBe("smithers")
    expect(result.named[0]!.agent).toBe("other")
    expect((result.named[0] as Protocol.UserMessage).model).toEqual({ providerID: "p", modelID: "m" })
  })

  it("boots even when the driver cannot resume what it finds", async () => {
    const failing = Layer.succeed(Driver.Driver, {
      start: () => Effect.never,
      interrupt: () => Effect.succeed(false),
      permission: () => Effect.void,
      steer: () => Effect.succeed(false),
      resumeOnBoot: () => Effect.fail(new Driver.DriverError({ code: "engine_failed", message: "no engine" }))
    })
    const status = await run(
      Effect.flatMap(Turns.Turns, (turns) => turns.status()).pipe(Effect.provide(stack(failing, "turns-failing-boot")))
    )
    expect(status).toEqual({})
  })
})
