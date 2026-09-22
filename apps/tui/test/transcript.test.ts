import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as Transcript from "../src/transcript.ts"

/** A recorded gpt-5.6-sol run that fixes `add` in a scratch repo. */
const recorded = readFileSync(join(import.meta.dir, "fixtures/fix-add.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))

const replay = (upTo = recorded.length) =>
  recorded.slice(0, upTo).reduce(
    (transcript, { at, event }) => Transcript.apply(transcript, event, at),
    Transcript.user(Transcript.empty, "node check.mjs fails. Fix it and show it passes.")
  )

const cells = (transcript: Transcript.Transcript) =>
  transcript.items.filter((item): item is Extract<Transcript.Item, { kind: "cell" }> => item.kind === "cell")

describe("replaying a recorded run", () => {
  it("shows one settled cell per produced program, then the answer", () => {
    const transcript = replay()
    const produced = recorded.filter(({ event }) => event._tag === "cell-produced").map(({ event }) => event.cell.text)
    expect(cells(transcript).map((cell) => cell.source)).toEqual(produced)
    expect(cells(transcript).every((cell) => cell.status === "done" && cell.endedAt !== undefined)).toBe(true)
    expect(transcript.items.at(-1)).toMatchObject({ kind: "answer" })
    expect(transcript.items.map((item: Transcript.Item) => item.kind).filter((kind: string) => kind !== "cell")).toEqual(["user", "answer"])
  })

  it("attaches every flow call to the cell that made it, settled", () => {
    const calls = cells(replay()).flatMap((cell) => cell.calls)
    expect(calls.length).toBe(recorded.filter(({ event }) => event._tag === "cell-call-started").length)
    expect(calls.every((call) => call.status !== "running" && call.endedAt !== undefined)).toBe(true)
    expect(calls.some((call) => call.flow === "bash" && call.subject.includes("node check.mjs"))).toBe(true)
  })

  it("streams a cell's code before the harness runs it", () => {
    const produced = recorded.findIndex(({ event }) => event._tag === "cell-produced")
    const first = cells(replay(produced))[0]!
    const final = recorded[produced].event.cell.text as string
    expect(first.status).toBe("writing")
    expect(first.source.length).toBeGreaterThan(0)
    expect(final.startsWith(first.source.slice(0, 20))).toBe(true)
  })

  it("starts a cell's clock when its model call was requested", () => {
    const requested = recorded.find(({ event }) => event._tag === "model-requested")!
    expect(cells(replay())[0]!.startedAt).toBe(requested.at)
  })

  it("records a command's nonzero exit on its call", () => {
    const calls = cells(replay()).flatMap((cell) => cell.calls)
    const failing = recorded.filter(({ event }) =>
      event._tag === "cell-call-settled" && typeof event.result.value?.exitCode === "number" && event.result.value.exitCode !== 0
    )
    expect(failing.length).toBeGreaterThan(0)
    expect(calls.filter((call) => call.exit !== undefined).map((call) => call.exit)).toEqual(
      failing.map(({ event }) => event.result.value.exitCode)
    )
  })
})

describe("split", () => {
  it("separates prose from an unterminated fence while it streams", () => {
    expect(Transcript.split("Reading it.\n```cell\nconst a = 1")).toEqual({ prose: "Reading it.", code: "const a = 1" })
  })

  it("waits for the info string before showing code", () => {
    expect(Transcript.split("```ce")).toEqual({ prose: "", code: "" })
  })

  it("joins several blocks and keeps prose after them", () => {
    expect(Transcript.split("```cell\na()\n```\nthen\n```cell\nb()\n```\ndone")).toEqual({
      prose: "then\ndone",
      code: "a()\nb()"
    })
  })
})

describe("failures", () => {
  it("marks the open cell failed and shows the message", () => {
    const writing = Transcript.apply(
      Transcript.empty,
      { _tag: "model-delta", delta: { type: "text-delta", id: "m", text: "```cell\nx(" } } as never,
      0
    )
    const failed = Transcript.failure(writing, "Our servers are currently overloaded.", 5)
    expect(cells(failed)[0]).toMatchObject({ status: "failed", endedAt: 5 })
    expect(failed.items.at(-1)).toMatchObject({ kind: "error", text: "Our servers are currently overloaded." })
  })
})
