/**
 * The timing report reads a finished run out of a store copied from another
 * machine: a directory holding nothing but the run's `.flows/control.db`, which
 * is all a benchmark trial keeps.
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { NodeRuntime } from "@smthrs/platform-node"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import type * as RunTiming from "../src/cli/RunTiming.ts"
import * as NodeControl from "../src/NodeControl.ts"

const directories: Array<string> = []
afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
})

const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))

const run = (args: ReadonlyArray<string>) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", executable, ...args], {
      cwd: tmpdir(),
      env: { ...process.env, SMITHERS_REMOTE: "", SMITHERS_BACKEND: "sqlite" }
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000)
    child.once("error", reject)
    child.once("close", (code) => {
      clearTimeout(timeout)
      resolve({ code, stdout, stderr })
    })
  })

const temporary = async (name: string) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), name)))
  directories.push(directory)
  return directory
}

/** A migrated project whose control journal holds one finished two-call run. */
const recorded = async () => {
  const root = await temporary("smthrs-timing-")
  await Effect.runPromise(Effect.void.pipe(
    Effect.provide(NodeRuntime.storage(join(root, ".flows", "engine.db"), root)),
    Effect.provide(NodeServices.layer),
    Effect.provide(NodeCrypto.layer)
  ))
  await Effect.runPromise(Effect.void.pipe(Effect.provide(NodeControl.engineDurable(root).runtime)))
  const db = new DatabaseSync(join(root, ".flows", "control.db"))
  try {
    db.prepare(
      "INSERT INTO control_plans(plan_id,card_json,decoded_input_json,decision) VALUES('plan-1','{}','{}','approved')"
    ).run()
    db.prepare("INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('run-1','completed',0,?)").run(
      JSON.stringify({
        runId: "run-1",
        flowId: "fixture",
        planId: "plan-1",
        planDigest: "digest",
        status: "completed",
        createdAt: 1_000,
        updatedAt: 21_000
      })
    )
    const insert = db.prepare(
      "INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES('run-1',?,?,'fixture',?,?,?,?,'{}')"
    )
    const usage = (input: number, cached: number, output: number, reasoning: number) => ({
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
      reasoningTokens: reasoning,
      totalTokens: input + output
    })
    const events: ReadonlyArray<readonly [type: string, at: number, payload: Record<string, unknown>]> = [
      ["control.run.running", 1_000, { runId: "run-1", status: "running" }],
      ["control.agent.turn-opened", 1_500, { seat: "test:gpt-test" }],
      ["control.agent.model-requested", 1_500, { frame: 0, attempt: 1, purpose: "frame" }],
      ["flows.agent.usage.v1", 7_490, { stepKey: "key1_a", spent: 1_300, costUsd: 0.01 }],
      ["control.agent.model-settled", 7_500, {
        durationMillis: 6_000,
        costUsd: 0.01,
        usage: usage(1_000, 0, 300, 100)
      }],
      ["control.agent.cell-produced", 7_500, {}],
      ["control.agent.cell-settled", 9_500, {}],
      ["control.agent.turn-closed", 9_500, {}],
      ["control.agent.turn-opened", 9_500, { seat: "test:gpt-test" }],
      ["control.agent.model-requested", 9_500, { frame: 1, attempt: 1, purpose: "frame" }],
      ["flows.agent.usage.v1", 19_490, { stepKey: "key1_b", spent: 2_500, costUsd: 0.02 }],
      ["control.agent.model-settled", 19_500, {
        durationMillis: 10_000,
        costUsd: 0.02,
        usage: usage(2_000, 1_500, 500, 200)
      }],
      ["control.agent.turn-closed", 20_000, {}],
      ["control.run.completed", 21_000, { runId: "run-1", status: "completed" }]
    ]
    for (const [index, [type, at, payload]] of events.entries()) {
      insert.run(index + 1, `event-${index}`, index + 1, at, type, JSON.stringify({ ...payload, at }))
    }
    // The copy below takes the database file alone, so nothing may be left in its log.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } finally {
    db.close()
  }
  return root
}

const counts = (root: string) => {
  const db = new DatabaseSync(join(root, ".flows", "control.db"))
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<
      { name: string }
    >
    return tables.map((table) => [
      table.name,
      (db.prepare(`SELECT count(*) AS n FROM "${table.name}"`).get() as { n: number }).n
    ])
  } finally {
    db.close()
  }
}

describe("runs show --timing over a copied store", { timeout: 240_000 }, () => {
  it("reports a finished run from its control.db alone and writes nothing", async () => {
    const source = await recorded()
    const copy = await temporary("smthrs-timing-copy-")
    await mkdir(join(copy, ".flows"))
    await copyFile(join(source, ".flows", "control.db"), join(copy, ".flows", "control.db"))
    const before = counts(copy)

    const result = await run(["runs", "show", "run-1", "--timing", "--root", copy, "--json"])
    expect(result.code, result.stdout + result.stderr).toBe(0)
    const report = JSON.parse(result.stdout) as RunTiming.Report
    expect(report).toMatchObject({
      runId: "run-1",
      status: "completed",
      startedAt: 1_000,
      endedAt: 21_000,
      wallMs: 20_000,
      time: { modelMs: 16_000, cellsMs: 2_000, judgeMs: 0, compactionMs: 0, otherMs: 2_000 },
      spend: [{
        purpose: "frame",
        calls: 2,
        input: 3_000,
        cached: 1_500,
        uncached: 1_500,
        thinking: 300,
        written: 500,
        spent: 3_800
      }],
      total: { calls: 2, spent: 3_800 },
      ledger: { entries: 2, spent: 3_800 },
      cacheShare: 0.5
    })
    expect(report.calls).toMatchObject([
      { index: 1, frame: 0, ask: 1, purpose: "frame", startMs: 500, durationMs: 6_000, settled: true, tries: 1 },
      { index: 2, frame: 1, ask: 1, purpose: "frame", startMs: 8_500, durationMs: 10_000, settled: true, tries: 1 }
    ])
    expect(report.frames.map((frame) => [frame.frame, frame.wallMs])).toEqual([
      ["start", 500],
      [0, 8_000],
      [1, 10_500],
      ["end", 1_000]
    ])

    expect(counts(copy)).toEqual(before)
    // No engine store, no worktree, nothing beside the database and SQLite's own files.
    expect((await readdir(join(copy, ".flows"))).filter((name) => !/-(wal|shm)$/.test(name))).toEqual(["control.db"])
    expect(await readdir(copy)).toEqual([".flows"])
  })

  it("refuses a run the copied store does not hold", async () => {
    const source = await recorded()
    const result = await run(["runs", "show", "run-9", "--timing", "--root", source, "--json"])
    expect(result.code, result.stdout + result.stderr).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "run_not_found", message: "Unknown run run-9" })
  })
})
