import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { nodeReleases } from "../../../../packages/smithers/flows/sync/test/soakArtifact.ts"
import { expectation } from "./check-soak-campaign.mjs"
import { parseWorkflow } from "../../release/release-rehearsal.mjs"

const artifact = () => ({ schemaVersion: 1, status: "complete",
  runtime: { node: "v26.10.0", platform: "linux", arch: "x64" },
  candidate: { head: "a".repeat(40), dirty: false, sourceSha256: "b".repeat(64) },
  workload: { requestedMinutes: 1, warmupMs: 20_000, sampleIntervalMs: 10_000, seed: 20260904 },
  samples: [20_000, 30_000, 40_000, 50_000, 60_000].map((elapsedMs, index) => ({ elapsedMs, cycle: index + 1,
    emitted: (index + 1) * 8, connections: (index + 1) * 4, compactions: index + 1,
    retainedRows: 32, retainedCheckpoints: 1, slowSubscribers: 1, heapUsed: 1_000_000, rss: 2_000_000,
    handles: 2, sockets: 0, activeReads: 0, pendingWrites: 0, socketQueuedBytes: 0, journalQueued: 64,
    databaseBytes: 4096, walBytes: 8192 })),
  slopes: { heapUsed: 0, rss: 0, handles: 0, sockets: 0, activeReads: 0,
    socketQueuedBytes: 0, journalQueued: 0, databaseBytes: 0, walBytes: 0 },
  cleanup: { activeReads: 0, pendingWrites: 0, slowSubscribers: 0, sockets: 0 } })

const script = new URL("./check-soak-campaign.mjs", import.meta.url).pathname
const check = (path, env = {}) => spawnSync(process.execPath, [script, path], { encoding: "utf8", env: { ...process.env,
  SMITHERS_SOAK_MINUTES: undefined, SMITHERS_SOAK_SEED: undefined, SMITHERS_SOAK_NODE: undefined, ...env } })

test("the schedule's environment states the expectation; unset variables leave only the one-minute floor", () => {
  assert.deepEqual(expectation({}), { minimumMinutes: 1 })
  assert.deepEqual(expectation({ SMITHERS_SOAK_MINUTES: "60", SMITHERS_SOAK_SEED: "20260904", SMITHERS_SOAK_NODE: "26.4.0" }),
    { minimumMinutes: 60, seed: 20260904, node: "26.4.0" })
})

test("the soak CLI runs the package verifier against the scheduled row and prints the receipt summary", () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-soak-verifier-"))
  const path = join(directory, "soak.json")
  try {
    writeFileSync(path, JSON.stringify(artifact()))
    const passed = check(path, { SMITHERS_SOAK_MINUTES: "1", SMITHERS_SOAK_SEED: "20260904", SMITHERS_SOAK_NODE: "26.10.0" })
    assert.equal(passed.status, 0, passed.stderr)
    assert.deepEqual(JSON.parse(passed.stdout), { minutes: 1, seed: 20260904, samples: 5, growth: artifact().slopes })
    for (const [env, reason] of [
      [{ SMITHERS_SOAK_NODE: "26.4.0" }, /runtime mismatch/],
      [{ SMITHERS_SOAK_MINUTES: "4" }, /minutes mismatch/],
      [{ SMITHERS_SOAK_SEED: "8" }, /seed mismatch/]
    ]) {
      const refused = check(path, env)
      assert.equal(refused.status, 1)
      assert.match(refused.stderr, reason)
    }
    for (const body of [undefined, '{"status":', JSON.stringify({ status: "failed" })]) {
      rmSync(path, { force: true })
      if (body !== undefined) writeFileSync(path, body)
      assert.equal(check(path).status, 1)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("scheduled soak executes the scaled producer, verifies even on failure and retains artifacts", () => {
  const workflow = parseWorkflow(readFileSync(new URL("../../../../.github/workflows/reliability.yml", import.meta.url), "utf8"))
  assert.ok(workflow.on.schedule.length > 0)
  const job = workflow.jobs["sync-long-soak"]
  assert.deepEqual(job.strategy.matrix.node, ["26.4.0", "26.10.0"])
  for (const row of job.strategy.matrix.node) assert.ok(nodeReleases.includes(row), `the verifier accepts the ${row} row`)
  assert.equal(job.strategy["fail-fast"], false)
  assert.equal(job.env.SMITHERS_SOAK_NODE, "${{ matrix.node }}")
  assert.equal(job.steps.find((step) => step.uses?.startsWith("actions/setup-node@")).with["node-version"], "${{ matrix.node }}")
  assert.equal(job.env.SMITHERS_SOAK_MINUTES, "60")
  assert.equal(job.env.SMITHERS_SOAK_SEED, "20260904")
  assert.match(job.steps.find((step) => step.name === "Execute env-scaled sync soak directly").run,
    /vitest run test\/ServerLongSoak\.test\.ts --coverage.enabled=false --maxWorkers=1/)
  const verification = job.steps.find((step) => step.name === "Require completed soak artifact")
  assert.equal(verification.if, "always()")
  assert.match(verification.run, /smthrs flow start bench\/soak-campaign --data /)
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
