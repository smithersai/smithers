/** Offline SQLite round-state measurement; loopback fake only, no external services. */
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
const output = process.env.ROUND_BYTES_OUT ?? `test-results/roundbytes-${Date.now()}`
mkdirSync(output, { recursive: true })
const size = 800
for (const kind of (process.env.ROUND_BYTES_KINDS ?? "synthetic,file-tree").split(",")) {
  assert.ok(["synthetic", "file-tree"].includes(kind), "unknown fixture")
  assert.ok(!existsSync(join(output, `${kind}.json`)), "Use a fresh artifact directory")
  const dir = mkdtempSync(join(tmpdir(), "roundbytes-"))
  const filename = join(dir, "engine.sqlite")
  const times = []
  let last = performance.now()
  const mark = () => { const now = performance.now(); times.push(now - last); last = now }
  let flow, implementations, payload, fake
  if (kind === "synthetic") {
    const impl = "roundperf/v1"
    const Step = Action.make("roundperf/step", {
      payload: { value: Schema.Number }, success: Schema.Number,
      tier: "irreversible", implementationVersion: impl,
      idempotencyKey: ({ value }) => `round-${value}`, nondeterministic: true
    })
    flow = Flow.make("roundperf/counter", {
      payload: { value: Schema.Number, target: Schema.Number }, success: Schema.Number,
      error: Sleep.SleepRequestInvalid, capabilities: ["fs:read:**", "net:get:**", "net:post:**"], maxRounds: 10000,
      body: Node.capture({ impl }, ({ value, target }) => Sleep.action.call({ millis: 1 }).pipe(
        Node.andThen(Step.call({ value })),
        Node.branch({ if: Node.capture({ target }, next => next >= target), then: Node.capture({ impl }, next => Flow.done(next)),
          else: Node.capture({ impl, target }, next => flow.to({ value: next, target })) })
      ))
    })
    implementations = Layer.mergeAll(Sleep.layer, Step.toLayer(({ value }) => Effect.sync(() => { mark(); return value + 1 }), { implementationVersion: impl }))
    payload = { value: 0, target: size }
  } else {
    const mod = await import("../../../.smithers/flows/issues/file-tree/flow.ts")
    const { verify, step } = await import("../../../.smithers/flows/issues/file-tree/steps.mjs")
    const { LANES, startFakeSmithers } = await import("../../../.smithers/flows/issues/file-tree/fake-smithers.mjs")
    fake = await startFakeSmithers()
    const token = Object.keys(LANES)[0]
    const tokenFile = join(dir, "token")
    writeFileSync(tokenFile, token, { mode: 0o600 })
    const map = join(dir, "tokens.json")
    writeFileSync(map, JSON.stringify({ "acme/plan": { file: tokenFile, agent: "filer", lane: "lane-1" } }), { mode: 0o600 })
    process.env.SMITHERS_ISSUE_TOKENS = map
    const rows = [{ type: "node", key: "tree:root", repo: "acme/plan", title: "Root", about: "Root.", depth: 1, labels: [] },
      ...Array.from({ length: 3 }, (_, i) => ({ type: "node", key: `tree:group:${i}`, repo: "acme/plan", title: `Group ${i}`, about: "Group.", parent: "tree:root", depth: 2, labels: [] })),
      ...Array.from({ length: Math.ceil(size / 3) - 4 }, (_, i) => ({ type: process.env.ROUND_BYTES_NODES === "1" ? "node" : "issue", kind: "draft", key: `draft:x:${i}`, repo: "acme/plan", title: `Issue ${i}`, about: "Body.", body: "Body.", labels: [], links: [], parent: `tree:group:${Math.floor(i / 100)}`, depth: 3 })),
      { type: "summary", at: "2026-11-02T00:00:00.000Z", maxDepth: 3 }]
    const plan = join(dir, "plan.jsonl")
    writeFileSync(plan, rows.map(x => JSON.stringify(x)).join("\n") + "\n")
    flow = mod.default
    const implementationVersion = "issues/file-tree/v3"
    implementations = Layer.mergeAll(Sleep.layer,
      mod.Verify.toLayer(request => Effect.promise(() => verify({ ...request, acceptDropped: 0, dryRun: false })), { implementationVersion }),
      mod.Step.toLayer(cursor => Effect.promise(() => { mark(); return step(cursor) }), { implementationVersion }))
    payload = { plan, origin: fake.origin }
  }
  const layers = Interpreter.layerWithImplementations(flow, implementations).pipe(Layer.provideMerge(TestNodeRuntime.durableEngine(filename, "roundbytes")))
  let result
  try { result = await Effect.runPromise(flow.execute(payload, { executionId: `roundbytes-${kind}` }).pipe(Effect.provide(layers))) }
  finally { if (fake) await fake.close() }
  if (kind === "synthetic") assert.equal(result, size)
  else {
    assert.equal(result.filed, Math.ceil(size / 3))
    assert.deepEqual(result.exceptions, [])
    assert.equal(result.counts.created, result.filed)
    const writes = [...fake.writes.values()]
    assert.equal(writes.filter(write => write.op === "issue/create").length, result.filed)
    assert.deepEqual(writes.filter(write => write.op === "issue/relate").map(write => [write.number, write.parent.number]),
      [[2, 1], [3, 1], [4, 1], ...Array.from({ length: result.filed - 4 }, (_, i) => [i + 5, Math.floor(i / 100) + 2])])
  }
  const db = new DatabaseSync(filename)
  const rows = db.prepare("SELECT run_id, round_ordinal, state_json FROM flows_runs ORDER BY round_ordinal").all()
  const details = rows.map(row => {
    const state = JSON.parse(row.state_json)
    const journal = db.prepare("SELECT count(*) AS entries, coalesce(sum(length(CAST(payload_json AS BLOB)) + length(CAST(meta_json AS BLOB))), 0) AS bytes FROM flows_journal_events WHERE run_id = ?").get(row.run_id)
    return { root: row.run_id === `roundbytes-${kind}`, ordinal: row.round_ordinal, stateBytes: Buffer.byteLength(row.state_json), fields: Object.fromEntries(Object.entries(state).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))])), journalBytes: journal.bytes, journalEntries: journal.entries }
  })
  const root = kind === "file-tree" ? details.splice(details.findIndex(row => row.root), 1)[0] : undefined
  let stateTotal = root?.stateBytes ?? 0, journalTotal = root?.journalBytes ?? 0
  const rounds = details.map((row, i) => ({ round: i + 1, ms: times[i], ...row, totalStateBytes: stateTotal += row.stateBytes, totalJournalBytes: journalTotal += row.journalBytes }))
  assert.equal(times.length, details.length)
  const report = { kind, size, node: process.version, result, root, rounds }
  writeFileSync(join(output, `${kind}.json`), JSON.stringify(report, null, 2) + "\n")
  for (const r of rounds.filter(r => r.round === 1 || r.round % 50 === 0)) console.log(JSON.stringify({ kind, ...r }))
  db.close()
  if (process.env.ROUND_BYTES_ASSERT === "1") {
    // Each round has its own row and journal (trampoline-rounds.md): history
    // grows linearly; it must not be copied into each successor's live cursor.
    // Fixed pending parents; allow 512 bytes for numeric widths and stages.
    const early = rounds.slice(30, 100)
    const late = rounds.slice(300, 800)
    const stateBound = Math.max(...early.map(r => r.stateBytes)) + 512
    const journalBound = Math.max(...early.map(r => r.journalBytes)) + 512
    assert.ok(late.every(r => r.stateBytes <= stateBound), `${kind}: later state bytes exceed ${stateBound}: ${Math.max(...late.map(r => r.stateBytes))}`)
    assert.ok(late.every(r => r.journalBytes <= journalBound), `${kind}: later journal bytes exceed ${journalBound}`)
    assert.ok(rounds[799].totalStateBytes <= (root?.stateBytes ?? 0) + stateBound * 800, "total state grows at most linearly")
    assert.ok(rounds[799].totalJournalBytes <= (root?.journalBytes ?? 0) + journalBound * 800, "total journal grows at most linearly")
    // Reopen SQLite through a fresh host scope. All completed rounds must
    // replay after pruning without another action or a live HTTP service.
    const calls = times.length
    const replay = await Effect.runPromise(flow.execute(payload, { executionId: `roundbytes-${kind}` }).pipe(Effect.provide(layers)))
    assert.deepEqual(replay, result)
    assert.equal(times.length, calls, "cold replay runs no settled action again")
  }
}
