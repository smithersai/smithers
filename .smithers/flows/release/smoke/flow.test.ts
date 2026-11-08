/**
 * `release/smoke` through the flow API: the real graph, the real layer and a
 * real child process running `smoke-release.mjs`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
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
  assert.match(failure, /flows\/release\/smoke-release\.mjs/)
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
  assert.deepEqual(argv({ directory: "dist/release-packs" }), ["dist/release-packs"])
})

// A passing smoke installs every packed tarball; `//.smithers/flows:releaseSmoke` runs it.
test("a directory with no candidate is a typed failure", async () => {
  await inTemporary(async (directory) => {
    assertModuleFailed(await run({ directory }, "release-smoke-empty"))
  })
})
