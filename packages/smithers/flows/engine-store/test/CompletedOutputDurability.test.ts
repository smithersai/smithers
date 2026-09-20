/**
 * A run must never be durably `completed` before its output is readable.
 *
 * Two production runs of `repository-jobs/issues` answered `completed`; one
 * had its final output document and one did not, and the e2e lane now polls
 * for the document, which hides the race rather than closing it.
 *
 * The run row itself is not the gap: `RunStore.transitionOwned` sets `status`
 * and `state_json` in one UPDATE, so nothing can read a completed row whose
 * `result` is missing. The gap is the terminal decision record. It is emitted
 * inside the terminal transaction, but the journal's writer is a queue: the
 * run row commits, a reader sees `completed`, and the record carrying the
 * output is still in memory. Every reader that answers "what did this run
 * produce" from the journal — the gateway's run summary among them — can
 * therefore observe completion before the output exists for it.
 *
 * These cases read the journal WITHOUT flushing it, which is the only way to
 * observe what a separate reader observes.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const OutputFlow = Flow.make("CompletedOutputDurability/Flow", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const noopJj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "output-durability" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const layers = Layer.mergeAll(
  TestStores.layer(),
  StepBoundary.layerTest(),
  Layer.succeed(Jj.Jj, noopJj),
  Layer.succeed(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory())
)

/** One run driven to completion, read back exactly as a separate reader would read it. */
const observe = (executionId: string, output: string) =>
  withCrypto(
    Effect.scoped(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.register(OutputFlow, () => Effect.succeed(output))
      yield* engine.execute(OutputFlow, { executionId, payload: {}, discard: false })
      const row = yield* (yield* RunStore.RunStore).get(executionId)
      // Deliberately unflushed: a reader in another process cannot flush this
      // writer, and the production symptom is exactly what such a reader sees.
      const page = yield* (yield* Journal.Journal).entries({ runId: executionId as never, limit: 200 })
      return { row, entries: page.entries }
    })).pipe(
      Effect.provide(
        EngineStore.layer({
          owner: { hostId: "output-durability-host" },
          journalSource: "output-durability",
          isAlive: () => Effect.succeed(true)
        }).pipe(Layer.provideMerge(layers))
      ),
      Effect.scoped
    )
  )

describe("a completed run's output is durable wherever its completion is", () => {
  it.effect("writes the run's status and its output in one row write", () =>
    Effect.gen(function*() {
      const { row } = yield* observe("output-row", "the output document")
      expect(row.status).toBe("completed")
      expect(JSON.parse(row.stateJson)).toMatchObject({
        result: { _tag: "Complete", exit: { _tag: "Success", value: "the output document" } }
      })
    }))

  it.effect("makes the terminal decision carrying that output readable the moment the run is completed", () =>
    Effect.gen(function*() {
      const { entries, row } = yield* observe("output-decision", "the output document")
      expect(row.status).toBe("completed")
      const terminal = entries.filter((entry) =>
        entry.eventType === "flows.engine.run-decision" &&
        (entry.payload as { readonly status?: unknown }).status === "completed"
      )
      expect(terminal).toHaveLength(1)
      expect(terminal[0]!.payload).toMatchObject({
        decision: "transitioned",
        state: { result: { _tag: "Complete", exit: { _tag: "Success", value: "the output document" } } }
      })
    }))
})
