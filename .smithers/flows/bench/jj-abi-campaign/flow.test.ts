/**
 * `bench/jj-abi-campaign` through the flow API: the real graph, the real layer
 * and a real child process running `run-jj-abi-campaign.mjs`. The parser
 * verification phase is the cheap deterministic path; the tiers themselves
 * are covered by `run-jj-abi-campaign.test.mjs`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import JjAbiCampaign, { argv, layer, Request } from "./flow.ts"

const run = (payload: typeof Request.Type, executionId: string) =>
  Effect.runPromiseExit(
    JjAbiCampaign.execute(payload, { executionId }).pipe(
      Effect.provide(
        Interpreter.layerWithImplementations(JjAbiCampaign, layer).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

const names = ["SMITHERS_ABI_SEED", "SMITHERS_ABI_CASES", "SMITHERS_ABI_STEPS", "SMITHERS_ABI_ARTIFACT_DIR"] as const

const withEvidence = async (
  env: Partial<Record<(typeof names)[number], string>>,
  body: (directory: string) => Promise<void>
) => {
  const directory = mkdtempSync(join(tmpdir(), "jj-abi-campaign-flow-"))
  const previous = names.map((name) => [name, process.env[name]] as const)
  for (const name of names) delete process.env[name]
  Object.assign(process.env, { SMITHERS_ABI_ARTIFACT_DIR: directory, ...env })
  try {
    await body(directory)
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

const parser = (seed: number, cases: number) => ({
  schemaVersion: 1,
  tier: "parser",
  status: "passed",
  seed,
  requestedCases: cases,
  executedRawCases: cases,
  executedGrammarCases: cases
})

test("the payload maps to the campaign's command line", () => {
  assert.deepEqual(argv({}), [])
  assert.deepEqual(argv({ phase: "run", seed: 7 }), ["--seed", "7"])
  assert.deepEqual(argv({ phase: "verify-parser" }), ["--verify-parser"])
  assert.deepEqual(argv({ phase: "verify-parser", seed: 0 }), ["--verify-parser", "--seed", "0"])
})

test("a seed outside the unsigned 32-bit range is refused by the payload", () => {
  const decode = Schema.decodeUnknownExit(Request)
  assert.ok(Exit.isSuccess(decode({ seed: 4294967295 })))
  for (const seed of [-1, 4294967296, 1.5]) assert.ok(Exit.isFailure(decode({ seed })))
})

test("the sanitizer replay's parser report verifies under the payload's seed", async () => {
  await withEvidence({ SMITHERS_ABI_SEED: "1", SMITHERS_ABI_CASES: "3" }, async (directory) => {
    writeFileSync(join(directory, "parser.json"), JSON.stringify(parser(42, 3)))
    const exit = await run({ phase: "verify-parser", seed: 42 }, "jj-abi-verify-pass")
    assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
  })
})

test("a parser report for another seed is a typed failure", async () => {
  await withEvidence({ SMITHERS_ABI_SEED: "1", SMITHERS_ABI_CASES: "3" }, async (directory) => {
    writeFileSync(join(directory, "parser.json"), JSON.stringify(parser(1, 3)))
    const exit = await run({ phase: "verify-parser", seed: 42 }, "jj-abi-verify-seed")
    assert.ok(Exit.isFailure(exit))
    assert.match(JSON.stringify(exit.cause), /bench\/jj-abi-campaign\/run-jj-abi-campaign\.mjs/)
  })
})

test("a run refuses to overwrite existing evidence before any tier starts", async () => {
  await withEvidence({}, async (directory) => {
    writeFileSync(join(directory, "native.json"), "original evidence")
    const exit = await run({ seed: 0 }, "jj-abi-run-existing")
    assert.ok(Exit.isFailure(exit))
    assert.equal(readFileSync(join(directory, "native.json"), "utf8"), "original evidence")
  })
})
