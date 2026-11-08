/**
 * `release/changelog` through the flow API: the real graph, the real layer and a
 * real child process running `generate-changelog.mjs`.
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
  assert.match(failure, /flows\/release\/generate-changelog\.mjs/)
}

test("the payload maps to the module's argument array", () => {
  assert.deepEqual(argv({}), [])
  assert.deepEqual(argv({ check: true, version: "1.0.0" }), ["--version", "1.0.0", "--check"])
  assert.deepEqual(argv({ version: "1.0.0", from: "v0.9.0", to: "HEAD" }), [
    "--version",
    "1.0.0",
    "--from",
    "v0.9.0",
    "--to",
    "HEAD"
  ])
})

test("a tag in place of a version is refused before anything is written", async () => {
  assertModuleFailed(await run({ version: "v1.0.0" }, "release-changelog-tag"))
})
