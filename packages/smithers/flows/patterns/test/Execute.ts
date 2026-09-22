/**
 * How a ported pattern's declaration is EXECUTED in tests.
 *
 * A pattern declares a `@smthrs/flow` flow, so a case executes the real
 * thing: `Flow.execute` over `Interpreter.layer`, the in-memory `FlowEngine`,
 * and the action implementations the case registers. No second evaluator
 * exists.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/** A declaration that can be entered, with its payload already type-erased. */
export interface Executable {
  readonly _tag: string
  readonly execute: (payload: any, options: { readonly executionId: string }) => Effect.Effect<any, any, any>
}

/**
 * Runs one declared flow to settlement.
 *
 * `layers` carries the implementations of any actions the flow calls; a
 * declaration built only from flows needs none.
 */
export const execute = (
  flow: Executable,
  payload: unknown,
  executionId: string,
  ...layers: ReadonlyArray<Layer.Layer<any, any, any>>
): Promise<unknown> =>
  Effect.runPromise(
    flow.execute(payload, { executionId }).pipe(
      Effect.provide(
        Layer.mergeAll(Interpreter.layer(flow as never), ...layers).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        ) as Layer.Layer<any, never, never>
      ),
      Effect.scoped
    ) as Effect.Effect<unknown, unknown, never>
  )

/**
 * A scripted member: a flow that answers from the payload a pattern hands it.
 *
 * The answer is computed while the graph builds, exactly as the pattern's own
 * body is, so a payload field that is still a planned reference is passed on
 * rather than read. That is the same contract `@smthrs/core`'s body-returning
 * fixtures had, minus the second evaluator.
 */
export const member = (
  tag: string,
  answer: (payload: any) => unknown,
  fields: Schema.Struct.Fields = { input: Schema.Unknown }
): Flow.Flow<string, Flow.AnyStructSchema, typeof Schema.Unknown, typeof Schema.Unknown, never> =>
  Flow.make(tag, {
    payload: fields,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: (payload: any) => Node.succeed(answer(payload))
  }) as unknown as Flow.Flow<string, Flow.AnyStructSchema, typeof Schema.Unknown, typeof Schema.Unknown, never>
