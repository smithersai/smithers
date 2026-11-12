/**
 * The harness every use-case port runs on.
 *
 * A port declares its steps and its flow; this module supplies everything
 * else. Every agent seat is answered by a script, a function of the request
 * text, so a test decides each agent's typed answer and the port runs offline
 * with no key. The agent host is the one `11-agent-step.ts` builds, and the
 * engine is the durable one `TestNodeRuntime` builds over a SQLite file.
 */
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { TestNodeRuntime } from "@smthrs/platform-node"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

/**
 * Answers one model request.
 *
 * `asked` is the text a model reads: the system prompt and every message,
 * joined. Return the step's typed answer. Returning `undefined` says the
 * script did not expect this request, and the run dies naming it rather than
 * failing the step's schema with an empty answer.
 */
export type Script = (asked: string) => unknown

const prepared: Route.PreparedRequest = {
  routeId: "examples",
  protocolId: "examples",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

/**
 * A model that answers each request with one cell completing on
 * `script(asked)`. The host renders the answer as canonical JSON, which is the
 * text the step's declared schema decodes.
 */
export const scripted = (script: Script): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        const asked = [
          ...request.system.map((part) => part.text),
          ...request.messages.flatMap((message) =>
            message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          )
        ].join("\n")
        const answer = script(asked)
        if (answer === undefined) return Stream.die(new Error(`No scripted answer for this request:\n${asked}`))
        const cell = `ctx.done(${JSON.stringify(answer)})`
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

/**
 * The services every `AgentAction` layer requires, with every declared seat
 * answered by `script`. A live host replaces only the seat resolver with a
 * provider route; the agent loop, sandbox and judge are the same layers.
 */
export const agents = (script: Script) =>
  Layer.mergeAll(
    AgentAction.layerHost({
      registry: Registry.makeNoop({
        list: () => Effect.succeed([]),
        visible: () => Effect.succeed([]),
        getOption: () => Effect.succeed(Option.none())
      }),
      limits: { calls: 8 },
      capabilityEnvelope: [],
      maxFrames: 4
    }),
    SeatResolver.layer({
      resolve: (id) =>
        Effect.succeed(
          Seat.make({
            id,
            modelId: Seat.modelIdOf(id),
            model: scripted(script),
            route: { prepare: () => Effect.succeed(prepared) },
            contextWindowTokens: 200_000
          })
        )
    }),
    Agent.layer
  ).pipe(
    // A scripted seat cannot refuse for quota, and these offline runs have no
    // approved plan envelope to derive a ceiling from.
    // eslint-disable-next-line no-restricted-syntax -- offline examples have no approved envelope
    Layer.provideMerge(Layer.mergeAll(QuotaPolicy.layerUnclassified(), Budget.layerUnbounded())),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(ScriptedJudge.layer)
  )

/**
 * A seat resolver that refuses every seat, as a host with no model for it
 * does. Provide it to one step's layer and that step fails with
 * `SeatUnresolved`; `asked` records every seat it was asked to resolve.
 */
export const refusingSeats = (asked: Array<string>) =>
  SeatResolver.layer({
    resolve: (id) =>
      Effect.suspend(() => {
        asked.push(id)
        return Effect.fail(new Seat.SeatUnresolved({ seat: id, message: `This host has no model for ${id}.` }))
      })
  })

/** What one {@link run} needs besides the flow and its payload. */
export interface RunOptions<ROut, RIn> {
  /** The SQLite file the durable engine journals the run in. */
  readonly filename: string
  /** The execution id; re-running with the same id resumes the recorded run. */
  readonly executionId: string
  /** Answers every agent seat the flow's steps declare. */
  readonly script: Script
  /**
   * Implements every step the flow calls: each `AgentAction`'s `.layer`, each
   * deterministic action's `toLayer`, and `Interpreter.layer` for any flow it
   * starts with `.child()`.
   */
  readonly actions: Layer.Layer<ROut, never, RIn>
}

/** Runs `flow` once on a durable engine over `options.filename`. */
export const run = <
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires,
  ROut,
  RIn
>(
  flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
  payload: Payload["~type.make.in"],
  options: RunOptions<ROut, RIn>
) =>
  Effect.scoped(
    flow.execute(payload, { executionId: options.executionId }).pipe(
      Effect.provide(
        Layer.mergeAll(options.actions, Interpreter.layer(flow)).pipe(
          Layer.provideMerge(agents(options.script)),
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(TestNodeRuntime.durableEngine(options.filename, "examples-use-cases"))
        )
      )
    )
  )
