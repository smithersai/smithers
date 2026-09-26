import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { RunCommand } from "./CardFamily"
import { FlowGraphTrigger } from "./FlowGraphTrigger"
import { triggerGraph, type TriggerCardRow } from "./FlowGraphTriggerNode"

/*
 * The trigger panel (L6, D-031/D-043): what the box says about the schedule
 * that fires this flow — its cron in English, the next five occurrences, the
 * policies it is registered under, whether a scheduler is still ticking, and
 * the ledger of what each claimed occurrence became. Every value is the
 * box's; a value the row does not carry is not shown at all.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const REPO = "smithersai/smithers"
const NOW = Date.UTC(2026, 8, 21, 15, 30)
const FIRES = [
  Date.UTC(2026, 8, 21, 16, 0),
  Date.UTC(2026, 8, 22, 16, 0),
  Date.UTC(2026, 8, 23, 16, 0),
  Date.UTC(2026, 8, 24, 16, 0),
  Date.UTC(2026, 8, 25, 16, 0),
  Date.UTC(2026, 8, 28, 16, 0)
]

const boxRow = (over: Partial<TriggerCardRow> = {}): TriggerCardRow => ({
  id: "nightly",
  flowId: "review",
  cron: "0 9 * * 1-5",
  timezone: "America/New_York",
  enabled: true,
  nextFiresAt: FIRES,
  overlap: "skip",
  catchUp: "one",
  maxCatchUp: 3,
  schedulerLastTickAt: NOW - 1_000,
  ...over
})

/** Plue's `repository-jobs` registry: a slug, five-field UTC cron, and nothing else (registry ruling). */
const plueRow = (over: Partial<TriggerCardRow> = {}): TriggerCardRow => ({
  id: "flow:nightly",
  slug: "nightly",
  flowId: "review",
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  enabled: true,
  nextFireAt: FIRES[0],
  ...over
})

const render = (rows: ReadonlyArray<TriggerCardRow>, onRunCommand: RunCommand = () => {}): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(
      <FlowGraphTrigger
        triggers={triggerGraph(rows, "review", []).nodes}
        repo={REPO}
        now={NOW}
        onRunCommand={onRunCommand}
      />
    )
  })
  return host
}

const texts = (host: HTMLElement, selector: string): Array<string> =>
  [...host.querySelectorAll(selector)].map((element) => element.textContent ?? "")

describe("the schedule", () => {
  test("says its cron in English with its zone, and its state word is disabled, armed or fired", () => {
    const host = render([boxRow()])
    expect(host.querySelector("[data-testid='trigger-schedule-nightly']")?.textContent)
      .toBe("Every weekday at 09:00 America/New_York")
    expect(host.querySelector("[data-trigger='nightly']")?.getAttribute("data-trigger-state")).toBe("armed")
    expect(render([boxRow({ activeRunId: "run-9" })]).querySelector("[data-trigger='nightly']")?.getAttribute("data-trigger-state"))
      .toBe("fired")
    expect(render([boxRow({ enabled: false })]).querySelector("[data-trigger='nightly']")?.getAttribute("data-trigger-state"))
      .toBe("disabled")
  })

  test("shows the next five fire times, the schedule's zone beside UTC", () => {
    const rows = texts(render([boxRow()]), "[data-testid='trigger-fires-nightly'] li")
    expect(rows).toHaveLength(5)
    expect(rows[0]).toContain("12:00")
    expect(rows[0]).toContain("16:00")
  })

  test("a UTC schedule reads once, because printing the same instant twice says nothing", () => {
    const rows = texts(render([boxRow({ timezone: "UTC" })]), "[data-testid='trigger-fires-nightly'] li")
    expect(rows[0]).toContain("16:00")
    expect(rows[0]!.match(/16:00/g)).toHaveLength(1)
  })

  test("a row the box answered without occurrences shows no fire list at all", () => {
    const host = render([boxRow({ nextFiresAt: undefined })])
    expect(host.querySelector("[data-testid='trigger-fires-nightly']")).toBeNull()
  })
})

describe("the policies and the scheduler", () => {
  test("overlap and catch-up are chips, and catch-up carries its bound when the store set one", () => {
    const chips = texts(render([boxRow()]), "[data-testid='trigger-policy-nightly'] [data-chip]")
    expect(chips).toEqual(["overlap skip", "catch-up one", "max 3"])
  })

  test("a policy the row does not carry is not a chip", () => {
    const chips = texts(render([boxRow({ overlap: undefined, catchUp: undefined, maxCatchUp: undefined })]), "[data-testid='trigger-policy-nightly'] [data-chip]")
    expect(chips).toEqual([])
    expect(texts(render([boxRow({ enabled: false })]), "[data-testid='trigger-policy-nightly'] [data-chip]")).not.toContain("disabled")
  })

  /* The state word says disabled once; policy chips carry only policies. */
  test("a schedule the box holds as off reads disabled in the pane", () => {
    const off = render([boxRow({ enabled: false })])
    expect(off.querySelector("[data-trigger='nightly']")?.getAttribute("data-trigger-state")).toBe("disabled")
    expect(off.querySelector("[data-trigger='nightly'] .flow-trigger-word")?.textContent).toBe("disabled")
  })

  test("a claimed occurrence the box has not launched yet shows the instant it claimed", () => {
    const host = render([boxRow({ pendingAt: FIRES[0]! })])
    expect(host.querySelector("[data-testid='trigger-pending-nightly']")?.textContent).toContain("16:00")
    expect(render([boxRow()]).querySelector("[data-testid='trigger-pending-nightly']")).toBeNull()
  })

  test("the liveness dot is live while the scheduler is ticking and stopped when it never did", () => {
    expect(render([boxRow()]).querySelector("[data-testid='trigger-tick-nightly']")?.getAttribute("data-live")).toBe("true")
    expect(render([boxRow({ schedulerLastTickAt: undefined })]).querySelector("[data-testid='trigger-tick-nightly']")?.getAttribute("data-live"))
      .toBe("false")
  })
})

