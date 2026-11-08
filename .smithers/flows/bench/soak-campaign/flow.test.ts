/**
 * `bench/soak-campaign` through the flow API: the real graph, the real layer
 * and a real child process running `check-soak-campaign.mjs`.
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
import SoakCampaign, { argv, layer, type Request } from "./flow.ts"

const run = (payload: typeof Request.Type, executionId: string) =>
  Effect.runPromiseExit(
    SoakCampaign.execute(payload, { executionId }).pipe(
      Effect.provide(
        Interpreter.layerWithImplementations(SoakCampaign, layer).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

// A one-minute soak on the 26.10.0 row with flat resource use.
const artifact = () => ({
  schemaVersion: 1,
  status: "complete",
  runtime: { node: "v26.10.0", platform: "linux", arch: "x64" },
  candidate: { head: "a".repeat(40), dirty: false, sourceSha256: "b".repeat(64) },
  workload: { requestedMinutes: 1, warmupMs: 20_000, sampleIntervalMs: 10_000, seed: 20260904 },
  samples: [20_000, 30_000, 40_000, 50_000, 60_000].map((elapsedMs, index) => ({
    elapsedMs,
    cycle: index + 1,
    emitted: (index + 1) * 8,
    connections: (index + 1) * 4,
    compactions: index + 1,
    retainedRows: 32,
    retainedCheckpoints: 1,
    slowSubscribers: 1,
    heapUsed: 1_000_000,
    rss: 2_000_000,
    handles: 2,
    sockets: 0,
    activeReads: 0,
    pendingWrites: 0,
    socketQueuedBytes: 0,
    journalQueued: 64,
    databaseBytes: 4096,
    walBytes: 8192
  })),
  slopes: {
    heapUsed: 0,
    rss: 0,
    handles: 0,
    sockets: 0,
    activeReads: 0,
    pendingWrites: 0,
    socketQueuedBytes: 0,
    journalQueued: 0,
    databaseBytes: 0,
    walBytes: 0
  },
  cleanup: { activeReads: 0, pendingWrites: 0, slowSubscribers: 0, sockets: 0 }
})

const withArtifact = async (body: unknown, check: (path: string) => Promise<void>) => {
  const directory = mkdtempSync(join(tmpdir(), "soak-campaign-flow-"))
  const path = join(directory, "sync-soak.json")
  const names = ["SMITHERS_SOAK_MINUTES", "SMITHERS_SOAK_SEED", "SMITHERS_SOAK_NODE"] as const
  const previous = names.map((name) => [name, process.env[name]] as const)
  for (const name of names) delete process.env[name]
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body))
  try {
    await check(path)
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

test("the payload maps to the verifier's argument", () => {
  assert.deepEqual(argv({ artifact: "reliability-artifacts/sync/sync-soak.json" }), [
    "reliability-artifacts/sync/sync-soak.json"
  ])
})

test("complete soak evidence on the scheduled row verifies", async () => {
  await withArtifact(artifact(), async (path) => {
    process.env.SMITHERS_SOAK_MINUTES = "1"
    process.env.SMITHERS_SOAK_SEED = "20260904"
    process.env.SMITHERS_SOAK_NODE = "26.10.0"
    const exit = await run({ artifact: path }, "soak-campaign-pass")
    assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
  })
})

test("truncated evidence and a runtime mismatch are typed failures", async () => {
  await withArtifact("{\"status\":", async (path) => {
    const exit = await run({ artifact: path }, "soak-campaign-truncated")
    assert.ok(Exit.isFailure(exit))
    assert.match(JSON.stringify(exit.cause), /bench\/soak-campaign\/check-soak-campaign\.mjs/)
  })
  await withArtifact(artifact(), async (path) => {
    process.env.SMITHERS_SOAK_NODE = "26.4.0"
    const exit = await run({ artifact: path }, "soak-campaign-runtime")
    assert.ok(Exit.isFailure(exit))
  })
})
