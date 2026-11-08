/**
 * `release/version` through the flow API: the real graph, the real layer and a
 * real child process running `set-release-version.mjs`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
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
  assert.match(failure, /flows\/release\/set-release-version\.mjs/)
}

const current = JSON.parse(
  readFileSync(new URL("../../../../packages/smithers/package.json", import.meta.url), "utf8")
).version as string

test("the payload maps to the module's argument array", () => {
  assert.deepEqual(argv({ version: "1.0.0" }), ["1.0.0"])
  assert.deepEqual(argv({ version: "1.0.0", check: true }), ["--check", "1.0.0"])
  assert.deepEqual(argv({ version: "1.0.0", check: false }), ["1.0.0"])
})

test("check passes at the version the tree carries", async () => {
  const exit = await run({ version: current, check: true }, "release-version-check")
  assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
})

test("check fails at a version the tree does not carry", async () => {
  assertModuleFailed(await run({ version: "0.0.1-never", check: true }, "release-version-mismatch"))
})
