/*
 * The run timeline and run history cards' branches (docs/LOCAL-APP.md "Cards:
 * target graph"): the log drill-down and its toggle, the scrubber's duplicate
 * suppression at the axis boundaries, a run with no timings yet, a degenerate
 * axis, and the two states a card must never paint green — pending and
 * failed. The authors' suites cover the settled happy run; these are the
 * branches an operator meets when a run is empty, mid-flight, or broken.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, beforeEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { NodeTiming, RunRecord, RunSummary } from "@smthrs/rpc/TargetGraph"
import type { Card } from "../state/AppState"
import { RunHistoryCardBody } from "./RunHistoryCard"
import { barGeometry, RunTimelineCardBody, timelineExtent } from "./RunTimelineCard"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  document.body.innerHTML = ""
})

const BASE = 1_700_000_000_000

const timelineCard = (
  payload: Partial<Extract<Card, { kind: "run-timeline" }>["payload"]>
): Extract<Card, { kind: "run-timeline" }> => ({
  id: "run-timeline-run-1",
  kind: "run-timeline",
  title: "Run run-1",
  status: "acted",
  createdAt: 0,
  ordinal: 0,
  payload: { repoId: "force", runId: "run-1", label: "//src:typeCheck", status: "done", nodes: [], ...payload }
})

const historyCard = (
  payload: Partial<Extract<Card, { kind: "run-history" }>["payload"]>
): Extract<Card, { kind: "run-history" }> => ({
  id: "run-history-force",
  kind: "run-history",
  title: "force runs",
  status: "acted",
  createdAt: 0,
  ordinal: 0,
  payload: { repoId: "force", status: "done", runs: [], ...payload }
})

const render = (element: React.ReactElement): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => createRoot(host).render(element))
  return host
}

test("the axis of a run with no timings is degenerate, not NaN", () => {
  expect(timelineExtent([])).toEqual({ start: 0, end: 0 })
  /* A node that started but has not ended ends at its start, not at zero. */
  expect(timelineExtent([{ label: "//a:b", status: "running", startedAt: BASE }])).toEqual({ start: BASE, end: BASE })
  /* A node with no timings at all contributes nothing rather than a zero start. */
  expect(timelineExtent([{ label: "//a:b", status: "pending" }])).toEqual({ start: 0, end: 0 })
})

test("a bar on a zero-width axis stays inside the track", () => {
  const axis = { start: BASE, end: BASE }
  /* span is clamped to 1ms, so a cache hit is a marker at 0%, never Infinity. */
  expect(barGeometry({ label: "//a:b", status: "hit", startedAt: BASE, endedAt: BASE }, axis))
    .toEqual({ left: 0, width: 0 })
  /* A node with no startedAt is pinned to the axis start rather than dropped. */
  expect(barGeometry({ label: "//a:b", status: "pending" }, axis)).toEqual({ left: 0, width: 0 })
})

test("a run with no timings yet says so instead of rendering an empty Gantt", () => {
  const host = render(<RunTimelineCardBody card={timelineCard({ status: "running" })} onRunCommand={() => {}} />)
  expect(host.textContent).toContain("No node timings yet")
  expect(host.querySelector("[data-timeline-row]")).toBeNull()
  /* No summary means no totals: nothing claims a green run it never saw. */
  expect(host.querySelector("[data-testid^=\"run-timeline-totals-\"]")).toBeNull()
})

test("clicking a row opens its log and clicking it again closes it", () => {
  const nodes: Array<NodeTiming> = [
    { label: "//src:typeCheck", status: "ran", startedAt: BASE, endedAt: BASE + 2000, durationMs: 2000, key: "abcdef0123456789ff" }
  ]
  const host = render(
    <RunTimelineCardBody
      card={timelineCard({ nodes, logs: { "//src:typeCheck": "tsc: 0 errors\n" } })}
      onRunCommand={() => {}}
    />
  )
  const row = host.querySelector<HTMLButtonElement>("[data-timeline-row]")!
  /* The tooltip carries the duration and the key preview an operator reads. */
  expect(row.getAttribute("title")).toContain("2.0s")
  expect(row.getAttribute("title")).toContain("key abcdef012345…")
  expect(host.querySelector("[data-testid^=\"run-timeline-log-\"]")).toBeNull()

  flushSync(() => row.click())
  expect(host.querySelector("[data-testid^=\"run-timeline-log-\"]")?.textContent).toBe("tsc: 0 errors\n")
  flushSync(() => host.querySelector<HTMLButtonElement>("[data-timeline-row]")!.click())
  expect(host.querySelector("[data-testid^=\"run-timeline-log-\"]")).toBeNull()
})

test("a node the run attributed no output to says so rather than showing another node's log", () => {
  const nodes: Array<NodeTiming> = [{ label: "//src:srcs", status: "ran", startedAt: BASE, endedAt: BASE, durationMs: 0 }]
  const host = render(
    <RunTimelineCardBody card={timelineCard({ nodes, logs: { "//src:typeCheck": "other" } })} onRunCommand={() => {}} />
  )
  flushSync(() => host.querySelector<HTMLButtonElement>("[data-timeline-row]")!.click())
  expect(host.querySelector("[data-testid^=\"run-timeline-log-\"]")?.textContent)
    .toBe("No output attributed to this node.")
})

