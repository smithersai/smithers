import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as AgentEvents from "@smthrs/harness/AgentEvent"
import { Effect, Layer } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import * as DemoScript from "../src/DemoScript.ts"
import * as Driver from "../src/Driver.ts"
import * as Events from "../src/Events.ts"
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
  return Layer.mergeAll(Turns.layer(options), store, hub).pipe(Layer.provideMerge(Layer.mergeAll(driver, store, hub)))
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
        yield* Effect.promise(() =>
          until(() =>
            Effect.runPromise(
              Effect.map(store.listMessages("ses_1"), (messages) =>
                messages.some((message) => message.info.role === "assistant" && message.info.finish === "stop"))
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
    expect(result.messages[1]!.parts.filter((part) => part.type === "tool").length).toBe(6)
    expect(result.idle).toEqual({})
    expect(result.replayed.map((envelope) => envelope.payload.type)).toContain("permission.replied")
    expect(result.aborted).toBe(false)
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
        const aborted = yield* turns.abort("ses_slow")
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
        return { aborted, error: (list[1]!.info as Protocol.AssistantMessage).error, status: yield* turns.status() }
      }).pipe(
        Effect.provide(stack(ScriptedDriver.layer({ script: DemoScript.script, delay: "20 millis" }), "turns-slow"))
      )
    )
    expect(result.aborted).toBe(true)
    expect(result.error?.name).toBe("MessageAbortedError")
    expect(result.status).toEqual({})
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
      Layer.provideMerge(Layer.mergeAll(driver, flaky, hub))
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
        yield* turns.permission({ sessionID: "ses_3", permissionID: "per_3", response: "always" })
        yield* turns.prompt({ sessionID: "ses_3", parts: [{ type: "text", text: "go" }] })
        yield* Effect.sleep("50 millis")
        return { status: yield* turns.status(), aborted: yield* turns.abort("ses_3") }
      }).pipe(Effect.provide(flakyStack))
    )
    expect(result.status).toEqual({})
    expect(result.aborted).toBe(true)
    expect(Turns.promptText([{ type: "text", text: "a" }, { type: "file" }, { type: "text", text: "b" }])).toBe("a\nb")
  })
})
