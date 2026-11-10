import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * A keyed sealed action's outcome replays under the key encoding it was written in.
 *
 * The first incarnation is an engine that writes encoding 2, the last unversioned one: it records the sealed step,
 * then dies inside the next one. The second incarnation writes the current encoding, which names itself, and takes
 * the run over. Its dispatch of the sealed step must find the record the first wrote, under encoding 2, and replay it:
 * the step's body never runs again. Before encodings were versioned, a change to the derivation re-keyed every
 * recorded step, so a run parked across an upgrade ran its sealed work again.
 */
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import * as Node from "@smthrs/plan/Node"
import { Ownership } from "@smthrs/run-store"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as EngineStore from "../src/EngineStore.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.vibe"
import * as StepBoundary from "../src/StepBoundary.vibe"
import * as TestStores from "../src/test/TestStores.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import { withCrypto } from "./Sha256.ts"

// No step here touches a workspace; Jj is only the host port the engine requires.
const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "keys" as never, changeId: "keys" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** A single-instance host: an earlier incarnation on this host is gone, because the host runs one at a time. */
const singleInstance: Ownership.LivenessCheck = (owner, context) =>
  owner.hostId === context.claimant.hostId
    ? Effect.succeed(false)
    : Ownership.leaseLiveness()(owner, context)

const older: Ownership.OwnerId = { hostId: "upgraded-host", pid: 1, nonce: "older" }
const newer: Ownership.OwnerId = { hostId: "upgraded-host", pid: 2, nonce: "newer" }

let directory: string
let filename: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "key-encoding-"))
  filename = PersistentDatabase.filename(join(directory, "engine.sqlite"))
})
afterEach(async () => {
  await PersistentDatabase.remove(filename)
  await rm(directory, { recursive: true, force: true })
})

const run = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | TestClock.TestClock | (EffectDigest.Digest | SecureRandom.SecureRandom)>
) => Effect.runPromise(withCrypto(Effect.scoped(effect).pipe(Effect.provide(TestClock.layer()))))

/** The sealed step under test: keyed by a declared string, so its key is a cache key the encoding shapes. */
const Measure = Action.make("KeyEncoding/Measure", {
  payload: {},
  success: Schema.Number,
  idempotencyKey: "measure",
  implementationVersion: "measure/v1"
})
/** The step the older incarnation dies in, after the sealed one recorded. */
const Finish = Action.make("KeyEncoding/Finish", {
  payload: { measured: Schema.Number },
  success: Schema.Number,
  tier: "irreversible",
  idempotencyKey: "finish"
})
const Upgraded = Flow.make("KeyEncoding/Upgraded", {
  payload: {},
  success: Schema.Number,
  body: () =>
    Measure.call({}).pipe(
      Node.bindPlanned(Node.capture({ finish: Finish.name }, (measured) => Finish.call({ measured })))
    )
})

/** What both incarnations did. */
interface Observed {
  readonly measured: Array<string>
  readonly finished: Array<string>
}

const incarnation = (
  owner: Ownership.OwnerId,
  encoding: FlowEngine.KeyEncoding,
  observed: Observed,
  died: Deferred.Deferred<void>
) =>
  Layer.build(
    Interpreter.layer(Upgraded).pipe(
      Layer.provideMerge(Layer.mergeAll(
        Measure.toLayer(() =>
          Effect.sync(() => {
            observed.measured.push(owner.nonce)
            return observed.measured.length * 10
          }), { implementationVersion: "measure/v1" }),
        Finish.toLayer(({ measured }) =>
          Effect.gen(function*() {
            observed.finished.push(owner.nonce)
            // The older engine dies here: the sealed step's record is already written, under its encoding.
            if (owner.nonce === "older") {
              yield* Deferred.succeed(died, undefined)
              return yield* Effect.never
            }
            return measured + 1
          })
        )
      )),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Layer.succeed(FlowEngine.ActionKeyEncoding)(encoding)),
      Layer.provideMerge(
        EngineStore.layer({
          owner: { hostId: owner.hostId },
          journalSource: `${owner.nonce}-engine`,
          isAlive: singleInstance,
          sweep: { host: "upgraded" }
        }).pipe(
          Layer.provide(OwnerIdentity.layerConstant(owner)),
          Layer.provideMerge(Layer.mergeAll(TestStores.layerAt(filename), StepBoundary.layerUnsupported, jj))
        )
      )
    )
  )

const upgraded = { executionId: "upgraded", payload: {} }

describe("a keyed sealed action across a key encoding change", () => {
  it("replays the outcome an engine recorded under the older encoding, without running the step again", () =>
    run(Effect.gen(function*() {
      const observed: Observed = { measured: [], finished: [] }
      const died = yield* Deferred.make<void>()
      const before = yield* incarnation(older, 2, observed, died)
      yield* (yield* Effect.provide(FlowRuntime.FlowRuntime, before)).execute(Upgraded, { ...upgraded, discard: true })
      yield* Deferred.await(died)

      const after = yield* incarnation(newer, FlowEngine.keyEncodings[0], observed, died)
      expect(yield* Effect.provide(EngineStore.drive(Upgraded, upgraded), after))
        .toEqual({ _tag: "Settled", status: "completed" })
      const settled = yield* (yield* Effect.provide(FlowRuntime.FlowRuntime, after)).poll(Upgraded, "upgraded")
      expect(Option.map(settled, (result) => result._tag === "Complete" && result.exit)).toEqual(
        Option.some(Exit.succeed(11))
      )
      // The sealed step ran once, on the older engine; the newer read its record under encoding 2.
      expect(observed.measured).toEqual(["older"])
      expect(observed.finished).toEqual(["older", "newer"])
    })))

  it("writes new records under the current encoding, which the next dispatch finds", () =>
    run(Effect.gen(function*() {
      const observed: Observed = { measured: [], finished: [] }
      const died = yield* Deferred.make<void>()
      const context = yield* incarnation(newer, FlowEngine.keyEncodings[0], observed, died)
      const runtime = yield* Effect.provide(FlowRuntime.FlowRuntime, context)
      expect(yield* runtime.execute(Upgraded, upgraded)).toBe(11)
      // A second drive of the settled run reads its record: nothing runs again.
      expect(yield* Effect.provide(EngineStore.drive(Upgraded, upgraded), context))
        .toEqual({ _tag: "Settled", status: "completed" })
      expect(observed.measured).toEqual(["newer"])
      expect(FlowEngine.keyEncodings[0]).toBe(3)
    })))
})
