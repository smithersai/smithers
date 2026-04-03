import { describe, expect, it } from "bun:test"

import type { RunEvent } from "@burns/shared"

import { buildNodeRunTimeline, extractAgentOutputFromChunk } from "./run-timeline"

function makeEvent(event: Partial<RunEvent> & Pick<RunEvent, "seq" | "runId" | "type" | "timestamp">): RunEvent {
  return {
    nodeId: undefined,
    message: undefined,
    rawPayload: undefined,
    ...event,
  }
}

describe("buildNodeRunTimeline", () => {
  it("extracts only agent output blocks from mixed exec logs", () => {
    const mixedChunk = `exec
/bin/zsh -lc 'rg --files' in /tmp/ws
 succeeded in 0ms:
foo.ts
codex
{"question":"Explain this codebase","focusAreas":[]}
exec
/bin/zsh -lc 'git status --short' in /tmp/ws
 succeeded in 0ms:
?? .debug/`

    expect(extractAgentOutputFromChunk(mixedChunk)).toBe(
      '{"question":"Explain this codebase","focusAreas":[]}'
    )
  })

  it("keeps standalone JSON output chunks", () => {
    const jsonChunk = '{"question":"Explain","intentSummary":"summary"}\n'
    expect(extractAgentOutputFromChunk(jsonChunk)).toBe(
      '{"question":"Explain","intentSummary":"summary"}'
    )
  })

  it("collapses NodeStarted/NodeOutput/NodeFinished into one node row", () => {
    const runId = "run-1"
    const events: RunEvent[] = [
      makeEvent({
        seq: 1,
        runId,
        type: "NodeStarted",
        timestamp: "2026-03-12T17:00:00.000Z",
        nodeId: "determine-intent",
        rawPayload: { nodeId: "determine-intent", iteration: 0, attempt: 1 },
      }),
      makeEvent({
        seq: 2,
        runId,
        type: "NodeOutput",
        timestamp: "2026-03-12T17:00:01.000Z",
        nodeId: "determine-intent",
        rawPayload: {
          nodeId: "determine-intent",
          iteration: 0,
          attempt: 1,
          text: "codex\nhello\\nworld",
        },
      }),
      makeEvent({
        seq: 3,
        runId,
        type: "NodeFinished",
        timestamp: "2026-03-12T17:00:02.000Z",
        nodeId: "determine-intent",
        rawPayload: { nodeId: "determine-intent", iteration: 0, attempt: 1 },
      }),
    ]

    const timeline = buildNodeRunTimeline(events)

    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatchObject({
      nodeId: "determine-intent",
      iteration: 0,
      attempt: 1,
      status: "completed",
      firstSeq: 1,
      lastSeq: 3,
      outputText: "hello\\nworld",
    })
  })

  it("deduplicates replayed payloads that only differ by seq", () => {
    const runId = "run-2"
    const replayedPayload = {
      type: "NodeOutput",
      runId,
      nodeId: "determine-intent",
      iteration: 0,
      attempt: 1,
      stream: "stderr",
      text: "codex\ndup-line",
      timestampMs: 1773336687918,
    }

    const timeline = buildNodeRunTimeline([
      makeEvent({
        seq: 1,
        runId,
        type: "NodeOutput",
        timestamp: "2026-03-12T17:00:01.000Z",
        nodeId: "determine-intent",
        rawPayload: { ...replayedPayload, seq: 10 },
      }),
      makeEvent({
        seq: 2,
        runId,
        type: "NodeOutput",
        timestamp: "2026-03-12T17:00:01.000Z",
        nodeId: "determine-intent",
        rawPayload: { ...replayedPayload, seq: 11 },
      }),
    ])

    expect(timeline).toHaveLength(1)
    expect(timeline[0]?.outputText).toBe("dup-line")
  })

  it("repairs common mojibake while preserving line breaks and slashes", () => {
    const timeline = buildNodeRunTimeline([
      makeEvent({
        seq: 1,
        runId: "run-3",
        type: "NodeOutput",
        timestamp: "2026-03-12T17:00:01.000Z",
        nodeId: "determine-intent",
        rawPayload: {
          iteration: 0,
          attempt: 1,
          text: "codex\nI\u00e2\u20ac\u2122ll keep this path: /tmp/test\\nline2",
        },
      }),
    ])

    expect(timeline[0]?.outputText).toBe("I\u2019ll keep this path: /tmp/test\\nline2")
  })

  it("omits pure exec noise from transcript output", () => {
    const timeline = buildNodeRunTimeline([
      makeEvent({
        seq: 1,
        runId: "run-4",
        type: "NodeOutput",
        timestamp: "2026-03-12T17:00:01.000Z",
        nodeId: "determine-intent",
        rawPayload: {
          iteration: 0,
          attempt: 1,
          text: "exec\n/bin/zsh -lc 'ls -la' in /tmp/ws\n succeeded in 0ms:\nfile.txt\n",
        },
      }),
    ])

    expect(timeline[0]?.outputText).toBe("")
  })

  it("keeps plain prose node output when no exec transcript markers are present", () => {
    const proseOutput = "Validation passed.\n\nEverything looks correct."

    const timeline = buildNodeRunTimeline([
      makeEvent({
        seq: 1,
        runId: "run-5",
        type: "NodeOutput",
        timestamp: "2026-03-13T16:07:04.431Z",
        nodeId: "validate",
        rawPayload: {
          iteration: 0,
          attempt: 1,
          text: proseOutput,
        },
      }),
    ])

    expect(timeline[0]?.outputText).toBe(proseOutput)
  })

  it("uses the first observed node event as the start timestamp when NodeStarted is missing", () => {
    const timeline = buildNodeRunTimeline([
      makeEvent({
        seq: 2,
        runId: "run-6",
        type: "ApprovalRequested",
        timestamp: "2026-03-13T15:49:06.511Z",
        nodeId: "approve",
        rawPayload: {
          iteration: 0,
          nodeId: "approve",
        },
      }),
      makeEvent({
        seq: 3,
        runId: "run-6",
        type: "NodeWaitingApproval",
        timestamp: "2026-03-13T15:49:06.511Z",
        nodeId: "approve",
        rawPayload: {
          iteration: 0,
          nodeId: "approve",
        },
      }),
    ])

    expect(timeline[0]).toMatchObject({
      nodeId: "approve",
      startedAt: "2026-03-13T15:49:06.511Z",
      finishedAt: undefined,
      status: "running",
    })
  })
})
