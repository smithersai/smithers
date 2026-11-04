/**
 * Serving flows over RPC, runnable: `FlowProxy.toRpcGroup` derives the wire
 * definitions from the flow list, `FlowProxyServer.layerRpcHandlers` binds
 * them to an in-memory engine, and an in-process RPC client calls them.
 *
 * The client executes `Review` twice under one execution id, then once for a
 * rejected document. The repeat joins the recorded run, so the review step
 * runs once for the first id; the rejection reaches the client as the flow's
 * declared error, not as a defect.
 *
 * `test/examples.test.ts` runs it and checks every field it returns.
 *
 * @since 1.0.0
 */

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto } from "@smthrs/crypto"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { RpcTest } from "effect/rpc"
import * as Schema from "effect/Schema"
import { FlowEngine, FlowProxy, FlowProxyServer } from "../src/index.ts"

const ReviewStep = Action.make("docs/ReviewStep", {
  payload: { id: Schema.String },
  success: Schema.String,
  error: Schema.Literal("rejected")
})

const Review = Flow.make("docs/Review", {
  payload: { id: Schema.String },
  success: Schema.String,
  error: Schema.Literal("rejected"),
  body: (payload) => ReviewStep.call(payload)
})

const flows = [Review] as const

// The group and the handlers must use the same prefix: it is part of every
// derived operation name.
const prefix = "flows_" as const

/**
 * Serves `Review` over RPC and calls it through an in-process client.
 *
 * Each call builds a fresh in-memory engine, so the counter and the recorded
 * runs start empty.
 *
 * @returns The two joined results, how many times the review step ran, and
 *   the error the rejected document failed with: its declared error, or
 *   the conflict every execute operation can answer.
 * @since 1.0.0
 */
export const runServeRpc = (): Promise<{
  readonly first: string
  readonly second: string
  readonly reviews: number
  readonly rejection: "rejected" | FlowEngine.ExecutionIdentityConflict
}> => {
  let reviews = 0

  const EngineLayer = Layer.mergeAll(
    ReviewStep.toLayer(({ id }) =>
      Effect.suspend(() => {
        reviews = reviews + 1
        return id.startsWith("draft-") ? Effect.fail("rejected" as const) : Effect.succeed(`${id}: approved`)
      })
    ),
    Interpreter.layer(Review)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(Crypto.layerFromDigest(NodeCrypto.layerDigest))
  )

  const ServerLayer = FlowProxyServer.layerRpcHandlers(flows, { prefix }).pipe(Layer.provide(EngineLayer))

  const program = Effect.gen(function*() {
    const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows, { prefix }))
    const call = client["flows_docs/Review"]
    const first = yield* call({ payload: { id: "spec-1" }, executionId: "review-spec-1" })
    const second = yield* call({ payload: { id: "spec-1" }, executionId: "review-spec-1" })
    const rejection = yield* call({ payload: { id: "draft-2" }, executionId: "review-draft-2" }).pipe(Effect.flip)
    return { first, second, reviews, rejection }
  }).pipe(Effect.provide(ServerLayer), Effect.scoped)

  return Effect.runPromise(program)
}
