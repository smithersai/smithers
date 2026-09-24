import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins the dispatch line an operator reads against `@smthrs/journal`'s
 * redaction rule.
 *
 * `RedactedLogger.layer()` is installed by `packages/smithers/flows`' `NodeRuntime` and
 * by the `smithers` binary, so every log line this package emits in production
 * passes through `Redaction.isSensitiveKey`. That predicate replaces the value
 * of any field whose name is a standalone trailing `key` word, which is what a
 * field named exactly `key` is. A dispatch annotated under that name therefore
 * reached the operator as `key=[REDACTED]`: the step identity — the single
 * field that says WHICH dispatch a line describes — was destroyed on the way
 * out, and no test noticed because nothing read a redacted log.
 *
 * The names this package annotates with are part of its observability
 * contract, so this test drives a real dispatch through a real
 * `RedactedLogger`-wrapped logger and asserts the step key survives in both
 * the message and the annotations.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow } from "@smthrs/flow"
import { RedactedLogger } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const LoggingFlow = Flow.make("DispatchLogFields/Flow", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "dispatch-log-snapshot" as never, changeId: "dispatch-log-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const baseLayers = Layer.mergeAll(
  TestStores.layer(),
  StepBoundary.layerTest(),
  Layer.succeed(Jj.Jj, jj),
  Layer.succeed(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory())
)

const charge = Action.make({
  name: "DispatchLogFields/charge",
  tier: "sealed",
  idempotencyKey: "dispatch-log-fields-key",
  success: Schema.String,
  execute: Effect.succeed("charged")
})

/** Every value the redactor left in one captured log event, flattened to text. */
const renderedValues = (
  event: { readonly message: unknown; readonly annotations: unknown }
): string => JSON.stringify([event.message, event.annotations])

/**
 * The step key a dispatch line names, wherever the logger carried it.
 *
 * The engine mints it from the action's content key, so the test cannot spell
 * it: what it asserts is that the durable `key<version>_<digest>` shape
 * reaches the operator instead of a placeholder.
 */
const loggedStepKey = (
  event: { readonly message: unknown; readonly annotations: unknown }
): unknown => {
  for (const part of [...(Array.isArray(event.message) ? event.message : [event.message]), event.annotations]) {
    if (typeof part === "object" && part !== null && "stepKey" in part) {
      return (part as { readonly stepKey: unknown }).stepKey
    }
  }
  return undefined
}

describe("dispatch log fields survive journal redaction", () => {
  it.effect("names the step key so the redactor does not replace it", () =>
    Effect.gen(function*() {
      const events: Array<{ message: unknown; annotations: unknown }> = []
      const capture = RedactedLogger.wrap(
        Logger.make((options) => {
          events.push({
            message: options.message,
            annotations: options.fiber.getRef(References.CurrentLogAnnotations)
          })
        })
      )

      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const engine = yield* EngineStore.make({
            owner: { hostId: "dispatch-log-host" },
            journalSource: "dispatch-log-test",
            isAlive: () => Effect.succeed(true)
          })
          yield* engine.register(LoggingFlow, () => charge)
          return yield* engine.execute(LoggingFlow, {
            executionId: "dispatch-log-run",
            payload: {},
            discard: false
          })
        })).pipe(
          Effect.provide(baseLayers),
          Effect.provide(Layer.merge(
            Logger.layer([capture]),
            Layer.succeed(References.MinimumLogLevel, "Trace")
          ))
        )
      )

      expect(result).toBe("charged")

      const dispatchEvents = events.filter((event) => renderedValues(event).includes("action dispatch"))
      // Both the started and the settled line.
      expect(dispatchEvents).toHaveLength(2)
      for (const event of dispatchEvents) {
        // The step key reaches the operator as the durable identity itself…
        expect(loggedStepKey(event)).toMatch(/^key\d+_[0-9a-f]{64}$/)
        // …and no field on the line was replaced wholesale.
        expect(renderedValues(event)).not.toContain("[REDACTED]")
      }
    }))
})
