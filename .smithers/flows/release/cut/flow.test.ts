/**
 * `release/cut` through the flow API: the real graph, the real layer and a
 * real child process running `cut-release.mjs`.
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
  assert.match(failure, /flows\/release\/cut-release\.mjs/)
}

test("the payload maps to the module's argument array", () => {
  assert.deepEqual(argv({ version: "1.0.0" }), ["1.0.0"])
  assert.deepEqual(argv({ version: "1.0.0", commit: true }), ["1.0.0", "--commit"])
  assert.deepEqual(argv({ version: "1.0.0", commit: true, allowBranch: true }), ["1.0.0", "--commit", "--allow-branch"])
})

// A successful cut rewrites the checkout; `cut-release.test.mjs` drives one in a
// scratch repository. These refusals happen before the module reads the tree.
test("a tag in place of a version is refused", async () => {
  assertModuleFailed(await run({ version: "v1.0.0" }, "release-cut-tag"))
})

test("allowBranch without commit is refused", async () => {
  assertModuleFailed(await run({ version: "1.0.0", allowBranch: true }, "release-cut-branch"))
})
