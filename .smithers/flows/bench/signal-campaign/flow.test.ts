/**
 * `bench/signal-campaign` through the flow API: the real graph, the real layer
 * and a real child process running `check-signal-campaign.mjs`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import SignalCampaign, { argv, layer, type Request } from "./flow.ts"

const run = (payload: typeof Request.Type, executionId: string) =>
  Effect.runPromiseExit(
    SignalCampaign.execute(payload, { executionId }).pipe(
      Effect.provide(
        Interpreter.layerWithImplementations(SignalCampaign, layer).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

// Seed 7, two cases of two steps: the second case's seed derives from the first.
const seeds = [7, (7 + Math.imul(1, 0x9e3779b9)) >>> 0]
const evidence = (seed: number) => ({
  status: "passed",
  seed,
  steps: 2,
  history: [{ kind: "reopen" }, { kind: "admit" }],
  reopenCount: 1,
  finalState: []
})

const withCampaign = async (body: (directory: string) => Promise<void>) => {
  const directory = mkdtempSync(join(tmpdir(), "signal-campaign-flow-"))
  const configuration = { SMITHERS_FUZZ_SEED: "7", SMITHERS_FUZZ_CASES: "2", SMITHERS_FUZZ_STEPS: "2" }
  const previous = Object.keys(configuration).map((name) => [name, process.env[name]] as const)
  Object.assign(process.env, configuration)
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

test("the payload maps to the verifier's argument", () => {
  assert.deepEqual(argv({ directory: "reliability-artifacts" }), ["reliability-artifacts"])
})

test("every seeded case present and passed verifies", async () => {
  await withCampaign(async (directory) => {
    for (const seed of seeds) {
      writeFileSync(join(directory, `signal-inbox-${seed}.json`), JSON.stringify(evidence(seed)))
    }
    const exit = await run({ directory }, "signal-campaign-pass")
    assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
  })
})

test("a missing case is a typed failure", async () => {
  await withCampaign(async (directory) => {
    writeFileSync(join(directory, `signal-inbox-${seeds[0]}.json`), JSON.stringify(evidence(seeds[0]!)))
    const exit = await run({ directory }, "signal-campaign-missing")
    assert.ok(Exit.isFailure(exit))
    assert.match(JSON.stringify(exit.cause), /bench\/signal-campaign\/check-signal-campaign\.mjs/)
  })
})
