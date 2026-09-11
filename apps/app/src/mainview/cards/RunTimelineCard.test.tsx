import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { NodeTiming } from "@smthrs/rpc/TargetGraph"
import type { Card } from "../state/AppState"
import { barGeometry, RunTimelineCardBody, timelineExtent } from "./RunTimelineCard"

/*
 * The run timeline over recorded timings: bars match startedAt→endedAt on
 * the shared axis, hits render as zero-width markers, critical-path rows are
 * emphasized, clicking a row opens its attributed log, and the replay
 * scrubber dispatches cursor commands.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const NODES: Array<NodeTiming> = [
  { label: "//src:srcs", status: "hit", startedAt: 1000, endedAt: 1000, durationMs: 0 },
  { label: "//src:relayArtifacts", status: "ran", startedAt: 1000, endedAt: 4000, durationMs: 3000 },
  { label: "//src:typeCheck", status: "ran", startedAt: 4000, endedAt: 8900, durationMs: 4900 },
  { label: "//src:lint", status: "failed", startedAt: 4000, endedAt: 5200, durationMs: 1200, reason: "exit 1" },
  { label: "//:prePush", status: "pending" }
]

const card = (
  payload: Partial<Extract<Card, { kind: "run-timeline" }>["payload"]>
): Extract<Card, { kind: "run-timeline" }> => ({
  id: "run-timeline-run-1",
  kind: "run-timeline",
  title: "Run run-1",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repoId: "force",
    runId: "run-1",
    label: "//:prePush",
    status: "running",
    nodes: NODES,
    ...payload
  }
})

const render = (
  body: Extract<Card, { kind: "run-timeline" }>,
  onRunCommand: (name: string, args?: string) => void = () => {}
): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<RunTimelineCardBody card={body} onRunCommand={onRunCommand} />)
  })
  return host
}

describe("the run timeline's geometry", () => {
  test("the axis spans the earliest start to the latest end", () => {
    expect(timelineExtent(NODES)).toEqual({ start: 1000, end: 8900 })
  })

  test("bars match startedAt→endedAt as axis percentages", () => {
    const axis = { start: 1000, end: 8900 }
    expect(barGeometry(NODES[1]!, axis)).toEqual({ left: 0, width: 37.97 })
    expect(barGeometry(NODES[2]!, axis)).toEqual({ left: 37.97, width: 62.03 })
    // A hit is zero-width at its instant.
    expect(barGeometry(NODES[0]!, axis)).toEqual({ left: 0, width: 0 })
  })
})

describe("the run timeline card", () => {
  test("rows carry status, duration and the critical-path emphasis; hits are zero-width markers", () => {
    const host = render(
      card({
        summary: {
          total: 5,
          hit: 1,
          ran: 2,
          failed: 1,
          skipped: 0,
          durationMs: 7900,
          ok: false,
          criticalPath: ["//src:relayArtifacts", "//src:typeCheck"]
        }
      })
    )
    const hit = host.querySelector("[data-timeline-row=\"//src:srcs\"] .run-timeline-bar")
    expect(hit?.getAttribute("data-zero-width")).toBe("true")
    const relay = host.querySelector("[data-timeline-row=\"//src:relayArtifacts\"]")
    expect(relay?.getAttribute("data-critical")).toBe("true")
    expect(relay?.textContent).toContain("3.0s")
    const lint = host.querySelector("[data-timeline-row=\"//src:lint\"]")
    expect(lint?.getAttribute("data-status")).toBe("failed")
    expect(lint?.getAttribute("data-critical")).toBe("false")
    expect(lint?.getAttribute("title")).toContain("1.2s")
    const totals = host.querySelector("[data-testid=\"run-timeline-totals-run-1\"]")
    expect(totals?.textContent).toContain("hit")
    expect(totals?.textContent).toContain("7.9s")
  })

  test("clicking a row opens that node's attributed stdout/stderr", () => {
    const host = render(card({ logs: { "//src:lint": "src/App.tsx:12 error TS2322\n" } }))
    const row = host.querySelector("[data-timeline-row=\"//src:lint\"]") as HTMLElement | null
    flushSync(() => row?.click())
    const log = host.querySelector("[data-testid^=\"run-timeline-log-\"]")
    expect(log?.textContent).toContain("error TS2322")
    flushSync(() => row?.click())
    expect(host.querySelector("[data-testid^=\"run-timeline-log-\"]")).toBeNull()
  })

  test("the scrubber replays deterministically through target.run.scrub", () => {
    const ran: Array<string> = []
    const host = render(
      card({ cursor: 4000, extent: { start: 1000, end: 8900 } }),
      (name, args) => ran.push(`${name} ${args ?? ""}`)
    )
    const scrubber = host.querySelector<HTMLInputElement>("[data-testid=\"run-timeline-scrubber-run-1\"]")
    expect(scrubber).not.toBeNull()
    expect(scrubber?.min).toBe("1000")
    expect(scrubber?.max).toBe("8900")
    expect(scrubber?.value).toBe("4000")
    const drag = (to: string): void => {
      flushSync(() => {
        if (scrubber === null) return
        // Bypass React's value tracker the way a real drag does, then emit
        // the pair a range emits: `input` per tick, `change` on release.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(scrubber, to)
        scrubber.dispatchEvent(new Event("input", { bubbles: true }))
        scrubber.dispatchEvent(new Event("change", { bubbles: true }))
      })
    }
    drag("5200")
    // One cursor, one command: the release's duplicate is suppressed.
    expect(ran).toEqual(["target.run.scrub run-1 5200"])
    drag("6100")
    drag("5200")
    expect(ran).toEqual([
      "target.run.scrub run-1 5200",
      "target.run.scrub run-1 6100",
      "target.run.scrub run-1 5200"
    ])
  })

  test("no rows yet is an honest empty state, not a green one", () => {
    const host = render(card({ nodes: [] }))
    expect(host.textContent).toContain("No node timings yet")
  })

  test("a failed run renders the stream error text", () => {
    const host = render(card({ status: "failed", nodes: [], error: "loader disappeared" }))
    expect(host.querySelector("[role=alert]")?.textContent).toContain("loader disappeared")
  })
})
