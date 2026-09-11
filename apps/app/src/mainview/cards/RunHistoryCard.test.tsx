import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { RunRecord } from "@smthrs/rpc/TargetGraph"
import type { Card } from "../state/AppState"
import { RunHistoryCardBody } from "./RunHistoryCard"

/*
 * The run history table: one row per recorded run with its summary counts;
 * selecting a row dispatches the replay (which feeds the timeline card and
 * the graph overlay).
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const RUNS: Array<RunRecord> = [
  {
    runId: "run-1",
    repoId: "force",
    label: "//:prePush",
    labels: ["//:prePush"],
    status: "done",
    startedAt: Date.parse("2026-08-27T10:00:00Z"),
    endedAt: Date.parse("2026-08-27T10:00:08Z"),
    exitCode: 0,
    summary: { total: 4, hit: 1, ran: 3, failed: 0, skipped: 0, durationMs: 8000, ok: true, criticalPath: [] }
  },
  {
    runId: "run-2",
    repoId: "force",
    label: "//src:lint",
    labels: ["//src:lint"],
    status: "failed",
    startedAt: Date.parse("2026-08-27T11:00:00Z"),
    endedAt: Date.parse("2026-08-27T11:00:01.2Z"),
    exitCode: 1,
    summary: { total: 1, hit: 0, ran: 0, failed: 1, skipped: 0, durationMs: 1200, ok: false, criticalPath: [] }
  }
]

const card = (
  payload: Partial<Extract<Card, { kind: "run-history" }>["payload"]>
): Extract<Card, { kind: "run-history" }> => ({
  id: "run-history-force",
  kind: "run-history",
  title: "force runs",
  status: "acted",
  createdAt: 0,
  ordinal: 0,
  payload: { repoId: "force", status: "done", runs: RUNS, ...payload }
})

const render = (
  body: Extract<Card, { kind: "run-history" }>,
  onRunCommand: (name: string, args?: string) => void = () => {}
): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<RunHistoryCardBody card={body} onRunCommand={onRunCommand} />)
  })
  return host
}

describe("the run history card", () => {
  test("rows carry label, status, duration and the summary counts", () => {
    const host = render(card({}))
    const row = host.querySelector("[data-run-row=\"run-1\"]")
    expect(row?.textContent).toContain("//:prePush")
    expect(row?.textContent).toContain("8.0s")
    expect(row?.textContent).toContain("1 / 3 / 0")
    const failed = host.querySelector("[data-run-row=\"run-2\"]")
    expect(failed?.textContent).toContain("0 / 0 / 1")
  })

  test("selecting a row dispatches the replay for that run", () => {
    const ran: Array<string> = []
    const host = render(card({ selected: "run-1" }), (name, args) => ran.push(`${name} ${args ?? ""}`))
    expect(host.querySelector("[data-run-row=\"run-1\"]")?.getAttribute("data-selected")).toBe("true")
    const select = host.querySelector("[data-run-row=\"run-2\"] .run-history-select") as HTMLElement | null
    flushSync(() => select?.click())
    expect(ran).toEqual(["target.runs.select force run-2"])
  })

  test("pending and empty stay honest", () => {
    expect(render(card({ status: "pending", runs: [] })).textContent).toContain("Loading run history…")
    expect(render(card({ runs: [] })).textContent).toContain("No runs recorded")
  })

  test("a failed history renders the backend error text", () => {
    expect(render(card({ status: "failed", runs: [], error: "history store is unreadable" })).textContent)
      .toContain("history store is unreadable")
  })
})
