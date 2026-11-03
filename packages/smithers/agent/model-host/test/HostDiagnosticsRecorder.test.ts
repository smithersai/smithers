import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { HOST_DIAGNOSTIC_MARKER } from "../src/HostDiagnostics.vibe"
import { createHostDiagnostics } from "./diagnostics.ts"

const collector = () => {
  const lines: Array<Record<string, unknown>> = []
  return { lines, write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }
}

describe("createHostDiagnostics record envelope", () => {
  test("a field cannot replace the marker, turn, event, phase or time of its record", () => {
    const sink = collector()
    const diagnostics = createHostDiagnostics({ turnId: "turn-1", write: sink.write, clock: () => 0 })
    diagnostics.record("model_stream", "first_event", {
      diagnostic: "forged",
      turnId: "other-turn",
      event: "other",
      phase: "other",
      atMillis: 99,
      droppedFields: 0,
      kind: "text"
    })
    expect(sink.lines).toEqual([{
      diagnostic: HOST_DIAGNOSTIC_MARKER,
      turnId: "turn-1",
      event: "model_stream",
      phase: "first_event",
      atMillis: 0,
      kind: "text",
      droppedFields: 6
    }])
  })

  test("a turn id that is not a short token is left off every record", () => {
    const sink = collector()
    createHostDiagnostics({ turnId: "turn with spaces", write: sink.write, clock: () => 0 }).record("host", "start")
    expect(sink.lines[0]).not.toHaveProperty("turnId")
  })

  test("an operation's completion records its end once", () => {
    const sink = collector()
    const diagnostics = createHostDiagnostics({ write: sink.write, clock: () => 0 })
    const settle = Effect.runSync(diagnostics.begin("chat_callback"))
    settle()
    settle({ status: "late" })
    expect(sink.lines.map((line) => line.phase)).toEqual(["begin", "end"])
  })
})
