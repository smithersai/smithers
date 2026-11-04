import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto } from "@smthrs/crypto"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect } from "effect"

const RetryHost = Flow.make("issue-sweep/test/retry-host", { payload: {}, body: () => Node.succeed(undefined) })

export type RetryServices = FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Crypto.Crypto

export const withRetryInstance = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(RetryHost, "retry-test")))

/** Real volatile engine for helpers called directly instead of through their parent flow. */
export const withRetryRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    withRetryInstance,
    Effect.provide(FlowEngine.layerMemory),
    Effect.provide(Crypto.layerFromDigest(NodeCrypto.layerDigest))
  )
