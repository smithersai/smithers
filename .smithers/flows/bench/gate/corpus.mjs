/** Production scheduler and SQLite journal fixtures with independently checked outputs. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { performance } from "node:perf_hooks"
import { Effect, Layer } from "effect"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import * as PlanScheduler from "@smthrs/engine-store/PlanScheduler"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as Journal from "@smthrs/journal/Journal"
import * as Jj from "@smthrs/kernel/Jj"
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Plan from "@smthrs/plan/Plan"
import * as RunStore from "@smthrs/run-store/RunStore"

const owner = { hostId: "benchmark", pid: process.pid, nonce: "deterministic-fixture" }
const digest = (output) => createHash("sha256").update(JSON.stringify(output)).digest("hex")
const run = (program) => Effect.runPromise(Effect.scoped(Effect.provide(program, NodeCrypto.layer)))

/** Count actual SQLite executions and statement allocations in this dedicated process. */
function meter() {
  const probe = new DatabaseSync(":memory:")
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1"))
  probe.close()
  const totals = { queries: 0, prepares: 0, execs: 0 }
  const originals = []
  for (const [prototype, method, key] of [
    [DatabaseSync.prototype, "prepare", "prepares"], [DatabaseSync.prototype, "exec", "execs"],
    ...["all", "get", "run", "iterate"].map((method) => [statement, method, "queries"])
  ]) {
    const original = prototype[method]
    originals.push([prototype, method, original])
    prototype[method] = function(...args) { totals[key]++; return Reflect.apply(original, this, args) }
  }
  return {
    snapshot: () => ({ ...totals }),
    since: (before) => Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value - before[key]])),
    restore: () => { for (const [prototype, method, original] of originals) prototype[method] = original }
  }
}

const jj = Layer.succeed(Jj.Jj, Jj.make({
  snapshot: () => Effect.succeed({ changeId: "benchmark-snapshot" }), restore: () => Effect.void,
  diff: () => Effect.succeed(""), workspaceAdd: () => Effect.void, workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
}))

async function scheduler(shape, size, directory, counter) {
  const id = `scheduler-${shape}-${size}`
  const database = join(directory, `${id}.sqlite`)
  const nodes = Array.from({ length: size }, (_, index) => ({
    id: `n${index}`,
    material: { version: KeyMaterial.version, kind: "sealed", body: { operation: "fixture", index },
      inputs: shape === "chain" && index > 0 ? [{ _tag: "Ref", from: `n${index - 1}`, path: [] }] : [], layers: [], capabilities: [] },
    effects: { reads: [], writes: [shape === "conflict" ? "shared.out" : `n${index}.out`], boundaryMode: "hard" }
  }))
  const plan = await run(Plan.compile({ planId: id, flow: "benchmark", nodes }))
  let dispatches = 0
  let active = 0
  let maxActive = 0
  const seen = []
  const executor = PlanScheduler.layerExecutor({ execute: ({ node, inputs }) => Effect.gen(function*() {
    dispatches++
    active++
    maxActive = Math.max(maxActive, active)
    yield* Effect.yieldNow
    const index = Number(node.id.slice(1))
    const output = shape === "chain" ? (inputs[0]?.value ?? 0) + 1 : index + 1
    seen.push(node.id)
    active--
    return output
  }) })
  return run(Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(id, "{}")
    const row = yield* runs.get(id)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(id, snapshot, owner, 1)
    assert.equal(claim._tag, "Claimed")
    assert.equal((yield* runs.activate(id, owner, claim.claimedAtMs, snapshot))._tag, "Activated")
    const before = counter.snapshot()
    const started = performance.now()
    const report = yield* PlanScheduler.make({ runId: id, owner, sourceId: id, concurrency: { steps: 4 } }).run(plan)
    const elapsedMs = performance.now() - started
    const counts = counter.since(before)
    const expected = Object.fromEntries(Array.from({ length: size }, (_, index) => [`n${index}`, index + 1]))
    assert.deepEqual(report.results, expected)
    assert.equal(report.settlements.length, size)
    assert.ok(report.settlements.every((item) => item.outcome === "built"))
    assert.equal(new Set(seen).size, size)
    assert.equal(dispatches, size)
    if (shape !== "wide") assert.equal(maxActive, 1, `${shape} dependency/conflict ordering`)
    if (shape === "chain") assert.deepEqual(seen, Object.keys(expected))
    return { id, size, outputDigest: digest(expected), validated: true,
      counts: { ...counts, dispatches }, elapsedMs, maxActive, files: fileSizes(database) }
  }).pipe(Effect.provide(Layer.mergeAll(StepBoundary.layerTest(), jj, executor)), Effect.provide(TestStores.layerAt(database))))
}

