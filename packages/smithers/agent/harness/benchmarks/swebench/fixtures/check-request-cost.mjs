/** Request-level pricing through real journals and the scorecard CLI. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { readCost } from "../lib/run-cost.mjs"
import { usd } from "../prices.ts"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "swebench-request-cost-"))
const usage = (inputTokens, cachedInputTokens = 0, outputTokens = 0) => ({
  inputTokens,
  cachedInputTokens,
  outputTokens,
  reasoningTokens: 0
})
const call = (tokens, extra = {}) => ["control.agent.model-settled", { usage: tokens, ...extra }]
const seat = (model = "openai:gpt-6-sol") => ["control.agent.turn-opened", { seat: model }]
const round = (value) => Math.round(value * 10_000) / 10_000
const cases = [
  { id: "ordinary", events: [seat(), call(usage(150_000)), call(usage(150_000))], expected: 0.6 },
  {
    id: "mixed-tiers",
    events: [seat(), call(usage(150_000)), call(usage(272_000)), call(usage(300_000))],
    expected: 0.3 + 1.088 + 1.2
  },
  {
    id: "cached",
    events: [seat(), call(usage(150_000, 100_000, 1000)), call(usage(150_000, 100_000, 1000))],
    expected: 0.26
  },
  {
    id: "seat-switch",
    events: [seat(), call(usage(150_000)), seat("openai:gpt-5.6-sol"), call(usage(150_000))],
    expected: 0.3 + usd("openai:gpt-5.6-sol", usage(150_000)).usd
  },
  {
    id: "recorded",
    events: [seat(), call(usage(150_000), { costUsd: 0.123456, costSource: "provider" }), call(usage(150_000))],
    expected: 0.423456
  },
  {
    id: "recorded-zero",
    events: [seat("unpriced-fixture"), call(usage(300_000), { costUsd: 0 })],
    expected: 0
  },
  {
    id: "tiny-calls",
    events: [seat(), ...Array.from({ length: 30 }, () => call(usage(1)))],
    expected: 0.00006
  },
  {
    id: "unpriced",
    events: [seat(), call(usage(150_000)), seat("unpriced-fixture"), call(usage(1))],
    expected: undefined
  }
]
for (const costUsd of [-1, "0.2", null]) {
  cases.push({
    id: "invalid-charge-" + String(costUsd),
    events: [seat(), call(usage(1), { costUsd })],
    expected: undefined
  })
}
// Repeating one request prices it once per repeat, on either side of the request
// threshold, however far above the threshold the run's total climbs.
for (const input of [1, 135_999, 136_000, 150_000, 271_999, 272_000, 272_001, 300_000]) {
  for (const count of [1, 2, 5]) {
    cases.push({
      id: `boundary-${input}-${count}`,
      events: [seat(), ...Array.from({ length: count }, () => call(usage(input)))],
      expected: usd("openai:gpt-6-sol", usage(input), false).usd * count
    })
  }
}
try {
  for (const test of cases) {
    const directory = join(temporary, "work", test.id, ".flows")
    mkdirSync(directory, { recursive: true })
    const database = new DatabaseSync(join(directory, "engine.db"))
    database.exec(`CREATE TABLE flows_journal_events (
      run_id TEXT, seq INTEGER, event_type TEXT, payload_json TEXT, emitted_at_ms INTEGER
    )`)
    const insert = database.prepare("INSERT INTO flows_journal_events VALUES (?, ?, ?, ?, ?)")
    test.events.forEach(([type, payload], index) => {
      insert.run(test.id, index, type, JSON.stringify(payload), index)
    })
    database.close()
    const cost = readCost(join(directory, "engine.db"))
    assert.equal(cost.usd, test.expected === undefined ? null : round(test.expected), test.id)
    assert.equal(cost.unknown, test.expected === undefined, test.id)
    assert.equal(cost.modelCalls, test.events.filter(([type]) => type.endsWith("model-settled")).length)
    const tokens = test.events.filter(([type]) => type.endsWith("model-settled")).map(([, payload]) => payload.usage)
    assert.deepEqual(cost.usage, {
      inputTokens: tokens.reduce((sum, value) => sum + value.inputTokens, 0),
      cachedInputTokens: tokens.reduce((sum, value) => sum + value.cachedInputTokens, 0),
      outputTokens: tokens.reduce((sum, value) => sum + value.outputTokens, 0),
      reasoningTokens: 0
    }, `${test.id}: reporting retains cumulative tokens`)
  }
  const ids = cases.map((test) => test.id)
  writeFileSync(join(temporary, "report.json"), JSON.stringify({ resolved_ids: ids }))
  const scored = spawnSync(process.execPath, [
    join(root, "scorecard.ts"),
    "--work",
    join(temporary, "work"),
    "--timings",
    join(temporary, "timings"),
    "--patches",
    join(temporary, "patches"),
    "--subject",
    join(temporary, "subject.json"),
    "--report",
    join(temporary, "report.json"),
    "--out",
    temporary,
    "--instances",
    ids.join(",")
  ], { encoding: "utf8", timeout: 120_000 })
  assert.equal(scored.status, 0, scored.stderr)
  const rows = JSON.parse(readFileSync(join(temporary, "scorecard.json"), "utf8")).instances
  for (const test of cases) {
    const row = rows.find((row) => row.instanceId === test.id)
    const expected = test.expected === undefined ? undefined : round(test.expected)
    assert.equal(row.cost.usd, expected, `${test.id}: scorecard model cost`)
    assert.equal(row.cost.totalUsd, expected, `${test.id}: scorecard total cost`)
    const cost = readCost(join(temporary, "work", test.id, ".flows", "engine.db"))
    assert.equal(row.cost.inputTokens, cost.usage.inputTokens)
    assert.equal(row.cost.cachedInputTokens, cost.usage.cachedInputTokens)
    assert.equal(row.cost.outputTokens, cost.usage.outputTokens)
  }
  console.log(`check-request-cost: ${cases.length} request-pricing journals pass.`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
