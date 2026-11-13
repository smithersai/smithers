/** Offline trampoline measurement: run from packages/smithers on a prepared host.
 * Uses the catalog's @smthrs/flow and @smthrs/platform-node entries.
 * No credential, network, subprocess or filesystem action is dispatched.
 */

import { HostLiveness } from "@smthrs/platform-node"
import { installEffectResolution } from "@smthrs/build-cli/effect-resolution"
installEffectResolution()

const { Action, Flow, Interpreter, Sleep } = await import("@smthrs/flow")
const { Node } = await import("@smthrs/plan")
const { TestNodeRuntime } = await import("@smthrs/platform-node")
const { Effect, Layer, Schema } = await import("effect")
const { DatabaseSync } = await import("node:sqlite")
const { existsSync, mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs")
const { tmpdir } = await import("node:os")
const { join } = await import("node:path")
const { default: assert } = await import("node:assert/strict")
const { Session } = await import("node:inspector")
// rc.16 predates the host-package TestNodeRuntime export. Compose the same
// production SQLite engine there through its then-public NodeRuntime entry.
let durableEngine = TestNodeRuntime?.durableEngine
if (!durableEngine) {
  const NodeRuntime = await import("@smthrs/flows/NodeRuntime")
  const { StepBoundary, WorkspaceSandbox } = await import("@smthrs/engine-store")
  const NodeHost = await import("@smthrs/platform-node/NodeHost")
  const AtomicFileSystem = await import("@smthrs/platform-node/AtomicFileSystem")
  const { Jj } = await import("@smthrs/kernel")
  const { Ownership } = await import("@smthrs/run-store")
  const unusedJj = Layer.succeed(Jj.Jj, Jj.make(Object.fromEntries(
    ["snapshot", "restore", "diff", "workspaceAdd", "workspaceForget", "status"].map(name =>
      [name, () => Effect.die(`benchmark unexpectedly called jj.${name}`)])
  )))
  durableEngine = (filename, hostId) => NodeRuntime.layer(
    { filename, workspaceRoot: filename.slice(0, filename.lastIndexOf("/")), owner: { hostId }, isAlive: HostLiveness.sameHostPidProbe },
    StepBoundary.layer, WorkspaceSandbox.layerFileSystem(), Layer.empty
  ).pipe(Layer.provideMerge(unusedJj), Layer.provideMerge(NodeHost.NodeCrypto.layer), Layer.provideMerge(AtomicFileSystem.layer))
}

const impl = "roundperf/v1"
const Step = Action.make("roundperf/step", {
  payload: { value: Schema.Number }, success: Schema.Number,
  tier: "irreversible", implementationVersion: impl,
  idempotencyKey: ({ value }) => `round-${value}`, nondeterministic: true
})
const Counter = Flow.make("roundperf/counter", {
  payload: { value: Schema.Number, target: Schema.Number },
  success: Schema.Number, error: Sleep.SleepRequestInvalid,
  capabilities: ["fs:read:**", "net:get:**", "net:post:**"],
  maxRounds: 10000,
  body: Node.capture({ impl }, ({ value, target }) => Sleep.action.call({ millis: 1 }).pipe(
    Node.andThen(Step.call({ value })),
    Node.branch({ if: Node.capture({ target }, (next) => next >= target), then: Node.capture({ impl }, (next) => Flow.done(next)),
      else: Node.capture({ impl, target }, (next) => Counter.to({ value: next, target })) })
  ))
})

const output = process.env.ROUND_PERF_OUT ?? `test-results/roundperf-${Date.now()}`
mkdirSync(output, { recursive: true })
const sizes = (process.env.ROUND_PERF_SIZES ?? "50,200,800").split(",").map(Number)
for (const size of sizes) {
  assert.ok(Number.isSafeInteger(size) && size >= 12 && size <= 10000, "size must be 12..10000")
  assert.ok(!existsSync(join(output, `${size}.json`)), "Use a fresh output directory")
  const dir = mkdtempSync(join(tmpdir(), "roundperf-db-"))
  const filename = join(dir, "engine.sqlite")
  const rounds = []
  const profiler = new Session()
  profiler.connect()
  profiler.post("Profiler.enable")
  let profile
  const totals = { queries: 0, rows: 0, stateBytes: 0 }
  const originalPrepare = DatabaseSync.prototype.prepare
  DatabaseSync.prototype.prepare = function(sql) {
    const stmt = originalPrepare.call(this, sql)
    for (const method of ["all", "get", "run"]) {
      const original = stmt[method]
      stmt[method] = function(...args) {
        totals.queries++
        const result = original.apply(this, args)
        const rows = method === "all" ? result : method === "get" && result ? [result] : []
        totals.rows += rows.length
        for (const row of rows) totals.stateBytes += (row.stateJson ?? row.state_json ?? "").length
        return result
      }
    }
    return stmt
  }
  let previous = { ...totals }
  let last = performance.now()
  const implementations = Layer.mergeAll(Sleep.layer, Step.toLayer(({ value }) => Effect.sync(() => {
    const now = performance.now()
    rounds.push({ round: value + 1, ms: now - last,
      ...Object.fromEntries(Object.entries(totals).map(([key, count]) => [key, count - previous[key]])) })
    previous = { ...totals }
    last = now
    if (process.env.ROUND_PERF_PROFILE === "1" && value === size - 3) profiler.post("Profiler.start")
    if (process.env.ROUND_PERF_PROFILE === "1" && value === size - 2) profiler.post("Profiler.stop", (error, result) => {
      if (error) throw error
      profile = result.profile
    })
    return value + 1
  }), { implementationVersion: impl }))
  const layers = Interpreter.layerWithImplementations(Counter, implementations).pipe(
    Layer.provideMerge(durableEngine(filename, "roundperf"))
  )
  const start = performance.now()
  let result
  try {
    result = await Effect.runPromise(Counter.execute({ value: 0, target: size }, { executionId: `roundperf-${size}` }).pipe(Effect.provide(layers)))
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare
    profiler.disconnect()
  }
  const elapsedMs = performance.now() - start
  assert.equal(result, size)
  assert.deepEqual(rounds.map(x => x.round), Array.from({ length: size }, (_, i) => i + 1))
  const db = new DatabaseSync(filename)
  const rows = db.prepare("SELECT state_json FROM flows_runs").all()
  const states = rows.map(row => JSON.parse(row.state_json))
  const groups = states.map(s => s.capabilityCeilings?.length ?? 0)
  db.close()
  const report = { size, elapsedMs, rounds, maxGroups: Math.max(...groups), node: process.version, filename }
  writeFileSync(join(output, `${size}.json`), JSON.stringify(report, null, 2) + "\n")
  if (profile) writeFileSync(join(output, `${size}.cpuprofile`), JSON.stringify(profile))
  const median = xs => { const sorted = xs.map(x => x.ms).sort((a, b) => a - b); return (sorted[4] + sorted[5]) / 2 }
  // Exclude setup and the last two rounds, where optional profiler start/stop
  // overhead lands. The same windows apply to unprofiled runs.
  console.log(JSON.stringify({ size, elapsedMs, earlyMedianMs: median(rounds.slice(1, 11)), lateMedianMs: median(rounds.slice(-12, -2)), maxGroups: report.maxGroups }))
}
