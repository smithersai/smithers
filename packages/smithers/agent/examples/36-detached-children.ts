/**
 * Let a child outlive its parent and collect its output after a restart.
 *
 * The first engine spawns a detached child and completes the parent. A fresh
 * engine opens the same SQLite state and reads the child's result. The child's
 * recorded detach policy keeps it alive when the parent settles.
 *
 * This differs from an attached child, whose parent-exit policy requests
 * cancellation when the parent exits.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { ChildFlows, EngineChildren } from "@smthrs/agent"
import * as ControlLive from "@smthrs/control/ControlLive"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import { Crypto } from "@smthrs/crypto"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { NotificationQueue } from "@smthrs/notifications"
import { TestNodeRuntime } from "@smthrs/platform-node"
import { Registry } from "@smthrs/registry"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/** The work the detached child does. */
export const Summarize = Action.make("examples/Summarize", {
  payload: { document: Schema.String },
  success: Schema.String
})

/** The child, as an ordinary flow. Nothing marks it as a subagent. */
export const Digest = Flow.make("examples/Digest", {
  payload: { document: Schema.String },
  success: Schema.String,
  body: (payload) => Summarize.call(payload)
})

/** The parent's one step: start the child and answer with its id. */
export const StartDigest = Action.make("examples/StartDigest", {
  payload: { document: Schema.String },
  success: Schema.String
})

export const Triage = Flow.make("examples/Triage", {
  payload: { document: Schema.String },
  success: Schema.String,
  body: (payload) => StartDigest.call(payload)
})

/**
 * What the two phases observed.
 *
 * `parentStatus` and `childCancelRequested` are read straight off the run rows
 * after phase one, because the claim being made is about durable state and not
 * about what either engine remembers.
 */
export interface Summary {
  readonly child: string
  readonly parentStatus: string
  readonly childCancelRequested: boolean
  readonly output: string
}

/**
 * The control plane the child port steers through, over the engine's database.
 *
 * `EngineChildren` depends on exactly three services (the flow runtime, the
 * run store, and the control plane) so a host wires the control plane once
 * and gets `agent/send` with it. This example only spawns and collects, but
 * the dependency is real and is wired honestly rather than stubbed.
 */
const controlPlane = Layer.provide(ControlLive.layer, [
  SqlControlRuntime.layer(),
  Registry.layerNoop(),
  NotificationQueue.layer
]).pipe(Layer.orDie)

export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    const summarize = ({ document }: { readonly document: string }) => Effect.succeed(`summary of ${document}`)

    const startDigest = ({ document }: { readonly document: string }) =>
      Effect.gen(function*() {
        const children = yield* ChildFlows.Children
        const spawned = yield* children.spawn({
          flow: Digest._tag,
          input: { document },
          label: "digest"
        })
        return spawned.child
      }).pipe(Effect.orDie)

    const engine = (hostId: string) =>
      Layer.mergeAll(
        StartDigest.toLayer(startDigest),
        Summarize.toLayer(summarize),
        Interpreter.layer(Triage),
        Interpreter.layer(Digest)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        // The port names the flows a child may run. A `spawn` of anything else
        // is `ChildError { code: "not_found" }`, which the caller can see.
        Layer.provideMerge(EngineChildren.layer({ flows: [Digest] })),
        Layer.provideMerge(controlPlane),
        Layer.provideMerge(TestNodeRuntime.durableEngine(filename, hostId)),
        Layer.provideMerge(Crypto.layerFromDigest(NodeCrypto.layerDigest))
      )

    // Phase one: the parent spawns the child and finishes. The child keeps
    // going, because `spawn` discarded its result and the engine recorded
    // `onParentExit: "detach"` on the child's own row.
    const phaseOne = yield* Effect.scoped(
      Effect.gen(function*() {
        const child = yield* Triage.execute({ document: "rfc" }, { executionId: "triage-1" })
        const store = yield* RunStore.RunStore
        const parentRow = yield* store.get("triage-1")
        const childRow = yield* store.get(child)
        return {
          child,
          parentStatus: parentRow.status as string,
          childCancelRequested: childRow.cancelRequestedAtMs !== null
        }
      }).pipe(Effect.provide(engine("worker-a")))
    )

    // Phase two: a fresh engine, a different owner, no fiber and no map from
    // phase one. What it answers with came out of the run store.
    const output = yield* Effect.scoped(
      Effect.gen(function*() {
        const children = yield* ChildFlows.Children
        const collected = yield* children.await({ child: phaseOne.child })
        return collected.output
      }).pipe(Effect.provide(engine("worker-b")))
    )

    return { ...phaseOne, output }
  }).pipe(Effect.orDie)
