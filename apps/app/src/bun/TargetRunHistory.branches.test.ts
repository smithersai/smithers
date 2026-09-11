/*
 * The run history store's disk seam (docs/LOCAL-APP.md "Cards: target
 * graph"): a run is journalled to `.flows/ui/runs/<runId>.jsonl` as it
 * streams, and a NEW process reading that directory has to rebuild exactly
 * what the run showed — including that a run interrupted by a crash can
 * never be "running" again. No mocks: these write and re-read real files.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TargetRunEvent } from "@smthrs/rpc/TargetGraph"
import { createTargetRunHistory } from "./TargetRunHistory"
import type { TargetRun } from "./Targets"

let repo = ""
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
})
afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

const BASE = 1_700_000_000_000
const runOf = (runId: string, startedAt = BASE): TargetRun => ({
  runId, repoId: "force", repo, workspace: ".", label: "//src:typeCheck", labels: ["//src:typeCheck"],
  startedAt, status: "running", exitCode: null
})

const journal = (runId: string): Promise<string> => readFile(join(repo, ".flows", "ui", "runs", `${runId}.jsonl`), "utf8")

test("a run round-trips through disk into a fresh store", async () => {
  const writer = createTargetRunHistory()
  const run = runOf("run-1")
  await writer.start(run)
  const events: Array<TargetRunEvent> = [
    { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: BASE, seq: 0 },
    { type: "node", node: { label: "//src:srcs", status: "ran", startedAt: BASE, endedAt: BASE + 1, durationMs: 1 }, at: BASE + 1, seq: 1 },
    { type: "stdout", data: "//src:typeCheck  hit  6ms\n", label: "//src:typeCheck", seq: 2 },
    { type: "node", node: { label: "//src:typeCheck", status: "hit", startedAt: BASE + 1, endedAt: BASE + 7, durationMs: 6 }, at: BASE + 7, seq: 3 },
    {
      type: "summary",
      summary: { total: 2, hit: 1, ran: 1, failed: 0, skipped: 0, durationMs: 7, ok: true, criticalPath: ["//src:srcs", "//src:typeCheck"] },
      at: BASE + 7,
      seq: 4
    },
    { type: "exit", code: 0, seq: 5 }
  ]
  for (const event of events) writer.event(run, event)
  const live = await writer.replay(run.runId)
  expect(live?.events.length).toBe(events.length)
  expect(live?.run.status).toBe("done")
  expect(live?.run.exitCode).toBe(0)
  expect(live?.run.summary?.criticalPath).toEqual(["//src:srcs", "//src:typeCheck"])

  /* A different process, the same directory: the recording has to survive. */
  const reader = createTargetRunHistory()
  const listed = await reader.list("force", repo)
  expect(listed.map((record) => record.runId)).toEqual(["run-1"])
  expect(listed[0]?.status).toBe("done")
  const replayed = await reader.replay("run-1", [{ id: "force", path: repo }])
  expect(replayed?.events).toEqual(live!.events)
  /* `seq` survives the journal, which is what replay orders by. */
  expect(replayed?.events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
})

test("a run interrupted by a crash reloads as failed, never as running", async () => {
  const writer = createTargetRunHistory()
  const run = runOf("run-crash")
  await writer.start(run)
  /* `started` but no `exit`: the process died mid-run. */
  writer.event(run, { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: BASE, seq: 0 })
  await writer.list("force", repo)

  const reader = createTargetRunHistory()
  const listed = await reader.list("force", repo)
  expect(listed[0]?.status).toBe("failed")
  /* It is reported as over, not as something the human is still waiting on. */
  expect(listed[0]?.endedAt).toBeUndefined()
})

test("runs sort newest first and only the asked-for repository is listed", async () => {
  const history = createTargetRunHistory()
  for (const [runId, startedAt] of [["old", BASE], ["new", BASE + 5000], ["mid", BASE + 1000]] as const) {
    const run = runOf(runId, startedAt)
    await history.start(run)
    history.event(run, { type: "exit", code: 0 })
  }
  expect((await history.list("force", repo)).map((record) => record.runId)).toEqual(["new", "mid", "old"])
  /* Another repository id sees none of them, even from the same directory. */
  expect(await history.list("eigen", repo)).toEqual([])
})

test("a truncated final line and a foreign record are ignored, not fatal", async () => {
  const dir = join(repo, ".flows", "ui", "runs")
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "run-partial.jsonl"),
    [
      JSON.stringify({ type: "record", record: { runId: "run-partial", repoId: "force", label: "//a:b", labels: ["//a:b"], status: "done", startedAt: BASE, endedAt: BASE + 1 } }),
      JSON.stringify({ type: "event", event: { type: "exit", code: 0, seq: 0 } }),
      /* An event the contract does not describe: dropped, not crashed. */
      JSON.stringify({ type: "event", event: { type: "nonsense" } }),
      /* A record for a different repository in the same directory. */
      JSON.stringify({ type: "record", record: { runId: "other", repoId: "eigen", label: "//a:b", labels: [], status: "done", startedAt: BASE } }),
      "{\"type\":\"event\",\"even"
    ].join("\n") + "\n"
  )
  /* A file that is not a journal at all is skipped by extension. */
  await writeFile(join(dir, "notes.txt"), "not a journal")
  const history = createTargetRunHistory()
  const listed = await history.list("force", repo)
  expect(listed.map((record) => record.runId)).toEqual(["run-partial"])
  const replayed = await history.replay("run-partial", [{ id: "force", path: repo }])
  expect(replayed?.events).toEqual([{ type: "exit", code: 0, seq: 0 }])
})

test("a repository with no runs directory lists nothing rather than throwing", async () => {
  const history = createTargetRunHistory()
  expect(await history.list("force", repo)).toEqual([])
  expect(await history.replay("anything", [{ id: "force", path: repo }])).toBeUndefined()
  /* And with no repositories to search at all. */
  expect(await history.replay("anything")).toBeUndefined()
})

test("an event for a run the store never started is dropped", async () => {
  const history = createTargetRunHistory()
  history.event(runOf("never-started"), { type: "exit", code: 0 })
  expect(await history.list("force", repo)).toEqual([])
})

test("the journal on disk holds every frame the run emitted, capped or not", async () => {
  const history = createTargetRunHistory()
  const run = runOf("run-noisy")
  await history.start(run)
  for (let index = 0; index < 50; index++) {
    history.event(run, { type: "stdout", data: `line ${index}\n`, label: "//src:typeCheck", seq: index })
  }
  history.event(run, { type: "exit", code: 0, seq: 50 })
  await history.list("force", repo)
  const text = await journal("run-noisy")
  /* Memory keeps a tail; the journal is the whole truth. */
  expect(text).toContain("line 0\\n")
  expect(text).toContain("line 49\\n")
  /* The settled record is appended after the exit, so a reload sees `done`. */
  expect(text.trimEnd().split("\n").at(-1)).toContain("\"status\":\"done\"")
})

test("a failing exit records the code and marks the run failed", async () => {
  const history = createTargetRunHistory()
  const run = runOf("run-failed")
  await history.start(run)
  history.event(run, { type: "exit", code: 2 })
  const record = (await history.list("force", repo))[0]
  expect(record).toMatchObject({ status: "failed", exitCode: 2 })
  expect(record?.endedAt).toBeGreaterThanOrEqual(BASE)
})
