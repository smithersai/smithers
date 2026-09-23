import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import * as Activity from "../src/activity.ts"
import * as Transcript from "../src/transcript.ts"
import * as Session from "../src/session.ts"
import type { AgentEvent } from "@smthrs/harness/AgentEvent"

const events = readFileSync(new URL("./fixtures/fix-add.jsonl", import.meta.url), "utf8").trim().split("\n")
  .map(line => JSON.parse(line) as { event: AgentEvent; at: number })
const replay = () => events.reduce((state, { event, at }) => Transcript.apply(state, event, at), Transcript.empty)

describe("the shared terminal monitor", () => {
  test("a real recorded session keeps phases, edit pins, call outcomes, and completion", () => {
    const activity = replay().activity!
    const model = Activity.model(activity)
    expect(activity.status).toBe("completed")
    expect(model.bands.some(band => band.phase === "implementing")).toBe(true)
    expect(model.bands.some(band => band.phase === "researching")).toBe(true)
    expect(model.milestones.some(pin => pin.label === "math.js")).toBe(true)
    expect(activity.records.some(record => record.kind === "control.agent.cell-call-settled" &&
      (record.payload as { value?: { exitCode?: number } }).value?.exitCode === 1)).toBe(true)
    expect(activity.records.every(record => record.kind !== "control.agent.model-delta")).toBe(true)
  })

  test("session restore reconstructs the same timeline from durable events", () => {
    const records: Session.Record[] = events.map(row => ({ type: "event", ...row }))
    const restored = Session.restore(records)
    expect(Activity.model(restored.transcript.activity!)).toEqual(Activity.model(replay().activity!))
  })

  test("scrubbing cannot show the future result of a call that was still open", () => {
    const activity = replay().activity!
    const start = activity.records.find(record => record.kind === "control.agent.cell-call-started")!
    const selected = Activity.at(activity, start.sequence!)
    expect(selected.lines[0]!.result).toBe("")
    expect(selected.rows.find(span => span.kind === "call")!.status).toBe("running")
  })

  test("every event is reachable, and a new turn cannot retain the previous verdict", () => {
    const transcript = replay(), activity = transcript.activity!
    const first = activity.records[0]!.sequence!, last = activity.records.at(-1)!.sequence!
    expect(Activity.move(activity, undefined, "home")).toBe(first)
    expect(Activity.move(activity, first, "left")).toBe(first)
    expect(Activity.move(activity, last, "right")).toBe(last)
    expect(Activity.move(activity, last, "escape")).toBeUndefined()
    const next = Transcript.user(transcript, "next request", false, 100)
    expect(next.activity).toEqual(Activity.empty)
    expect(Transcript.user(transcript, "steer", true, 100).activity).toBe(activity)
  })

  test("failure and cancellation retain their real endpoints", () => {
    const failed = Activity.finish(Activity.empty, "failed", 100, "broken")
    const stopped = Activity.finish(Activity.empty, "cancelled", 200, "Stopped")
    expect(Activity.model(failed).root.status).toBe("failed")
    expect(Activity.model(stopped).root.status).toBe("cancelled")
    expect(Activity.finish(failed, "failed", 300, "broken")).toBe(failed)
  })

  test("bands stay within narrow and wide terminals", () => {
    const model = Activity.model(replay().activity!)
    for (const width of [1, 20, 40, 80, 120]) {
      const sizes = Activity.widths(model, width)
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(width)
      expect(sizes.every(size => size >= 0)).toBe(true)
    }
  })
})
