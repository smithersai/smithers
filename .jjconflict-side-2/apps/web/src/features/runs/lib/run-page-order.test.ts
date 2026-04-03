import { describe, expect, it } from "bun:test"

import type { NodeRunTimelineItem } from "./run-timeline"

import { sortNodeTimelineForRunPage } from "./run-page-order"

const timeline: NodeRunTimelineItem[] = [
  {
    id: "approve::0::1",
    nodeId: "approve",
    iteration: 0,
    attempt: 1,
    status: "running",
    firstSeq: 2,
    lastSeq: 3,
    outputText: "",
  },
  {
    id: "validate::0::1",
    nodeId: "validate",
    iteration: 0,
    attempt: 1,
    status: "completed",
    firstSeq: 9,
    lastSeq: 13,
    startedAt: "2026-03-13T16:07:04.430Z",
    finishedAt: "2026-03-13T16:07:39.835Z",
    outputText: "validate",
  },
  {
    id: "implement::0::1",
    nodeId: "implement",
    iteration: 0,
    attempt: 1,
    status: "completed",
    firstSeq: 7,
    lastSeq: 8,
    startedAt: "2026-03-13T15:50:04.784Z",
    finishedAt: "2026-03-13T15:55:28.994Z",
    outputText: "implement",
  },
  {
    id: "plan::0::1",
    nodeId: "plan",
    iteration: 0,
    attempt: 1,
    status: "completed",
    firstSeq: 4,
    lastSeq: 5,
    startedAt: "2026-03-13T15:49:07.004Z",
    finishedAt: "2026-03-13T15:50:04.728Z",
    outputText: "plan",
  },
]

describe("sortNodeTimelineForRunPage", () => {
  it("sorts node runs by execution timestamp oldest first", () => {
    const ordered = sortNodeTimelineForRunPage(timeline)

    expect(ordered.map((node) => node.nodeId)).toEqual(["plan", "implement", "validate", "approve"])
  })

  it("pins pending approvals to the end of the run page", () => {
    const ordered = sortNodeTimelineForRunPage(timeline, {
      pendingNodeIds: ["approve"],
    })

    expect(ordered.map((node) => node.nodeId)).toEqual(["plan", "implement", "validate", "approve"])
  })

  it("sorts approved nodes by decision time so post-run approvals stay at the end", () => {
    const ordered = sortNodeTimelineForRunPage(
      [
        {
          ...timeline[0]!,
          startedAt: "2026-03-13T15:49:06.511Z",
        },
        ...timeline.slice(1),
      ],
      {
        decidedAtByNodeId: new Map([["approve", "2026-03-14T19:32:12.181Z"]]),
      }
    )

    expect(ordered.map((node) => node.nodeId)).toEqual(["plan", "implement", "validate", "approve"])
  })

  it("falls back to first seen event order when timestamps are missing", () => {
    const ordered = sortNodeTimelineForRunPage(
      [
        {
          id: "later::0::1",
          nodeId: "later",
          iteration: 0,
          attempt: 1,
          status: "running",
          firstSeq: 11,
          lastSeq: 12,
          outputText: "",
        },
        {
          id: "earlier::0::1",
          nodeId: "earlier",
          iteration: 0,
          attempt: 1,
          status: "running",
          firstSeq: 6,
          lastSeq: 7,
          outputText: "",
        },
      ]
    )

    expect(ordered.map((node) => node.nodeId)).toEqual(["earlier", "later"])
  })
})