const fileSizes = (database) => Object.fromEntries(["", "-wal", "-shm"].map((suffix) => {
  try { return [suffix || "database", statSync(database + suffix).size] }
  catch (error) { if (error.code === "ENOENT") return [suffix || "database", 0]; throw error }
}))

async function journalHistory(size, directory, counter, measure) {
  const database = join(directory, `journal-${size}.sqlite`)
  const expected = Array.from({ length: size }, (_, index) => ({ index, value: `entry-${index}` }))
  const append = await run(Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const before = counter.snapshot()
    const started = performance.now()
    const receiptLatencies = []
    for (const payload of expected) {
      const receiptStarted = measure ? performance.now() : 0
      const receipt = yield* journal.emitDurableUnfenced({ runId: "history", sourceId: "bench", eventType: "bench.entry", payload })
      if (measure) receiptLatencies.push(performance.now() - receiptStarted)
      assert.equal(receipt._tag, "Accepted")
      assert.equal(receipt.seq, payload.index)
    }
    return { counts: counter.since(before), elapsedMs: performance.now() - started, files: fileSizes(database),
      ...(measure ? { latency: latencyReport(receiptLatencies, "durable append receipt") } : {}) }
  }).pipe(Effect.provide(TestStores.layerAt(database))))
  const results = [{ id: `journal-append-${size}`, size, outputDigest: digest(expected), validated: true, ...append }]
  // A fresh layer and connection read the actual on-disk history after close.
  for (const [mode, limit] of [["replay", 10_000], ["paging", 31]]) {
    const result = await run(Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const before = counter.snapshot()
      const started = performance.now()
      const actual = []
      let after
      let pages = 0
      const pageLatencies = []
      while (true) {
        assert.ok(pages <= size, "cursor must advance")
        const pageStarted = measure ? performance.now() : 0
        const page = yield* journal.entries({ runId: "history", ...(after === undefined ? {} : { after }), limit })
        if (measure) pageLatencies.push(performance.now() - pageStarted)
        pages++
        for (const entry of page.entries) {
          assert.equal(entry.seq, actual.length)
          assert.equal(entry.eventType, "bench.entry")
          actual.push(entry.payload)
        }
        if (!page.hasMore) break
        assert.ok(page.entries.length > 0, "nonterminal page must advance")
        after = page.entries.at(-1).seq
      }
      const counts = counter.since(before)
      assert.deepEqual(actual, expected)
      return { id: `journal-${mode}-${size}`, size, outputDigest: digest(actual), validated: true,
        counts: { ...counts, pages }, elapsedMs: performance.now() - started, files: fileSizes(database),
        ...(measure ? { latency: latencyReport(pageLatencies, "journal page read") } : {}) }
    }).pipe(Effect.provide(TestStores.layerAt(database))))
    results.push(result)
  }
  return results
}

export function resources() {
  let descriptors = null
  try { descriptors = readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length } catch {}
  const handles = process._getActiveHandles()
  return { ...process.memoryUsage(), descriptors, handles: handles.length,
    sockets: handles.filter((handle) => handle.constructor?.name === "Socket").length }
}

export function latencyReport(rawMs, operation) {
  assert.ok(rawMs.length > 0 && rawMs.every((value) => Number.isFinite(value) && value >= 0))
  const sorted = [...rawMs].sort((a, b) => a - b)
  const percentile = (value) => sorted[Math.ceil(sorted.length * value) - 1]
  return { operation, samples: rawMs.length, p50Ms: percentile(0.5),
    p95Ms: rawMs.length >= 20 ? percentile(0.95) : null,
    p99Ms: rawMs.length >= 100 ? percentile(0.99) : null,
    maxMs: sorted.at(-1), rawMs }
}

export async function runCorpus({ measure = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "smithers-benchmark-"))
  const counter = meter()
  try {
    const results = []
    for (const shape of ["chain", "wide", "conflict"]) for (const size of [8, 32, 64]) {
      results.push(await scheduler(shape, size, directory, counter))
    }
    for (const size of [32, 256, 1024]) results.push(...await journalHistory(size, directory, counter, measure))
    return results.map((result) => ({ ...result,
      operationsPerSecond: result.size * 1000 / result.elapsedMs,
      operation: result.id.startsWith("scheduler-") ? "completed nodes" : "validated journal events" }))
  } finally {
    counter.restore()
    rmSync(directory, { recursive: true, force: true })
  }
}
