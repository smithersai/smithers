import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as Audience from "@smthrs/build-cli/Audience"
import { NodeRuntime } from "@smthrs/platform-node"
import { Effect } from "effect"
import { Cli } from "incur"
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import type * as Bridge from "../src/cli/ControlBridge.ts"
import * as RunTiming from "../src/cli/RunTiming.ts"
import { appendRunTiming } from "../src/cli/RunTimingCommand.ts"
import * as NodeControl from "../src/NodeControl.ts"

const directories: Array<string> = []
let root: string
const temporary = async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "smthrs-timing-command-")))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** Real migrated stores, with durable control receipts for a finished run. */
const recorded = async (planned = false) => {
  const directory = await temporary()
  await Effect.runPromise(Effect.void.pipe(
    Effect.provide(NodeRuntime.storage(join(directory, ".flows", "engine.db"), directory)),
    Effect.provide(NodeServices.layer),
    Effect.provide(NodeCrypto.layer)
  ))
  await Effect.runPromise(Effect.void.pipe(Effect.provide(NodeControl.engineDurable(directory).runtime)))
  const database = new DatabaseSync(join(directory, ".flows", "control.db"))
  try {
    database.prepare(
      "INSERT INTO control_plans(plan_id,card_json,decoded_input_json,decision) VALUES('plan-7','{}','{}','approved')"
    ).run()
    database.prepare("INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('run-1','completed',0,?)")
      .run(JSON.stringify({
        runId: "run-1",
        flowId: "demo/ship",
        ...(planned ? { planId: "plan-7" } : {}),
        status: "completed",
        createdAt: 5_000,
        updatedAt: 14_000
      }))
    const receipts = planned
      ? [
        {
          sequence: 0,
          kind: "control.plan.created",
          runId: "plan:plan-7",
          occurredAt: 0,
          payload: { planId: "plan-7" }
        },
        { sequence: 1, kind: "control.approval.approved", runId: "plan:plan-7", occurredAt: 3_000, payload: {} },
        ...events
      ]
      : events
    const insert = database.prepare(
      "INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES(?,?,?,'fixture',?,?,?,?,'{}')"
    )
    for (const [index, receipt] of receipts.entries()) {
      insert.run(
        receipt.runId,
        receipt.sequence + 1,
        `event-${index}`,
        index + 1,
        receipt.occurredAt,
        receipt.kind,
        JSON.stringify({ ...receipt.payload, at: receipt.occurredAt })
      )
    }
  } finally {
    database.close()
  }
  return directory
}

/** Compare persisted contents, including schema and every row, rather than a repair spy. */
const snapshot = (directory: string, name = "control.db") => {
  const database = new DatabaseSync(join(directory, ".flows", name), { readOnly: true })
  try {
    const schema = database.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<
      { name: string }
    >
    return { schema, rows: tables.map(({ name }) => [name, database.prepare(`SELECT * FROM "${name}"`).all()]) }
  } finally {
    database.close()
  }
}

beforeEach(async () => {
  root = await recorded()
})

const event = (sequence: number, kind: string, at: number, payload: Record<string, unknown> = {}) => ({
  sequence,
  kind,
  runId: "run-1",
  occurredAt: at + 5_000,
  payload: { ...payload, at: at + 5_000 }
})

/** Two frames: the second call carries wire timing and leaves the workspace changed. */
const events = [
  event(0, "control.run.running", 0, { runId: "run-1", status: "running" }),
  event(1, "control.agent.turn-opened", 500, { seat: "test:gpt-test" }),
  event(2, "control.agent.model-requested", 500, { frame: 0, attempt: 1, purpose: "frame" }),
  event(3, "control.agent.model-settled", 3_500, {
    durationMillis: 3_000,
    costUsd: 0.01,
    usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 40, totalTokens: 1_100 }
  }),
  event(4, "control.agent.cell-produced", 3_500),
  event(5, "control.agent.cell-call-started", 3_600, { callId: "c1", flowName: "bash" }),
  event(6, "control.agent.cell-call-settled", 3_900, { callId: "c1", flowName: "bash", outcome: "success" }),
  event(7, "control.agent.cell-settled", 4_000),
  event(8, "control.agent.mutation-observed", 4_000, { mutated: false }),
  event(9, "control.agent.turn-closed", 4_000),
  event(10, "control.agent.turn-opened", 4_000, { seat: "test:gpt-test" }),
  event(11, "control.agent.model-requested", 4_000, { frame: 1, attempt: 1, purpose: "frame" }),
  event(12, "control.agent.model-settled", 8_000, {
    durationMillis: 4_000,
    costUsd: 0.02,
    usage: {
      inputTokens: 2_000,
      cachedInputTokens: 1_000,
      outputTokens: 300,
      reasoningTokens: 100,
      totalTokens: 2_300
    },
    timing: {
      attempts: 1,
      signedMs: 4,
      sentMs: 8,
      headersMs: 900,
      firstEventMs: 950,
      firstThinkingMs: 1_000,
      firstOutputMs: 2_500,
      lastOutputMs: 3_900,
      completedMs: 3_950,
      closedMs: 3_990
    }
  }),
  event(13, "control.agent.cell-produced", 8_000),
  event(14, "control.agent.cell-settled", 8_500),
  event(15, "control.agent.mutation-observed", 8_500, { mutated: true }),
  event(16, "control.agent.turn-closed", 8_500),
  event(17, "control.run.completed", 9_000, { runId: "run-1", status: "completed" })
]

