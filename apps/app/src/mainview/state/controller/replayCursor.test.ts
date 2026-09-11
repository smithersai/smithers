/*
 * The replay fold at its boundaries (docs/LOCAL-APP.md "Cards: target
 * graph"). Time travel is what the scrubber sells, and the fold is the whole
 * of it: a cursor before the run began must show NOTHING, a cursor at the end
 * must show everything, and no cursor may ever show a state the run had not
 * reached — a summary from the future, or output a node had not printed.
 */
import { expect, test } from "bun:test"
import type { RunSummary, TargetRunEvent } from "@smthrs/rpc/TargetGraph"
import { foldRunFrame, replayAtCursor } from "./targetGraph"

const BASE = 1_700_000_000_000
const SUMMARY: RunSummary = {
  total: 2, hit: 1, ran: 1, failed: 0, skipped: 0, durationMs: 700, ok: true,
  criticalPath: ["//src:srcs", "//src:typeCheck"]
}

/* One recorded run, with untimed log frames interleaved between timed ones. */
const EVENTS: ReadonlyArray<TargetRunEvent> = [
  { type: "started", runId: "run-1", label: "//src:typeCheck", labels: ["//src:typeCheck"], at: BASE, seq: 0 },
  { type: "stdout", data: "resolving targets\n", seq: 1 },
  { type: "node", node: { label: "//src:srcs", status: "running", startedAt: BASE + 100 }, at: BASE + 100, seq: 2 },
  { type: "stdout", data: "srcs: collecting\n", label: "//src:srcs", seq: 3 },
  { type: "node", node: { label: "//src:srcs", status: "ran", startedAt: BASE + 100, endedAt: BASE + 300, durationMs: 200 }, at: BASE + 300, seq: 4 },
  { type: "stdout", data: "tsc: starting\n", label: "//src:typeCheck", seq: 5 },
  { type: "node", node: { label: "//src:typeCheck", status: "hit", startedAt: BASE + 300, endedAt: BASE + 700, durationMs: 400 }, at: BASE + 700, seq: 6 },
  { type: "stdout", data: "tsc: 0 errors\n", label: "//src:typeCheck", seq: 7 },
  { type: "summary", summary: SUMMARY, at: BASE + 700, seq: 8 },
  { type: "exit", code: 0, seq: 9 }
]

test("a cursor before the run began shows no nodes, no summary and no logs", () => {
  const state = replayAtCursor(EVENTS, BASE - 1)
  expect(state.nodes).toEqual([])
  expect(state.summary).toBeUndefined()
  /*
   * The untimed `stdout` at seq 1 inherits the clock of the `started` frame
   * before it. Without that carry the cursor would gate the node frames but
   * let every log line through, and the start of a replay would show output
   * the run had not produced yet.
   */
  expect(state.logs).toEqual({})
})

test("a cursor at the first frame shows the run started and nothing else", () => {
  const state = replayAtCursor(EVENTS, BASE)
  expect(state.nodes).toEqual([])
  expect(state.summary).toBeUndefined()
  /* The unattributed log line carries no label, so it belongs to no node. */
  expect(state.logs).toEqual({})
})

test("a cursor mid-run shows the node as it was then, not as it ended", () => {
  const state = replayAtCursor(EVENTS, BASE + 100)
  expect(state.nodes).toEqual([{ label: "//src:srcs", status: "running", startedAt: BASE + 100 }])
  expect(state.summary).toBeUndefined()
  /*
   * The untimed frame at seq 3 inherits the clock of the node frame before
   * it — the same instant, so it is inside the cursor. What it must NOT do is
   * inherit a LATER clock and appear before the run produced it.
   */
  expect(state.logs).toEqual({ "//src:srcs": "srcs: collecting\n" })
  /* Output attributed to a node the cursor has not reached is not shown. */
  expect(state.logs["//src:typeCheck"]).toBeUndefined()

  const later = replayAtCursor(EVENTS, BASE + 300)
  expect(later.nodes).toEqual([
    { label: "//src:srcs", status: "ran", startedAt: BASE + 100, endedAt: BASE + 300, durationMs: 200 }
  ])
  /* seq 5 rides the same clock as the node frame that settled //src:srcs. */
  expect(later.logs).toEqual({ "//src:srcs": "srcs: collecting\n", "//src:typeCheck": "tsc: starting\n" })
})

test("a cursor one millisecond before the summary shows the run unfinished", () => {
  const state = replayAtCursor(EVENTS, BASE + 699)
  expect(state.nodes.map((node) => node.label)).toEqual(["//src:srcs"])
  /*
   * The summary is the run's verdict. A cursor before it must not paint one:
   * a half-replayed run that claims 2 hit and a critical path is a green
   * state nobody sent.
   */
  expect(state.summary).toBeUndefined()
})

