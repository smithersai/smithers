/**
 * `release/npm-dedupe` through the flow API: the real graph, the real layer and a
 * real child process running `check-npm-dedupe.mjs`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import Step, { argv, layer, Request } from "./flow.ts"

const run = (payload: typeof Request.Type, executionId: string) =>
  Effect.runPromiseExit(
    Step.execute(payload, { executionId }).pipe(
      Effect.provide(
        Interpreter.layerWithImplementations(Step, layer).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

/** The run failed as the module's typed exit, naming the module and nothing it printed. */
const assertModuleFailed = (exit: Exit.Exit<void, unknown>) => {
  assert.ok(Exit.isFailure(exit))
  const failure = JSON.stringify(exit.cause)
  assert.match(failure, /automation\/ModuleFailed/)
  assert.match(failure, /flows\/release\/check-npm-dedupe\.mjs/)
}

test("the payload maps to the module's argument array", () => {
  assert.deepEqual(argv({}), [])
  assert.deepEqual(argv({ maxPackages: 1200, keepTmp: true }), ["--max-packages", "1200", "--keep-tmp"])
})

// A passing check resolves the published set against the registry;
// `//.smithers/flows:npmDedupe` runs it. The module refuses an unusable budget first.
test("a budget that is not a positive integer is refused before any install", async () => {
  assertModuleFailed(await run({ maxPackages: 0 }, "release-npm-dedupe-budget"))
})