const invoke = async (args: Array<string>, tty = false, signal?: AbortSignal) => {
  const result = { stdout: "", stderr: "", codes: [] as Array<number> }
  const terminal = (key: "stdout" | "stderr") => ({
    isTTY: tty,
    columns: 120,
    write: (text: string) => {
      result[key] += text
    }
  })
  const runtime: Bridge.Runtime = {
    signal,
    environment: { SMITHERS_BACKEND: "sqlite" },
    stdout: terminal("stdout"),
    stderr: terminal("stderr")
  }
  const presentation = Audience.fromArguments(args, { env: runtime.environment, stdout: tty, stderr: tty })
  await makeCli({ ...runtime, presentation }).serve(Audience.incurArguments([...args, "--root", root], presentation), {
    env: runtime.environment,
    stdout: (text) => {
      result.stdout += text
    },
    exit: (code) => {
      result.codes.push(code)
    }
  })
  return result
}

describe("runs show --timing", { timeout: 120_000 }, () => {
  it("returns the timing report of the requested run as JSON", async () => {
    const before = snapshot(root)
    const engineBefore = snapshot(root, "engine.db")
    const result = await invoke(["runs", "show", "run-1", "--timing", "--json"])
    expect(result.codes).toEqual([])
    expect(snapshot(root)).toEqual(before)
    expect(snapshot(root, "engine.db")).toEqual(engineBefore)
    const report = JSON.parse(result.stdout) as RunTiming.Report
    expect(report).toMatchObject({
      runId: "run-1",
      status: "completed",
      wallMs: 9_000,
      time: { modelMs: 7_000, cellsMs: 1_000, judgeMs: 0, compactionMs: 0, otherMs: 1_000 },
      total: { calls: 2, spent: 3_400 }
    })
    expect(report.calls).toMatchObject([
      { index: 1, frame: 0, durationMs: 3_000, tries: 1, moved: false },
      { index: 2, frame: 1, durationMs: 4_000, waitMs: 1_000, thinkingMs: 1_500, writingMs: 1_400, moved: true }
    ])
    expect(report.calls[1]!.timing).toMatchObject({ signedMs: 4, headersMs: 900, firstOutputMs: 2_500 })
  })

  it("prints a person the table of the same report the JSON carries", async () => {
    const json = await invoke(["runs", "show", "run-1", "--timing", "--json"])
    const human = await invoke(["runs", "show", "run-1", "--timing", "--audience", "human"], true)
    expect(human.codes).toEqual([])
    const printed = human.stdout
    const table = RunTiming.render(JSON.parse(json.stdout) as RunTiming.Report)
    expect(table).toContain("Wait by stage (seconds from the call's start)")
    // Every line of the table rendered from the JSON document is on the terminal.
    for (const line of table.split("\n").filter((entry) => entry.trim() !== "")) expect(printed).toContain(line)
    expect(printed).not.toContain("wallMs")
  })

  it("leaves the run card unchanged without the flag", async () => {
    const result = await invoke(["runs", "show", "run-1", "--json"])
    const card = JSON.parse(result.stdout)
    expect(card).toMatchObject({ runId: "run-1", flowId: "demo/ship", diagnosis: { turns: 2 } })
    expect(card.wallMs).toBeUndefined()
  })

  it("refuses a run the selected store does not hold without changing it", async () => {
    const before = snapshot(root)
    const missing = await invoke(["runs", "show", "run-2", "--timing", "--json"])
    expect(missing.codes).toEqual([1])
    expect(JSON.parse(missing.stdout)).toMatchObject({ code: "run_not_found", message: "Unknown run run-2" })
    expect(snapshot(root)).toEqual(before)
  })

  it("counts from the plan's creation when the store holds the plan's events", async () => {
    root = await recorded(true)
    const before = snapshot(root)
    const result = await invoke(["runs", "show", "run-1", "--timing", "--json"])
    expect(result.codes).toEqual([])
    expect(snapshot(root)).toEqual(before)
    const report = JSON.parse(result.stdout) as RunTiming.Report
    expect(report).toMatchObject({
      status: "completed",
      wallMs: 14_000,
      time: { modelMs: 7_000, cellsMs: 1_000, judgeMs: 0, compactionMs: 0, otherMs: 6_000 }
    })
    expect(report.frames[0]).toMatchObject({ frame: "start", wallMs: 5_500, otherMs: 5_500 })
    expect(report.calls[0]).toMatchObject({ startMs: 5_500 })
  })

  it("honors host cancellation while observing a real store", async () => {
    const before = snapshot(root)
    const controller = new AbortController()
    controller.abort(new Error("Timing request cancelled"))
    const result = await invoke(["runs", "show", "run-1", "--timing", "--json"], false, controller.signal)
    expect(result.codes).toEqual([1])
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "interrupted",
      message: "Timing request cancelled before the command finished."
    })
    expect(snapshot(root)).toEqual(before)
  })

  it("mounts only on a runs group that has the status command", () => {
    expect(() => appendRunTiming(Cli.create("runs"))).toThrow("runs show is not registered")
  })

  it("lists the flag where the status command is discovered", async () => {
    const help = await invoke(["runs", "show", "--help"])
    expect(help.stdout).toMatch(/^ +--timing +Report where the run's time and tokens went$/m)
    expect(help.stdout).toMatch(/^ +--root <string> +Project directory; defaults to the nearest Smithers project$/m)
  })
})

it("does not borrow a run from another project when the selected root has no store", async () => {
  root = await temporary()
  const result = await invoke(["runs", "show", "run-1", "--timing", "--json"])
  expect(result.codes).toEqual([1])
  expect(JSON.parse(result.stdout)).toMatchObject({ code: "run_not_found", message: "Unknown run run-1" })
  expect(await readdir(root)).toEqual([])
})
