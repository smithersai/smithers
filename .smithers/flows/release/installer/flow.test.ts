/**
 * `release/installer` through the flow API: the real graph, the real layer and a
 * real child process running `installer-release.mjs`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import { Schema } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  assert.match(failure, /flows\/release\/installer-release\.mjs/)
}

/** Runs `body` in a fresh temporary directory, removed after. */
const inTemporary = async <A>(body: (directory: string) => Promise<A>) => {
  const directory = mkdtempSync(join(tmpdir(), "release-flow-"))
  try {
    return await body(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test("the payload maps to the module's argument array", () => {
  assert.deepEqual(argv({ command: "pack", directory: "packs", tag: "v1.0.0", output: "out" }), [
    "pack",
    "packs",
    "v1.0.0",
    "out"
  ])
  assert.deepEqual(argv({ command: "verify", directory: "assets", tag: "v1.0.0" }), ["verify", "assets", "v1.0.0"])
})

test("only pack takes an output directory", () => {
  const decode = Schema.decodeUnknownExit(Request)
  assert.ok(Exit.isFailure(decode({ command: "pack", directory: "packs", tag: "v1.0.0" })))
  assert.ok(Exit.isFailure(decode({ command: "sign", directory: "assets", tag: "v1.0.0", output: "out" })))
})

// Building and signing archives needs a packed candidate and Cosign;
// `installer-release.test.mjs` covers them. Verification of nothing fails.
test("verifying an empty archive set is a typed failure", async () => {
  await inTemporary(async (directory) => {
    assertModuleFailed(await run({ command: "verify", directory, tag: "v1.0.0" }, "release-installer-empty"))
  })
})
