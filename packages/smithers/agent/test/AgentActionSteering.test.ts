/**
 * A person's message reaching a running agent step: the steering a flow host
 * gives its `AgentAction` with `Agent.layerSandbox` and `@smthrs/harness`'s
 * `Notifications.layerForExecution()` over the durable notification queue.
 *
 * Everything is production but the provider: the real engine, the real QuickJS
 * sandbox, the real cell loop and the real queue over a journal. The message is
 * admitted while the first model turn streams, which is when a person presses
 * Send while the agent works.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Notifications from "@smthrs/harness/Notifications"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import { Notification, NotificationQueue, SteerPayload } from "@smthrs/notifications"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentAction from "../src/AgentAction.ts"
import * as Budget from "../src/Budget.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const textOf = (request: ModelRequest.ModelRequest) =>
  request.messages.flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []))
    .join("\n")

const Implemented = Schema.Struct({ summary: Schema.String })
const Implement = AgentAction.make("agent/test/steered/Implement", {
  payload: { task: Schema.String },
  output: Implemented,
  seat: "agent",
  prompt: ({ task }) => task,
  maxFrames: 4
})
const Todo = Flow.make("agent/test/steered", {
  payload: { task: Schema.String },
  success: Implemented,
  error: AgentAction.AgentFailure,
  body: (payload) => Implement.call(payload)
})

const host: AgentAction.Host = {
  registry: Registry.makeNoop({
    list: () => Effect.succeed([]),
    visible: () => Effect.succeed([]),
    getOption: () => Effect.succeed(Option.none())
  }),
  limits: { calls: 8 },
  capabilityEnvelope: [],
  maxFrames: 4
}

/** A person's steer to `runId`, as a host admits it. */
const steer = (runId: string, id: string, body: string) =>
  Notification.humanSteer({
    runId,
    id,
    actor: "person:ben",
    attribution: { login: "ben" },
    payload: SteerPayload.encode({ kind: "Message", body })
  })

/**
 * Runs the flow as `executionId`. The model answers a cell that logs on its
 * first turn and finishes on its second; `during` runs while the first turn
 * streams.
 */
const runSteered = (
  executionId: string,
  during: Effect.Effect<unknown, unknown, NotificationQueue.NotificationQueue>
) =>
  Effect.gen(function*() {
    const requests: Array<ModelRequest.ModelRequest> = []
    const queue = yield* NotificationQueue.NotificationQueue
    const model = Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          const index = requests.length
          requests.push(request)
          const source = index === 0
            ? `console.log("frame one")`
            : `ctx.done(${JSON.stringify(JSON.stringify({ summary: "ok" }))})`
          const events = Stream.fromIterable([
            ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `c${index}` }),
            ModelEvent.ModelEvent.TextDelta({
              type: "text-delta",
              id: `c${index}`,
              text: "```cell\n" + source + "\n```"
            }),
            ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `c${index}` }),
            ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
          ])
          return index === 0
            ? Stream.concat(
              Stream.fromEffect(Effect.orDie(during.pipe(
                Effect.provideService(NotificationQueue.NotificationQueue, queue)
              ))).pipe(Stream.drain),
              events
            )
            : events
        })
    })
    const seats = SeatResolver.layer({
      resolve: (id) =>
        Effect.succeed(Seat.make({
          id,
          modelId: Seat.modelIdOf(id),
          model,
          route: { prepare: () => Effect.succeed(prepared) },
          contextWindowTokens: 200_000
        }))
    })
    const result = yield* Todo.execute({ task: "Write the greeting" }, { executionId }).pipe(
      Effect.provide(
        Layer.mergeAll(Implement.layer, Interpreter.layer(Todo)).pipe(
          Layer.provideMerge(AgentAction.layerHost(host)),
          Layer.provideMerge(seats),
          Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerSandbox, scriptedCompletionJudge)),
          Layer.provideMerge(
            Notifications.layerForExecution().pipe(
              Layer.provide(Layer.succeed(NotificationQueue.NotificationQueue)(queue))
            )
          ),
          Layer.provideMerge(Layer.merge(Budget.layerUnbounded(), QuotaPolicy.layerUnclassified())),
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
    return {
      result,
      requests,
      pending: yield* queue.pending(executionId),
      otherPending: yield* queue.pending("todo:other")
    }
  })

const queueLayer = () => NotificationQueue.layer.pipe(Layer.provideMerge(TestJournal.layer()))

describe("steering a running AgentAction", () => {
  it("takes a message admitted during turn 1 into turn 2, once", async () => {
    const out = await Effect.runPromise(
      runSteered(
        "todo:steered",
        Effect.flatMap(
          NotificationQueue.NotificationQueue,
          (queue) => queue.admit("todo:steered", steer("todo:steered", "steer-1", "Use tabs, not spaces"))
        )
      ).pipe(Effect.provide(queueLayer()))
    )
    expect(out.result).toEqual({ summary: "ok" })
    expect(out.requests).toHaveLength(2)
    expect(textOf(out.requests[0]!)).not.toContain("Use tabs, not spaces")
    const second = textOf(out.requests[1]!)
    // The person's words, framed as a newer instruction that wins over the task where they conflict.
    expect(second).toContain(
      "[notification steer-1 from person:ben at todo:steered turn 0 attribution {\"login\":\"ben\"}]\n" +
        Notifications.precedence + "Use tabs, not spaces"
    )
    expect(second.split("Use tabs, not spaces")).toHaveLength(2)
    expect(out.pending).toEqual([])
  })

  it("never hands one execution's message to another", async () => {
    const other = steer("todo:other", "steer-2", "Rename the module")
    const out = await Effect.runPromise(
      runSteered(
        "todo:quiet",
        Effect.flatMap(
          NotificationQueue.NotificationQueue,
          (queue) => queue.admit("todo:other", other)
        )
      ).pipe(Effect.provide(queueLayer()))
    )
    expect(out.result).toEqual({ summary: "ok" })
    expect(out.requests.map(textOf).join("\n")).not.toContain("Rename the module")
    expect(out.pending).toEqual([])
    expect(out.otherPending).toEqual([other])
  })
})
