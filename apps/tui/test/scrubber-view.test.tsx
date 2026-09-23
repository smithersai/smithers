import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { ActivityView } from "../src/activity-view.tsx"
import * as Activity from "../src/activity.ts"
import * as Scrubber from "../src/scrubber.ts"
import * as Session from "../src/session.ts"
import * as View from "../src/view.tsx"

const fixture = new URL("./fixtures/timeline-worker.jsonl", import.meta.url).pathname
const activity = Session.restore(Session.load(fixture)).transcript.activity!
const model = Activity.model(activity)

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

/** The dock keeps one blank row above itself. */
const top = 1

const draw = async (width: number, cursor?: number) => {
  const selected: Array<number> = []
  const paused: Array<boolean> = []
  setup = await testRender(
    <box style={{ width, flexDirection: "column" }}>
      <ActivityView activity={activity} width={width} now={Date.now()} title="Worker" cursor={cursor}
        focused={cursor !== undefined} onSelect={(seq) => selected.push(seq)} onPause={() => paused.push(true)} />
    </box>,
    { width, height: 8 }
  )
  await setup.renderOnce()
  return { frame: setup.captureCharFrame(), selected, paused }
}

describe("the scrubber on screen", () => {
  test("draws labelled phases, tick labels, the pause button, and phase with elapsed time", async () => {
    const { frame } = await draw(120)
    expect(frame).toContain("Researching")
    expect(frame).toContain("approvals.ts")
    expect(frame).toContain("completed")
    expect(frame).toContain("Pause")
    expect(frame).toContain("Done")
    expect(frame).toMatch(/\d+:\d{2}/)
    expect(frame).toContain("●")
  })

  test("never draws wider than the terminal", async () => {
    for (const width of [120, 60, 30]) {
      const { frame } = await draw(width)
      for (const line of frame.split("\n")) expect(line.trimEnd().length).toBeLessThanOrEqual(width)
      setup?.renderer.destroy()
      setup = undefined
    }
  })

  test("a click on a tick label jumps to its milestone", async () => {
    const { selected } = await draw(120)
    const layout = Scrubber.layout(activity, 120)
    const tick = layout.ticks.find((each) => each.label === "approvals.ts")!
    await setup!.mockMouse.click(layout.lead + tick.left + 1, top + tick.row)
    expect(selected).toEqual([model.milestones[0]!.seq])
  })

  test("a click on the track jumps to the position under it, and Pause pauses", async () => {
    const { selected, paused } = await draw(120)
    const layout = Scrubber.layout(activity, 120)
    const trackRow = top + layout.rows + 1
    await setup!.mockMouse.click(layout.lead, trackRow)
    expect(selected).toEqual([Scrubber.seqAt(layout, 0)])
    await setup!.mockMouse.click(2, trackRow)
    expect(paused).toEqual([true])
  })

  test("a paused cursor moves the knob and names the phase there", async () => {
    const stuck = model.bands.find((band) => band.phase === "stuck")!
    const { frame } = await draw(120, stuck.seq)
    expect(frame).toContain("Stuck")
    expect(frame).toContain("Live")
  })
})

describe("numbered steps", () => {
  const cell = {
    kind: "cell" as const, id: "7", index: 13, prose: "Spot-check the two named cases and finish.",
    source: "await ctx.call(\"bash\", { command: \"pytest -rA -k slash\" })", status: "done" as const,
    calls: [], printed: "", startedAt: 0, endedAt: 1_200, turn: 0, frame: 1
  }
  const line = { spanId: "frame-1", frame: 1, verb: "Ran", subject: "pytest -rA -k slash", result: "3 passed", failed: false, wrote: false }
  const notes = [
    { seq: 4, spanId: "frame-1", tone: "good" as const, title: "sufficiency", body: "bash failed before the change and passed after it.",
      evidence: ["pytest -rA", "pytest -rA -k slash"] },
    { seq: 5, spanId: "frame-1", tone: "bad" as const, title: "claim refused", body: "complete 0, overclaims 1." }
  ]

  test("a step reads its number, its line, its outcome at the right, the quoted intent, and its callouts", async () => {
    setup = await testRender(<box style={{ width: 90 }}><View.Entry item={cell} now={0} tick="" expanded={false} step={{ line, notes }} /></box>,
      { width: 90, height: 24 })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    const header = frame.split("\n").find((row) => row.includes("13"))!
    expect(header).toMatch(/▾ 13\s+Ran pytest -rA -k slash\s+3 passed\s+1\.2s/)
    expect(frame).toContain("“Spot-check the two named cases and finish.”")
    expect(frame).toContain("✓ sufficiency")
    expect(frame).toContain("pytest -rA -k slash")
    expect(frame).toContain("△ claim refused")
  })

  test("a click on the header folds the step to one line and keeps its callouts", async () => {
    setup = await testRender(<box style={{ width: 90 }}><View.Entry item={cell} now={0} tick="" expanded={false} step={{ line, notes }} /></box>,
      { width: 90, height: 24 })
    await setup.renderOnce()
    await setup.mockMouse.click(4, 0)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("▸ 13")
    expect(frame).not.toContain("Spot-check")
    expect(frame).toContain("△ claim refused")
  })
})
