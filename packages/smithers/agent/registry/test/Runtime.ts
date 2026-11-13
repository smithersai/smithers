import { FlowEngine } from "@smthrs/engine"
import { FlowRuntime } from "@smthrs/flow"
import { Effect, Layer } from "effect"

/** Observe successful registrations while preserving every real runtime operation. */
export const recordingRuntime = (registered: Array<string>) =>
  Layer.effect(
    FlowRuntime.FlowRuntime,
    Effect.map(FlowRuntime.FlowRuntime, (runtime) =>
      FlowRuntime.FlowRuntime.of({
        ...runtime,
        register: (flow, execute, options) =>
          runtime.register(flow, execute, options).pipe(
            Effect.tap(() => Effect.sync(() => void registered.push(flow._tag)))
          )
      }))
  ).pipe(Layer.provide(FlowEngine.layerMemory))