test("a cursor at the end shows every node, the summary and every attributed log", () => {
  const state = replayAtCursor(EVENTS, BASE + 700)
  expect(state.nodes.map((node) => node.label)).toEqual(["//src:srcs", "//src:typeCheck"])
  expect(state.summary).toEqual(SUMMARY)
  expect(state.logs).toEqual({
    "//src:srcs": "srcs: collecting\n",
    "//src:typeCheck": "tsc: starting\ntsc: 0 errors\n"
  })
})

test("a cursor past the end is the same as the end", () => {
  expect(replayAtCursor(EVENTS, BASE + 1_000_000)).toEqual(replayAtCursor(EVENTS, BASE + 700))
  expect(replayAtCursor(EVENTS, Number.POSITIVE_INFINITY)).toEqual(replayAtCursor(EVENTS, BASE + 700))
})

test("an empty recording folds to an empty state at any cursor", () => {
  for (const cursor of [Number.NEGATIVE_INFINITY, 0, BASE, Number.POSITIVE_INFINITY]) {
    expect(replayAtCursor([], cursor)).toEqual({ nodes: [], summary: undefined, logs: {}, error: undefined })
  }
})

test("a node reported twice keeps its LAST state at the cursor, not its first", () => {
  const state = replayAtCursor(EVENTS, BASE + 700)
  const srcs = state.nodes.find((node) => node.label === "//src:srcs")
  expect(srcs?.status).toBe("ran")
  expect(state.nodes.length).toBe(2)
})

test("a chatty node's log is capped to a tail, and the tail is the end", () => {
  const chunk = "x".repeat(50_000)
  const noisy: Array<TargetRunEvent> = [
    { type: "started", runId: "run-1", label: "//a:b", labels: ["//a:b"], at: BASE, seq: 0 }
  ]
  for (let index = 0; index < 10; index++) {
    noisy.push({ type: "stdout", data: `${index}${chunk}`, label: "//a:b", seq: index + 1 })
  }
  noisy.push({ type: "stdout", data: "THE END", label: "//a:b", seq: 11 })
  const log = replayAtCursor(noisy, BASE + 1).logs["//a:b"] ?? ""
  /* Card payloads are persisted, so a replayed log cannot grow without bound. */
  expect(log.length).toBeLessThanOrEqual(200_000)
  expect(log.endsWith("THE END")).toBe(true)
})

test("the live fold and the replay fold agree on the same frames", () => {
  const live = { nodes: new Map(), summary: undefined as RunSummary | undefined, logs: new Map<string, string>() }
  for (const event of EVENTS) foldRunFrame(live, event)
  const replayed = replayAtCursor(EVENTS, BASE + 700)
  expect([...live.nodes.values()]).toEqual(replayed.nodes)
  expect(live.summary).toEqual(replayed.summary)
  expect(Object.fromEntries(live.logs)).toEqual(replayed.logs)
})

test("frames the fold has no state for change nothing", () => {
  const live = { nodes: new Map(), summary: undefined as RunSummary | undefined, logs: new Map<string, string>() }
  foldRunFrame(live, { type: "exit", code: 0 })
  foldRunFrame(live, { type: "error", message: "boom" })
  /* An unattributed log line belongs to no node, so no node's log grows. */
  foldRunFrame(live, { type: "stdout", data: "orphan\n" })
  foldRunFrame(live, { type: "stderr", data: "orphan\n" })
  expect(live.nodes.size).toBe(0)
  expect(live.logs.size).toBe(0)
  expect(live.summary).toBeUndefined()
})


test("indexed replay preserves recording order when event clocks move backward", () => {
  const events: TargetRunEvent[] = [
    { type: "node", at: 30, seq: 0, node: { label: "a", status: "running" } },
    { type: "stdout", label: "a", data: "future", seq: 1 },
    { type: "node", at: 10, seq: 2, node: { label: "b", status: "running" } },
    { type: "node", at: 20, seq: 3, node: { label: "a", status: "failed" } },
    { type: "stderr", label: "a", data: "visible", seq: 4 },
    { type: "exit", code: 2, seq: 5 },
    { type: "error", message: "detail", seq: 6 }
  ]
  const state = replayAtCursor(events, 20)
  expect(state.nodes.map((node) => node.label)).toEqual(["b", "a"])
  expect(state.logs).toEqual({ a: "visible" })
  expect(state.error).toBe("detail")
  expect(replayAtCursor(events.slice(0, -1), 20).error).toBe("The run exited 2.")
})

test("empty chunks preserve attributed output and oversized chunks preserve the exact tail", () => {
  const events: TargetRunEvent[] = [
    { type: "stdout", label: "a", data: "", seq: 0 },
    { type: "stdout", label: "b", data: "prefix" + "x".repeat(200_000), seq: 1 },
    { type: "stderr", label: "b", data: "end", seq: 2 }
  ]
  expect(replayAtCursor(events, 0).logs).toEqual({ a: "", b: "x".repeat(199_997) + "end" })
})
