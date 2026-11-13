/**
 * Issue #124: every `cacheProvenance` emission used the plain `source(deps)`
 * identity with no `sourceSeq`, so each re-drive of the same observation —
 * the same replay refusal against the same recorded row, on every later
 * dispatch of the key — appended a fresh journal row forever. The emissions
 * now carry a per-(key, action, recorded-provenance) producer identity with
 * `sourceSeq 0`, so an identical re-observation collapses into a `Duplicate`
 * while a genuinely new observation (against a different recorded row) still
 * journals.
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal } from "@smthrs/journal"
import { type Ownership } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { activate, jj as jjLayer } from "./CachePolicyFixtures.ts"
import { withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "provenance-idem-host", pid: 53, nonce: "provenance-idem-process" }

const declared: ActionPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

/** A boundary that verifies the hit but can never rematerialize the row. */
const unreplayableBoundary = Layer.succeed(
  StepBoundary.StepBoundary,
  StepBoundary.make({
    prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }),
    settle: (prepared) =>
      Effect.succeed({ declaredOutputs: { paths: prepared.descriptor.writeSet }, diffIdentity: "idem-diff" }),
    replayOutputs: () =>
      Effect.fail(
        new StepBoundary.UnsupportedBoundary({
          code: "unsupported_boundary",
          message: "this host can never rematerialize the recorded evidence"
        })
      )
  })
)

const provenance = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 100 })
    return page.entries
      .filter((entry) => entry.eventType === "flows.engine.cache-provenance")
      .map((entry) => entry.payload as { readonly action?: string })
  })

describe("cacheProvenance emissions are idempotent per observation (issue #124)", () => {
  it.effect("re-driving the same replay refusal journals exactly one replay_failed row", () =>
    Effect.gen(function*() {
      const key = "provenance-idem/replay-refused"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          // First run records the shared row under a healthy boundary.
          yield* activate("provenance-idem-first", owner)
          yield* ActionPersistence.make({
            runId: "provenance-idem-first",
            owner,
            sourceId: "provenance-idem-first",
            execute: () => Effect.succeed("recorded")
          })({ action: {}, attempt: 1, key, tier: "sealed", metadata: declared }).pipe(
            Effect.provide(StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) }))
          )
          // Second run's boundary verifies the hit but can never replay it,
          // and its body fails — so the same refusal is observed again on the
          // next dispatch of the very same key and attempt.
          yield* activate("provenance-idem-second", owner)
          const execute = ActionPersistence.make({
            runId: "provenance-idem-second",
            owner,
            sourceId: "provenance-idem-second",
            execute: () => Effect.fail("body broken")
          })
          const dispatch = execute({ action: {}, attempt: 1, key, tier: "sealed", metadata: declared }).pipe(
            Effect.provide(unreplayableBoundary),
            Effect.exit
          )
          const first = yield* dispatch
          const second = yield* dispatch
          const records = yield* provenance("provenance-idem-second")
          return { first, second, records }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.first._tag).toBe("Failure")
      expect(outcome.second._tag).toBe("Failure")
      // The identical re-observation collapsed into a journal Duplicate:
      // exactly one replay_failed row, not one per dispatch.
      expect(outcome.records.filter((record) => record.action === "replay_failed")).toHaveLength(1)
    }))
})
