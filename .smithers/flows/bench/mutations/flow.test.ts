/**
 * `bench/mutations` through the flow API: the real graph, the real layer and a
 * real child process running `check-mutations.mjs`. A passing run executes every
 * declared mutant, minutes of Vitest work, and is the `//.smithers/flows:mutationGate`
 * target itself; this suite proves the refusal path.
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
import Mutations, { layer } from "./flow.ts"

const run = (executionId: string) =>
  Effect.runPromiseExit(
    Mutations.execute({}, { executionId }).pipe(
      Effect.provide(
        Interpreter.layerWithImplementations(Mutations, layer).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

const withArtifacts = async (body: (directory: string) => Promise<void>) => {
  const directory = mkdtempSync(join(tmpdir(), "bench-mutations-flow-"))
  const previous = process.env.SMITHERS_MUTATION_ARTIFACT_DIR
  process.env.SMITHERS_MUTATION_ARTIFACT_DIR = directory
  try {
    await body(directory)
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_MUTATION_ARTIFACT_DIR
    else process.env.SMITHERS_MUTATION_ARTIFACT_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
}

test("prior evidence is refused as a typed failure and kept", async () => {
  await withArtifacts(async (directory) => {
    writeFileSync(join(directory, "failure.json"), "prior failure")
    const exit = await run("bench-mutations-stale")
    assert.ok(Exit.isFailure(exit))
    assert.match(JSON.stringify(exit.cause), /bench\/mutations\/check-mutations\.mjs/)
    assert.equal(readFileSync(join(directory, "failure.json"), "utf8"), "prior failure")
  })
})
