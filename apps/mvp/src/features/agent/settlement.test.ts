import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Flow, Interpreter } from "@smthrs/flow"
import { Engine } from "@smthrs/flows"
import { Node } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"
import { RunReporter } from "../status/reporter"
import { AnswerApi, AnswersUnavailable } from "./answers"
import { Ending, Settle, settle } from "./flows"
import { settlementLayers } from "./host"
import { AnswerProgress } from "./progress"
import { AnswerReference } from "./reference"

// The production settlement graph on the real durable engine, with only its API fault-injected.
test("settlement expiration releases progress after retries, preserving the terminal failure", async () => {
  const flow = Flow.make("test/AnswerSettlement", {
    payload: { answerId: Schema.String, ending: Ending },
    success: AnswerReference.successSchema,
    error: AnswerReference.errorSchema,
    body: Node.capture({ settle: Settle.name }, settle),
  })
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const attempted = yield* Deferred.make<void>()
    const api = AnswerApi.of({
      turn: () => Effect.die("unused"),
      heartbeat: () => Effect.void,
      write: () => Deferred.succeed(attempted, undefined).pipe(Effect.andThen(Effect.fail(new AnswersUnavailable({ status: 503 })))),
    })
    const progressLayer = AnswerProgress.layer("10000 seconds").pipe(Layer.provide(Layer.succeed(AnswerApi, api)))
    const runtime = Interpreter.layerWithImplementations(flow, settlementLayers).pipe(
      Layer.provideMerge(Engine.FlowEngine.layerMemory),
      Layer.provideMerge(progressLayer),
      Layer.provide(Layer.succeed(AnswerApi, api)),
      Layer.provide(Layer.succeed(RunReporter, RunReporter.of({ report: () => Effect.die("must not report success"), reportOrFail: () => Effect.die("unused") }))),
    )
    return yield* Effect.gen(function* () {
      const progress = yield* AnswerProgress
      yield* progress.record("a", { _tag: "model-requested" } as never)
      const fiber = yield* Effect.exit(flow.execute({ answerId: "a", ending: { text: "Done", timedOut: false } }, { executionId: "expiry" })).pipe(Effect.forkChild)
      yield* Deferred.await(attempted)
      expect(yield* progress.get("a")).toBeDefined()
      yield* TestClock.adjust("11 minutes")
      return { exit: yield* Fiber.join(fiber), retained: yield* progress.get("a") }
    }).pipe(Effect.provide(runtime))
  })).pipe(Effect.provide(NodeCrypto.layer), Effect.provide(TestClock.layer())))
  expect(Exit.isFailure(result.exit) ? Cause.squash(result.exit.cause) : result.exit).toEqual(new AnswersUnavailable({ status: 503 }))
  expect(result.retained).toBeUndefined()
})
