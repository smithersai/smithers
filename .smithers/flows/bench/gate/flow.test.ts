/**
 * `bench/gate` through the flow API: the real graph, the real layer and a real
 * child process running `gate.mjs`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import BenchGate, { argv, layer, nodeArgs, type Request } from "./flow.ts"

const run = (payload: typeof Request.Type, executionId: string) =>
  Effect.runPromiseExit(
    BenchGate.execute(payload, { executionId }).pipe(
      Effect.provide(
        Interpreter.layerWithImplementations(BenchGate, layer).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

const withArtifacts = async (body: (directory: string) => Promise<void>) => {
  const directory = mkdtempSync(join(tmpdir(), "bench-gate-flow-"))
  const previous = process.env.SMITHERS_BENCH_ARTIFACT_DIR
  process.env.SMITHERS_BENCH_ARTIFACT_DIR = directory
  try {
    await body(directory)
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_BENCH_ARTIFACT_DIR
    else process.env.SMITHERS_BENCH_ARTIFACT_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
}

test("the payload maps to the gate's command line", () => {
  assert.deepEqual(argv({}), [])
  assert.deepEqual(argv({ measure: true, candidate: true }), ["--measure", "--candidate"])
  assert.deepEqual(argv({ measure: false }), [])
  assert.deepEqual(nodeArgs({ exposeGc: true }), ["--expose-gc"])
  assert.deepEqual(nodeArgs({}), [])
})

test("a nonempty artifact directory is refused as a typed failure and kept", async () => {
  await withArtifacts(async (directory) => {
    writeFileSync(join(directory, "failure.json"), "prior failure")
    const exit = await run({}, "bench-gate-stale")
    assert.ok(Exit.isFailure(exit))
    assert.match(JSON.stringify(exit.cause), /bench\/gate\/gate\.mjs/)
    assert.equal(readFileSync(join(directory, "failure.json"), "utf8"), "prior failure")
  })
})

test("the counter gate passes every fixture against the baseline", async () => {
  await withArtifacts(async (directory) => {
    const exit = await run({ exposeGc: true }, "bench-gate-pass")
    assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
    const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"))
    assert.equal(result.status, "passed")
    assert.equal(result.mode, "pr-counter-gate")
    assert.equal(result.gcExposed, true)
  })
})