describe("the runs a schedule is responsible for", () => {
  test("a run in flight is a door onto that run", () => {
    const raised: Array<[string, string | undefined]> = []
    const host = render([boxRow({ activeRunId: "run-9" })], (name, args) => { raised.push([name, args]) })
    const door = host.querySelector<HTMLElement>("[data-testid='trigger-active-nightly']")
    expect(door?.getAttribute("data-flow")).toBe("runs.open")
    door?.click()
    expect(raised).toEqual([["runs.open", `run-9 ${REPO}`]])
  })

  test("a ledger row with a run opens it, and one still claimed says so instead", () => {
    const raised: Array<[string, string | undefined]> = []
    const host = render([boxRow({
      fires: [
        { occurrenceAt: FIRES[0]!, outcome: "completed", runId: "run-8" },
        { occurrenceAt: FIRES[1]!, outcome: null }
      ]
    })], (name, args) => { raised.push([name, args]) })
    const rows = [...host.querySelectorAll<HTMLElement>("[data-testid='trigger-ledger-nightly'] li")]
    expect(rows).toHaveLength(2)
    rows[0]!.querySelector<HTMLElement>("[data-flow]")?.click()
    expect(raised).toEqual([["runs.open", `run-8 ${REPO}`]])
    expect(rows[1]!.textContent).toContain("claimed, not yet reported")
    expect(rows[1]!.querySelector("[data-flow]")).toBeNull()
  })

  test("a row with no ledger read shows no ledger, which is not the same as an empty one", () => {
    expect(render([boxRow()]).querySelector("[data-testid='trigger-ledger-nightly']")).toBeNull()
    expect(render([boxRow({ fires: [] })]).querySelector("[data-testid='trigger-ledger-nightly']")).not.toBeNull()
  })
})

describe("the doors, and the registry each row comes from", () => {
  test("a Plue registration carries Run now and Pause, both addressed by its slug", () => {
    const raised: Array<[string, string | undefined]> = []
    const host = render([plueRow()], (name, args) => { raised.push([name, args]) })
    host.querySelector<HTMLElement>("[data-testid='trigger-run-nightly']")?.click()
    host.querySelector<HTMLElement>("[data-testid='trigger-pause-nightly']")?.click()
    expect(raised).toEqual([
      ["triggers.run", `nightly ${REPO}`],
      ["triggers.pause", JSON.stringify({ slug: "nightly", repo: REPO })]
    ])
  })

  test("a trigger-store row has no slug, so it has no door: no Control RPC addresses one", () => {
    const host = render([boxRow()])
    expect(host.querySelector("[data-testid='trigger-run-nightly']")).toBeNull()
    expect(host.querySelector("[data-testid='trigger-pause-nightly']")).toBeNull()
  })

  test("a Plue row shows no policy chips, because Plue serves none (registry ruling)", () => {
    const host = render([plueRow()])
    expect(host.querySelector("[data-testid='trigger-policy-flow:nightly']")).toBeNull()
    expect(host.querySelector("[data-testid='trigger-tick-flow:nightly']")).toBeNull()
  })

  test("a Plue row shows the one next fire it is served, which is all Plue computes", () => {
    const rows = texts(render([plueRow()]), "[data-testid='trigger-fires-flow:nightly'] li")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.match(/16:00/g)).toHaveLength(1)
  })
})

test("no schedule fires this flow, so the panel is not there at all", () => {
  expect(render([]).textContent).toBe("")
})

test("MINIMAL TEXT: the panel is words to act on, never a sentence", () => {
  const host = render([boxRow({ fires: [{ occurrenceAt: FIRES[0]!, outcome: "completed", runId: "run-8" }] }), plueRow()])
  expect(host.textContent ?? "").not.toMatch(/\.(\s|$)/)
})


test("a paused graph schedule has the same Resume door", () => {
  const raised: Array<[string, string | undefined]> = []
  const host = render([plueRow({ enabled: false })], (name, args) => { raised.push([name, args]) })
  const button = host.querySelector<HTMLButtonElement>("[data-testid='trigger-resume-nightly']")!
  expect(button.tagName).toBe("BUTTON")
  button.click()
  expect(raised).toEqual([["triggers.resume", `nightly ${REPO}`]])
  expect(host.querySelector("[data-testid='trigger-pause-nightly']")).toBeNull()
})
