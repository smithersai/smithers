import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { verifySoak } from "./check-soak-campaign.mjs"
import { parseWorkflow } from "./release-rehearsal.mjs"

const artifact = () => ({ schemaVersion: 1, status: "complete",
  runtime: { node: "v24.18.0", platform: "linux", arch: "x64" },
  candidate: { head: "a".repeat(40), dirty: false, sourceSha256: "b".repeat(64) },
  workload: { requestedMinutes: 1, warmupMs: 20_000, sampleIntervalMs: 10_000, seed: 20260904 },
  samples: [20_000, 30_000, 40_000, 50_000, 60_000].map((elapsedMs, index) => ({ elapsedMs, cycle: index + 1,
    emitted: (index + 1) * 8, connections: (index + 1) * 4, compactions: index + 1,
    retainedRows: 32, retainedCheckpoints: 1, slowSubscribers: 1, heapUsed: 1_000_000, rss: 2_000_000,
    handles: 2, sockets: 0, activeReads: 0, pendingWrites: 0, socketQueuedBytes: 0, journalQueued: 64,
    databaseBytes: 4096, walBytes: 8192 })),
  slopes: { heapUsed: 0, rss: 0, handles: 0, sockets: 0, activeReads: 0, pendingWrites: 0,
    socketQueuedBytes: 0, journalQueued: 0, databaseBytes: 0, walBytes: 0 },
  cleanup: { activeReads: 0, pendingWrites: 0, slowSubscribers: 0, sockets: 0 } })

test("soak evidence requires complete work, duration, seed, resources and post-warmup samples", () => {
  assert.equal(verifySoak(artifact(), { minutes: 1, seed: 20260904 }).samples, 5)
  for (const mutate of [
    (x) => { delete x.status }, (x) => { x.status = "failed" }, (x) => { x.samples.pop() },
    (x) => { x.samples[1].elapsedMs = x.samples[0].elapsedMs }, (x) => { x.samples[2].emitted-- },
    (x) => { x.samples[2].cycle = x.samples[1].cycle; x.samples[2].emitted = x.samples[1].emitted },
    (x) => { x.samples[2].pendingWrites = 1 }, (x) => { x.cleanup.activeReads = 1 },
    (x) => { x.workload.requestedMinutes = 2 }, (x) => { delete x.samples[1].walBytes },
    (x) => { x.samples[4].heapUsed += 10_000_000 }, (x) => { x.samples[4].rss += 20_000_000 },
    (x) => { x.samples[4].handles++ }, (x) => { x.samples[4].sockets++ },
    (x) => { delete x.slopes.walBytes }, (x) => { x.candidate.sourceSha256 = "missing" }
  ]) { const value = artifact(); mutate(value); assert.throws(() => verifySoak(value)) }
  assert.throws(() => verifySoak(artifact(), { minutes: 4 }))
  assert.throws(() => verifySoak(artifact(), { seed: 8 }))
})

test("soak receipts must match the scheduled runtime row", () => {
  verifySoak(artifact(), { node: "24.18.0" })
  assert.throws(() => verifySoak(artifact(), { node: "22.19.0" }), /runtime mismatch/)
  const node22 = artifact()
  node22.runtime.node = "v22.19.0"
  verifySoak(node22, { node: "22.19.0" })
  assert.throws(() => verifySoak(node22, { node: "24.18.0" }), /runtime mismatch/)
})

test("the soak CLI refuses absent and truncated JSON artifacts", () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-soak-verifier-"))
  const path = join(directory, "soak.json")
  try {
    for (const body of [undefined, '{"status":', JSON.stringify({ status: "failed" })]) {
      if (body !== undefined) writeFileSync(path, body)
      const result = spawnSync(process.execPath, [new URL("./check-soak-campaign.mjs", import.meta.url).pathname, path])
      assert.equal(result.status, 1)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("scheduled soak executes the scaled producer, verifies even on failure and retains artifacts", () => {
  const workflow = parseWorkflow(readFileSync(new URL("../.github/workflows/reliability.yml", import.meta.url), "utf8"))
  assert.ok(workflow.on.schedule.length > 0)
  const job = workflow.jobs["sync-long-soak"]
  assert.deepEqual(job.strategy.matrix.node, ["22.19.0", "24.18.0"])
  assert.equal(job.strategy["fail-fast"], false)
  assert.equal(job.env.SMITHERS_SOAK_NODE, "${{ matrix.node }}")
  assert.equal(job.steps.find((step) => step.uses?.startsWith("actions/setup-node@")).with["node-version"], "${{ matrix.node }}")
  assert.equal(job.env.SMITHERS_SOAK_MINUTES, "60")
  assert.equal(job.env.SMITHERS_SOAK_SEED, "20260904")
  assert.match(job.steps.find((step) => step.name === "Execute env-scaled sync soak directly").run,
    /vitest run test\/ServerLongSoak\.test\.ts --coverage.enabled=false --maxWorkers=1/)
  const verification = job.steps.find((step) => step.name === "Require completed soak artifact")
  assert.equal(verification.if, "always()")
  assert.match(verification.run, /check-soak-campaign\.mjs/)
  for (const [name, log] of [["Execute env-scaled sync soak directly", "workload.log"], ["Require completed soak artifact", "verifier.log"]]) {
    const step = job.steps.find((entry) => entry.name === name)
    assert.equal(step.shell, "bash")
    assert.match(step.run, /set -o pipefail/)
    assert.ok(step.run.includes(`tee reliability-artifacts/sync/${log}`))
  }
  const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))
  assert.equal(upload.if, "always()")
  assert.equal(upload.with["if-no-files-found"], "error")
  assert.equal(upload.with["retention-days"], 30)
  assert.ok(upload.with.name.includes("${{ matrix.node }}"))
})
