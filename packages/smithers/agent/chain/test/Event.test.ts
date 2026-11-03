import { describe, expect, it } from "vitest"
import * as Event from "../src/Event.vibe"
import * as Outcome from "../src/Outcome.vibe"
import * as Script from "../src/Script.vibe"

const script = Script.make("return done(null)")

const settledCall = (link: number, ordinal: number, name: string): Event.Event => ({
  _tag: "CallSettled",
  key: { entryDigest: "e", link, ordinal, scriptDigest: "s" },
  link,
  name,
  payload: null,
  result: null
})

const rejection = (link: number, ordinal: number, message = "nope"): Event.Event => ({
  _tag: "GateRejected",
  link,
  observation: { kind: "catalog", message },
  ordinal
})

describe("Event", () => {
  it("reports whether the chain started", () => {
    expect(Event.started([])).toBe(false)
    expect(Event.started([{ _tag: "ChainStarted", envelope: null, goal: "g" }])).toBe(true)
  })

  it("counts ended links to name the current one", () => {
    expect(Event.linkCount([])).toBe(0)
    expect(Event.linkCount([
      { _tag: "LinkEnded", link: 0, outcome: Outcome.to(script) },
      { _tag: "LinkEnded", link: 1, outcome: Outcome.done(null) }
    ])).toBe(2)
  })

  it("finds the script authored for a link", () => {
    const events: ReadonlyArray<Event.Event> = [{ _tag: "LinkAuthored", link: 1, script }]
    expect(Event.authored(events, 1)).toEqual(script)
    expect(Event.authored(events, 2)).toBeUndefined()
  })

  it("folds settled calls and rejections by ordinal, per link", () => {
    const events: ReadonlyArray<Event.Event> = [
      settledCall(1, 0, "grep"),
      settledCall(2, 0, "edit"),
      rejection(1, 1),
      rejection(2, 0)
    ]
    const settled = Event.settled(events, 1)
    expect(settled.size).toBe(1)
    expect(settled.get(0)?.name).toBe("grep")
    const rejected = Event.rejected(events, 1)
    expect(rejected.size).toBe(1)
    expect(rejected.get(1)?.observation.kind).toBe("catalog")
  })

  it("collects a link's observations in journal order", () => {
    const events: ReadonlyArray<Event.Event> = [rejection(1, 0, "first"), rejection(2, 0), rejection(1, 1, "second")]
    expect(Event.observations(events, 1)).toEqual([
      { kind: "catalog", message: "first" },
      { kind: "catalog", message: "second" }
    ])
  })

  it("finds the terminal outcome only when the last ended link is done or parked", () => {
    expect(Event.terminal([])).toBeUndefined()
    expect(Event.terminal([{ _tag: "LinkEnded", link: 0, outcome: Outcome.to(script) }])).toBeUndefined()
    expect(Event.terminal([
      { _tag: "LinkEnded", link: 0, outcome: Outcome.to(script) },
      { _tag: "LinkEnded", link: 1, outcome: Outcome.done("x") }
    ])).toEqual(Outcome.done("x"))
    expect(Event.terminal([{ _tag: "LinkEnded", link: 0, outcome: Outcome.park("timer", "t") }]))
      .toEqual(Outcome.park("timer", "t"))
  })
})
