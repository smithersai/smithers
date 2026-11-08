/**
 * `release/pack` through the flow API: the real graph, the real layer and a
 * real child process running `pack-release.mjs`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import { Schema } from "effect"
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
  assert.match(failure, /flows\/release\/pack-release\.mjs/)
}

test("the payload maps to the module's argument array", () => {
  assert.deepEqual(argv({ directory: "dist/release-packs" }), ["dist/release-packs"])
  assert.deepEqual(argv({ list: "directories" }), ["--list"])
  assert.deepEqual(argv({ list: "names" }), ["--names"])
})

test("a request names a directory or a list, not both or neither", () => {
  const decode = Schema.decodeUnknownExit(Request)
  assert.ok(Exit.isFailure(decode({})))
  assert.ok(Exit.isFailure(decode({ directory: "dist", list: "names" })))
  assert.ok(Exit.isSuccess(decode({ list: "names" })))
})

test("list prints the publication order", async () => {
  const exit = await run({ list: "names" }, "release-pack-names")
  assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
})

test("packing into a path under a regular file is a typed failure", async () => {
  // The module reads the roster and refuses an unbuilt or unwritable target.
  const blocked = new URL("./flow.ts/candidate", import.meta.url).pathname
  assertModuleFailed(await run({ directory: blocked }, "release-pack-blocked"))
})
