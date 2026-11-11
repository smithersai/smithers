/** A real control plane coordinator and flow host for tests of polling sources and their door. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Channels from "@smthrs/control/Channels"
import * as Control from "@smthrs/control/Control"
import type { Receipt } from "@smthrs/control/ControlSchema"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, Schema, Stream } from "effect"
import { Failure, fromIntegrationError } from "../src/core/ActionFailure.vibe"
import type * as Channel from "../src/core/Channel.vibe"
import { layerMemory } from "../src/core/CursorStore.vibe"
import type { RunContext } from "../src/core/Source.vibe"

export interface Recorded {
  readonly calls: Array<string>
  readonly inputs: Array<unknown>
}

export const recorded = (): Recorded => ({ calls: [], inputs: [] })

/** What the control plane answers a start and a signal with; a fault is an injected failure. */
export type ControlService = Parameters<typeof Control.make>[0]
export interface Answers {
  readonly run?: ReturnType<ControlService["run"]>
  readonly signal?: ReturnType<ControlService["signal"]>
}

export const accepted = (receiptId: string): Receipt => ({ _tag: "Accepted", receiptId })

/** A real `Channels` coordinator over a Control that records what it is asked. */
export const channelsLayer = (seen: Recorded, answers: Answers = {}) =>
  Channels.layerMemory.pipe(Layer.provide(Layer.succeed(
    Control.Control,
    Control.make({
      plan: (request) => {
        seen.calls.push("plan")
        seen.inputs.push(request.input)
        return Effect.succeed({
          planId: "plan",
          flowId: request.flowId,
          digest: "digest",
          inputSummary: "input",
          envelope: { capabilities: [], flows: [], budget: {} },
          deployClass: false,
          nodes: [],
          approval: {
            target: {
              _tag: "Plan",
              planId: "plan",
              digest: "digest",
              envelope: { capabilities: [], flows: [], budget: {} }
            },
            scope: "run",
            idempotencyKey: "approve:plan"
          }
        })
      },
      run: (request) => {
        seen.calls.push("run")
        return answers.run ?? Effect.succeed(accepted(request.idempotencyKey))
      },
      signal: (request) => {
        seen.calls.push(`signal:${request.runId}:${request.signal.name}`)
        seen.inputs.push(request.signal.payload)
        return answers.signal ?? Effect.succeed(accepted(request.idempotencyKey))
      },
      approve: () => Effect.die("unused"),
      deny: () => Effect.die("unused"),
      steer: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      resume: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      watch: () => Stream.empty
    })
  )))

export const withChannels = <A, E>(
  effect: Effect.Effect<A, E, Channels.Channels>,
  seen: Recorded,
  answers?: Answers
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(channelsLayer(seen, answers))))

/** Runs a polling source inside a real flow execution, with the door's `Channels` beside the engine. */
export const runInFlow = <A, E>(
  effect: Effect.Effect<A, E, RunContext | Channels.Channels>,
  seen: Recorded,
  answers?: Answers
) => {
  const step = Action.make("test/source-door/run", {
    payload: {},
    success: Schema.Unknown,
    error: Failure,
    tier: "irreversible"
  })
  const flow = Flow.make("test/source-door", {
    payload: {},
    success: Schema.Unknown,
    error: Failure,
    body: () => step.call({})
  })
  const layer = Layer.mergeAll(
    step.toLayer(() => effect.pipe(Effect.mapError(fromIntegrationError))),
    Interpreter.layer(flow)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(
      Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, layerMemory, channelsLayer(seen, answers))
    )
  )
  return Effect.runPromise(
    flow.execute({}, { executionId: "source-door-test" }).pipe(
      Effect.provide(layer),
      Effect.scoped,
      Effect.map((value) => value as A)
    )
  )
}

/** Registers the door's channel with the coordinator in context. */
export const register = (door: Channel.SourceDoor) =>
  Effect.flatMap(Channels.Channels, (channels) => channels.register(door.channel))
