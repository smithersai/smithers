import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * A keyed sealed action whose declaration carries `Schema.brand` replays the
 * outcome an engine recorded before the `effect@4.0.4` upgrade.
 *
 * Under `effect@4.0.0-rc.115` a brand was part of the schema's representation,
 * so the sealed step's key hashed it. From 4.0.4 on a brand is not part of the
 * AST, and the current key encoding (2) hashes the brandless document: before
 * key encodings, a run parked across the upgrade looked its sealed step up
 * under the new key, missed, and ran the step again.
 *
 * The first incarnation writes encoding 1, the rc.115 identity, records the
 * sealed step and dies inside the next one. The second writes the current
 * encoding and takes the run over: it must find the record under encoding 1
 * and replay it, never running the step's body again.
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
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import { withCrypto } from "./Sha256.ts"

// No step here touches a workspace; Jj is only the host port the engine requires.
const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "brands" as never, changeId: "brands" as never }),
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
  directory = await mkdtemp(join(tmpdir(), "branded-declaration-"))
  filename = PersistentDatabase.filename(join(directory, "engine.sqlite"))
})
afterEach(async () => {
  await PersistentDatabase.remove(filename)
  await rm(directory, { recursive: true, force: true })
})

const run = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | TestClock.TestClock | (EffectDigest.Digest | SecureRandom.SecureRandom)>
) => Effect.runPromise(withCrypto(Effect.scoped(effect).pipe(Effect.provide(TestClock.layer()))))

/** A branded count, as a declaration written before the upgrade spelled it. */
const Count = Schema.Int.pipe(Schema.brand("BrandedDeclarationReplay/Count"))

/** The sealed step under test: keyed by a declared string, so its key hashes its branded declaration. */
const Measure = Action.make("BrandedDeclarationReplay/Measure", {
  payload: {},
  success: Schema.Struct({ count: Count }),
  idempotencyKey: "measure",
  implementationVersion: "measure/v1"
})
/** The step the older incarnation dies in, after the sealed one recorded. */
const Finish = Action.make("BrandedDeclarationReplay/Finish", {
  payload: { count: Schema.Int },
  success: Schema.Int,
  tier: "irreversible",
  idempotencyKey: "finish"
})
const Upgraded = Flow.make("BrandedDeclarationReplay/Upgraded", {
  payload: {},
  success: Schema.Int,
  body: () =>
    Measure.call({}).pipe(
      Node.bindPlanned(Node.capture({ finish: Finish.name }, (measured) => Finish.call({ count: measured.count })))
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
            return { count: Count.make(observed.measured.length * 10) }
          }), { implementationVersion: "measure/v1" }),
        Finish.toLayer(({ count }) =>
          Effect.gen(function*() {
            observed.finished.push(owner.nonce)
            // The older engine dies here: the sealed step's record is already written, under its encoding.
            if (owner.nonce === "older") {
              yield* Deferred.succeed(died, undefined)
              return yield* Effect.never
            }
            return count + 1
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

describe("a branded sealed declaration across the effect@4.0.4 upgrade", () => {
  it("replays the outcome recorded under the rc.115 identity, without running the step again", () =>
    run(Effect.gen(function*() {
      const observed: Observed = { measured: [], finished: [] }
      const died = yield* Deferred.make<void>()
      const before = yield* incarnation(older, 1, observed, died)
      yield* (yield* Effect.provide(FlowRuntime.FlowRuntime, before)).execute(Upgraded, { ...upgraded, discard: true })
      yield* Deferred.await(died)

      const after = yield* incarnation(newer, FlowEngine.keyEncodings[0], observed, died)
      expect(yield* Effect.provide(EngineStore.drive(Upgraded, upgraded), after))
        .toEqual({ _tag: "Settled", status: "completed" })
      const settled = yield* (yield* Effect.provide(FlowRuntime.FlowRuntime, after)).poll(Upgraded, "upgraded")
      expect(Option.map(settled, (result) => result._tag === "Complete" && result.exit)).toEqual(
        Option.some(Exit.succeed(11))
      )
      // The sealed step ran once, on the older engine; the newer read its record under encoding 1.
      expect(observed.measured).toEqual(["older"])
      expect(observed.finished).toEqual(["older", "newer"])
    })))

  it("writes a new run's record under the current encoding, which the next drive finds", () =>
    run(Effect.gen(function*() {
      const observed: Observed = { measured: [], finished: [] }
      const died = yield* Deferred.make<void>()
      const context = yield* incarnation(newer, FlowEngine.keyEncodings[0], observed, died)
      const runtime = yield* Effect.provide(FlowRuntime.FlowRuntime, context)
      expect(yield* runtime.execute(Upgraded, upgraded)).toBe(11)
      expect(yield* Effect.provide(EngineStore.drive(Upgraded, upgraded), context))
        .toEqual({ _tag: "Settled", status: "completed" })
      expect(observed.measured).toEqual(["newer"])
    })))
})