test("the scrubber fires once per cursor at both ends of the axis", () => {
  const commands: Array<string | undefined> = []
  const nodes: Array<NodeTiming> = [{ label: "//src:typeCheck", status: "ran", startedAt: BASE, endedAt: BASE + 5000 }]
  const host = render(
    <RunTimelineCardBody
      card={timelineCard({ nodes, cursor: BASE + 5000, extent: { start: BASE, end: BASE + 5000 } })}
      onRunCommand={(_name, args) => commands.push(args)}
    />
  )
  const scrubber = host.querySelector<HTMLInputElement>("[data-testid=\"run-timeline-scrubber-run-1\"]")!
  expect(scrubber.getAttribute("min")).toBe(String(BASE))
  expect(scrubber.getAttribute("max")).toBe(String(BASE + 5000))

  /*
   * A range input emits `input` and then `change` for one gesture. Time travel
   * is idempotent, so the duplicate is suppressed: one cursor, one command.
   */
  scrubber.value = String(BASE)
  flushSync(() => {
    scrubber.dispatchEvent(new Event("input", { bubbles: true }))
    scrubber.dispatchEvent(new Event("change", { bubbles: true }))
  })
  expect(commands).toEqual([`run-1 ${BASE}`])

  /* Scrubbing to the far end is a new cursor and does dispatch. */
  scrubber.value = String(BASE + 5000)
  flushSync(() => scrubber.dispatchEvent(new Event("input", { bubbles: true })))
  expect(commands).toEqual([`run-1 ${BASE}`, `run-1 ${BASE + 5000}`])
})

test("a live run renders no scrubber: there is nothing recorded to travel through", () => {
  const nodes: Array<NodeTiming> = [{ label: "//src:typeCheck", status: "running", startedAt: BASE }]
  const host = render(<RunTimelineCardBody card={timelineCard({ nodes, status: "running" })} onRunCommand={() => {}} />)
  expect(host.querySelector("[data-testid^=\"run-timeline-scrubber-\"]")).toBeNull()
})

test("the critical path is marked on the rows the summary names", () => {
  const summary: RunSummary = {
    total: 2, hit: 1, ran: 1, failed: 0, skipped: 0, durationMs: 1900, ok: true,
    criticalPath: ["//data:schema", "//src:typeCheck"]
  }
  const nodes: Array<NodeTiming> = [
    { label: "//src:typeCheck", status: "hit", startedAt: BASE + 100, endedAt: BASE + 110, durationMs: 10 },
    { label: "//data:schema", status: "ran", startedAt: BASE, endedAt: BASE + 100, durationMs: 100 },
    { label: "//src:srcs", status: "ran", startedAt: BASE, endedAt: BASE, durationMs: 0 }
  ]
  const host = render(<RunTimelineCardBody card={timelineCard({ nodes, summary })} onRunCommand={() => {}} />)
  const rows = [...host.querySelectorAll("[data-timeline-row]")]
  /* Rows sort by start, ties by label, so the axis reads left to right. */
  expect(rows.map((row) => row.getAttribute("data-timeline-row")))
    .toEqual(["//data:schema", "//src:srcs", "//src:typeCheck"])
  expect(rows.filter((row) => row.getAttribute("data-critical") === "true").map((row) => row.getAttribute("data-timeline-row")))
    .toEqual(["//data:schema", "//src:typeCheck"])
  /* Only //src:srcs settled with no elapsed time, so only it is a marker. */
  expect([...host.querySelectorAll("[data-timeline-row]")]
    .filter((row) => row.querySelector("[data-zero-width=\"true\"]") !== null)
    .map((row) => row.getAttribute("data-timeline-row"))).toEqual(["//src:srcs"])
  expect(host.querySelector("[data-testid=\"run-timeline-totals-run-1\"]")?.textContent).toContain("1.9s")
})

test("the history card refuses to paint a table it did not load", () => {
  const pending = render(<RunHistoryCardBody card={historyCard({ status: "pending" })} onRunCommand={() => {}} />)
  expect(pending.textContent).toContain("Loading run history…")
  expect(pending.querySelector("table")).toBeNull()

  document.body.innerHTML = ""
  const failed = render(<RunHistoryCardBody card={historyCard({ status: "failed" })} onRunCommand={() => {}} />)
  expect(failed.querySelector("[role=\"alert\"]")?.textContent).toBe("The run history did not load.")
  expect(failed.querySelector("table")).toBeNull()
})

test("a repository with no recorded runs says so rather than showing an empty table", () => {
  const host = render(<RunHistoryCardBody card={historyCard({ runs: [] })} onRunCommand={() => {}} />)
  expect(host.textContent).toContain("No runs recorded for this repository yet.")
  expect(host.querySelector("table")).toBeNull()
})

test("a recorded run's row selects it for replay", () => {
  const runs: Array<RunRecord> = [{
    runId: "run-1", repoId: "force", label: "//src:typeCheck", labels: ["//src:typeCheck"],
    status: "done", startedAt: BASE, endedAt: BASE + 1900, exitCode: 0,
    summary: { total: 4, hit: 2, ran: 2, failed: 0, skipped: 0, durationMs: 1900, ok: true, criticalPath: [] }
  }]
  const commands: Array<[string, string | undefined]> = []
  const host = render(
    <RunHistoryCardBody card={historyCard({ runs })} onRunCommand={(name, args) => commands.push([name, args])} />
  )
  const table = host.querySelector("table")!
  expect(table.getAttribute("aria-label")).toBe("Recorded target runs")
  const select = host.querySelector<HTMLButtonElement>("[data-run-row] .run-history-select")!
  flushSync(() => select.click())
  expect(commands.length).toBe(1)
  expect(commands[0]?.[1]).toContain("run-1")
})
