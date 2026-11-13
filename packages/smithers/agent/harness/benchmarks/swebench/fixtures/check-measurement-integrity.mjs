/** Real journal, ledger and module-resolution regressions; no funded calls. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { journalRows } from "../lib/journal-rows.mjs"
import { readCost } from "../lib/run-cost.mjs"
import { nWay, render } from "../n-way.mjs"

const rig = resolve(import.meta.dirname, "..")

const withDirectory = (body) => {
  const directory = mkdtempSync(join(tmpdir(), "swebench-integrity-"))
  try {
    body(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const journal = (path, events = []) => {
  const db = new DatabaseSync(path)
  try {
    db.exec(
      "create table flows_journal_events (seq integer, emitted_at_ms integer, event_type text, payload_json text)"
    )
    const insert = db.prepare("insert into flows_journal_events values (?, ?, ?, ?)")
    events.forEach(([type, payload], index) => insert.run(index, index, type, JSON.stringify(payload)))
  } finally {
    db.close()
  }
}

for (const fallback of [false, true]) {
  test(`unreadable control journal leaves accounting unknown (engine fallback: ${fallback})`, () => {
    withDirectory((directory) => {
      const engine = join(directory, "engine.db")
      journal(
        engine,
        fallback ?
          [
            ["control.agent.turn-opened", { seat: "openai:gpt-6-sol" }],
            ["control.agent.model-settled", { usage: { inputTokens: 100, outputTokens: 10 } }]
          ] :
          []
      )
      writeFileSync(join(directory, "control.db"), "this is not a SQLite database")
      const bill = readCost(engine)
      assert.equal(bill.unknown, true)
      assert.equal(bill.usd, null)
      assert.match(bill.priceSource, /cannot read journal/)
      assert.throws(() => journalRows(engine, "1"), /not a database/)
    })
  })
}

test("only an absent control events table permits the legacy journal fallback", () => {
  withDirectory((directory) => {
    const engine = join(directory, "engine.db")
    journal(engine)
    const path = join(directory, "control.db")
    const db = new DatabaseSync(path)
    db.exec("create table unrelated (value text)")
    db.close()
    assert.equal(readCost(engine).unknown, false)
    assert.deepEqual(journalRows(engine, "1"), [])

    rmSync(path)
    const malformed = new DatabaseSync(path)
    malformed.exec("create table flows_journal_events (wrong_column text)")
    malformed.close()
    assert.equal(readCost(engine).unknown, true, "a schema error is not an absent table")

    rmSync(path)
    mkdirSync(path)
    assert.equal(readCost(engine).unknown, true, "a database that cannot be opened is unknown")
  })
})

test("unfinished observations in any wave stay pending on one common population", () => {
  withDirectory((directory) => {
    const wave = (name, rows) => {
      const path = join(directory, `${name}.jsonl`)
      writeFileSync(path, rows.map((row) => JSON.stringify({ kind: "instance", at: 1, ...row })).join("\n"))
      return { name, path }
    }
    const done = (id, verdict = "resolved", usd = 1) => [
      { id, state: "ran", cost: { usd, frames: 2, spanMillis: 3000 }, wallSeconds: 4 },
      { id, state: "graded", verdict }
    ]
    // Missing, started but unfinished, and unknown cost are independent axes.
    for (const pendingState of [[], [{ id: "y__y-1", state: "ran", cost: { usd: 99 } }]]) {
      const base = wave("base", [...done("x__x-1"), ...done("y__y-1")])
      const middle = wave("middle", [...done("x__x-1", "unresolved", 2), ...pendingState])
      const final = wave("final", [...done("x__x-1"), ...done("y__y-1")])
      const summary = nWay([base, middle, final])
      assert.deepEqual(summary.recovered, ["x__x-1"], "an unobserved loss is never a recovery")
      assert.equal(summary.pending, 1)
      assert.equal(summary.comparedCount, 1)
      assert.equal(summary.scoredCount, 1)
      assert.equal(summary.rows.find((row) => row.id === "y__y-1").pending, true)
      assert.deepEqual(Object.values(summary.totals).map((total) => total.instances), [1, 1, 1])
      assert.deepEqual(Object.values(summary.totals).map((total) => total.usd), [1, 2, 1])
      assert.match(render(summary), /1 not re-run yet/)
    }
    const unknown = wave("unknown", [
      ...done("x__x-1", "unresolved"),
      { id: "x__x-1", state: "ran", cost: { unknown: true, usd: null } },
      { id: "x__x-1", state: "graded", verdict: "unresolved" }
    ])
    const base = wave("base", done("x__x-1"))
    const final = wave("final", done("x__x-1"))
    const summary = nWay([base, unknown, final])
    assert.equal(summary.totals.unknown.usd, null)
    assert.equal(summary.totals.unknown.unknownCost, 1)
    assert.deepEqual(summary.recovered, ["x__x-1"])
  })
})

test("subject pins include resolved entries and package manifest bytes", () => {
  withDirectory((directory) => {
    const put = (path, content) => {
      const absolute = join(directory, path)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, typeof content === "string" ? content : JSON.stringify(content))
      return absolute
    }
    const script = put("packages/smithers/agent/harness/benchmarks/swebench/lib/subject.mjs", "")
    copyFileSync(join(rig, "lib/subject.mjs"), script)
    put("packages/smithers/package.json", {
      name: "@smthrs/cli",
      type: "module",
      dependencies: { "@smthrs/harness": "workspace:*" }
    })
    put("packages/smithers/agent/package.json", { name: "@smthrs/agent" })
    put("packages/smithers/dist/esm/bin.js", "")
    put("packages/smithers/src/bin.ts", "")
    put("packages/smithers/agent/harness/src/CellTurn.ts", "")
    put("packages/smithers/agent/harness/src/index.ts", "export const value = 1")
    put("packages/smithers/agent/harness/src/alternate.ts", "export const value = 2")
    const manifest = { name: "@smthrs/harness", type: "module", exports: "./src/index.ts" }
    const manifestPath = "packages/smithers/agent/harness/package.json"
    put(manifestPath, manifest)
    mkdirSync(join(directory, "packages/smithers/node_modules/@smthrs"), { recursive: true })
    symlinkSync("../../agent/harness", join(directory, "packages/smithers/node_modules/@smthrs/harness"))
    const pin = join(directory, "subject.json")
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" })
    // Read in a fresh process so Node's package-resolution cache cannot mask edits.
    const record = () => {
      const result = spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        `const { fingerprint } = await import(${
          JSON.stringify(script)
        }); console.log(JSON.stringify(fingerprint({ compareToHead: false })))`
      ], { encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(result.stdout)
    }
    const original = record()
    assert.deepEqual(original.refusals, [])
    writeFileSync(pin, JSON.stringify(original))
    assert.equal(run("--expect", pin, "--quiet").status, 0)
    for (
      const changed of [
        { ...manifest, exports: "./src/alternate.ts" },
        { ...manifest, imports: { "#entry": "./src/alternate.ts" } },
        { ...manifest, type: "commonjs" }
      ]
    ) {
      put(manifestPath, changed)
      const current = record()
      assert.equal(current.packages["@smthrs/harness"].hash, original.packages["@smthrs/harness"].hash)
      assert.notEqual(current.stamp, original.stamp)
      assert.equal(run("--expect", pin, "--quiet").status, 4)
    }
  })
})
