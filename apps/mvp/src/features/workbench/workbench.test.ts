import { describe, expect, test } from "vitest"
import type { CauseReceiptData } from "@smthrs/ui"
import {
  clampAudienceRole,
  defaultWorkbenchLayout,
  parseWorkbenchSearch,
  reduceWorkbenchLayout,
  serializeWorkbenchSearch,
  type WorkbenchPaneId,
} from "./layout.ts"
import { renderWorkbenchShell } from "./workbench-render.tsx"

const SAMPLE_CAUSE: CauseReceiptData = {
  outputRef: "out_plan_42",
  runId: "run_9f8e7d6c",
  nodeId: "plan-tree/update",
  journalSeq: 42,
  origin: {
    kind: "plan",
    page: "M1-core",
    blockId: "b1",
    rev: "8c6700ac",
    label: "M1 Core Plan",
  },
}

describe("workbench URL layout state machine", () => {
  test("parses and serializes cleanly while omitting defaults and invalid frames", () => {
    const def = defaultWorkbenchLayout("maintainer")
    expect(serializeWorkbenchSearch(def, "maintainer").toString()).toBe("")

    const parsed = parseWorkbenchSearch(
      "?pane=workflow&size=full&frame=12&node=step-2&cause=out_plan_42&audience=visitor&diffScope=branch",
      "maintainer",
    )
    expect(parsed).toEqual({
      pane: "workflow",
      size: "full",
      frame: 12,
      selectedId: "step-2",
      causeRef: "out_plan_42",
      audience: "visitor",
      diffScope: "branch",
    })
    expect(serializeWorkbenchSearch(parsed, "maintainer").toString()).toBe(
      "pane=workflow&size=full&frame=12&node=step-2&cause=out_plan_42&audience=visitor&diffScope=branch",
    )

    // Serializer must refuse invalid non-finite / negative / fractional frames
    for (const badFrame of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(
        serializeWorkbenchSearch({ ...def, frame: badFrame }, "maintainer").has("frame"),
      ).toBe(false)
    }
  })

  test("clamps audience strictly downward, rejects malformed params, and ignores inherited record keys", () => {
    expect(clampAudienceRole("maintainer", "visitor")).toBe("visitor")
    expect(clampAudienceRole("maintainer", "contributor")).toBe("contributor")
    expect(clampAudienceRole("visitor", "maintainer")).toBe("visitor")

    const hostile = parseWorkbenchSearch(
      "?pane=evil&size=huge&frame=-5&audience=maintainer&diffScope=drop",
      "visitor",
    )
    expect(hostile).toEqual({
      pane: "plan",
      size: "inline",
      frame: "live",
      audience: "visitor",
      diffScope: "turn",
    })

    const inherited = Object.create({ pane: "waitlist", size: "full", frame: "3" }) as Record<string, unknown>
    expect(parseWorkbenchSearch(inherited, "visitor")).toEqual(defaultWorkbenchLayout("visitor"))
  })

  test("handles 3-tier progressive disclosure and clamped replay cursor transitions", () => {
    let state = defaultWorkbenchLayout("maintainer")
    state = reduceWorkbenchLayout(state, { type: "inspect" })
    expect(state.size).toBe("side")
    state = reduceWorkbenchLayout(state, { type: "maximize" })
    expect(state.size).toBe("full")
    state = reduceWorkbenchLayout(state, { type: "restore" })
    expect(state.size).toBe("side")
    state = reduceWorkbenchLayout(state, { type: "close" })
    expect(state.size).toBe("inline")

    // Starting at out-of-range frame=99 with 5 frames (0..4): stepBack clamps to 4 first, then moves to 3
    state = reduceWorkbenchLayout({ ...state, frame: 99 }, { type: "stepBack", totalFrames: 5 })
    expect(state.frame).toBe(3)
    // stepForward from 3 enters frame 4 (holds last frame), then stepping forward from 4 returns live
    state = reduceWorkbenchLayout(state, { type: "stepForward", totalFrames: 5 })
    expect(state.frame).toBe(4)
    state = reduceWorkbenchLayout(state, { type: "stepForward", totalFrames: 5 })
    expect(state.frame).toBe("live")
    // Seeking NaN is ignored; invalid totalFrames returns live
    const atTwo = reduceWorkbenchLayout(state, { type: "seek", frame: 2, totalFrames: 5 })
    expect(reduceWorkbenchLayout(atTwo, { type: "seek", frame: Number.NaN, totalFrames: 5 }).frame).toBe(2)
    expect(reduceWorkbenchLayout(atTwo, { type: "stepBack", totalFrames: Number.NaN }).frame).toBe("live")

    state = reduceWorkbenchLayout(state, { type: "setAudience", role: "maintainer", maxRole: "contributor" })
    expect(state.audience).toBe("contributor")
  })
})

describe("WorkbenchShell presentation", () => {
  const baseProps = {
    repoSlug: "smithersai/effect",
    maxRole: "contributor" as const,
    onDispatch: () => {},
    totalFrames: 12,
    fork: {
      forkOrg: "smithersai",
      upstreamRepo: "Effect-TS/effect",
      upstreamHref: "https://github.com/Effect-TS/effect",
    },
    activityBursts: [
      { id: "b1", summary: "Ran fast-check on 4 packages", count: 4, pane: "workflow" as const },
    ],
    planNodes: [
      {
        id: "n1",
        title: "Ship local-first shard sync",
        milestone: "M1",
        status: "in_progress" as const,
        depth: 0,
        sources: ["packages/smithers/app-state/src/PlanTree.ts"],
        cause: SAMPLE_CAUSE,
      },
    ],
    attach: {
      mode: "local-stdio" as const,
      state: "consent_pending" as const,
      promptText: "Run smthrs attach --intent att_123",
      repoSlug: "smithersai/effect",
      branch: "main",
      agentLabel: "Claude Code",
      onApproveConsent: () => {},
    },
    workflow: {
      workflowTag: "ci/fast-check",
      sourcePath: ".smithers/workflows/fast-check.vibe",
      nodes: [
        { id: "s1", label: "Typecheck affected", kind: "action" as const, status: "completed", durationMs: 310 },
      ],
    },
    stateMachine: {
      name: "PlanTreeState",
      revision: "8c6700ac1414",
      verdict: "proved" as const,
      transitions: [
        { id: "t1", from: "pending", event: "start", to: "in_progress", verdict: "proved" as const, theoremName: "plan_start_valid" },
      ],
    },
    waitlist: {
      repoUrl: "https://github.com/acme/widget",
      status: "idle" as const,
      onRepoUrlChange: () => {},
      onSubmit: () => {},
    },
    activeCause: SAMPLE_CAUSE,
  }

  test("renders responsive side workbench with fork badge, downward audience, and clean copy", () => {
    const html = renderWorkbenchShell({
      ...baseProps,
      layout: {
        pane: "plan",
        size: "side",
        frame: 4,
        selectedId: "n1",
        audience: "maintainer",
        diffScope: "turn",
      },
    })

    expect(html).toContain('data-audience="contributor"')
    expect(html).toContain("smithersai/ example fork")
    expect(html).toContain("Frame 5 of 12")
    expect(html).toContain("repeat(auto-fit, minmax(min(100%, 300px), 1fr))")
    expect(html).toContain("Ship local-first shard sync")
    expect(html).toContain("Ran fast-check on 4 packages")
    expect(html).toContain('data-slot="workbench-chat-column"')
    expect(html).not.toContain("Maintainer")
  })

  test("maximizing a pane hides the chat column and renders full workbench", () => {
    const html = renderWorkbenchShell({
      ...baseProps,
      layout: {
        pane: "attach",
        size: "full",
        frame: "live",
        audience: "contributor",
        diffScope: "turn",
      },
    })

    expect(html).toContain('data-size="full"')
    expect(html).not.toContain('data-slot="workbench-chat-column"')
    expect(html).toContain("Allow Claude Code on smithersai/effect (main)")
  })

  test("renders all 6 panes with clean text copy and neutral empty waitlist fallback", () => {
    const panes: ReadonlyArray<WorkbenchPaneId> = [
      "plan",
      "attach",
      "workflow",
      "state-machine",
      "diff",
      "waitlist",
    ]
    for (const pane of panes) {
      const html = renderWorkbenchShell({
        ...baseProps,
        layout: { pane, size: "side", frame: "live", audience: "contributor", diffScope: "branch" },
      })
      const visibleText = html.replace(/<[^>]+>/g, " ").replace(/&(gt|lt|amp|quot|#x27);/g, "")
      expect(visibleText).not.toContain(";")
      expect(visibleText).not.toContain("—")
      expect(visibleText.toLowerCase()).not.toContain("jjhub")
    }

    const { waitlist: _omitted, ...withoutWaitlist } = baseProps
    const missingWaitlistHtml = renderWorkbenchShell({
      ...withoutWaitlist,
      layout: { pane: "waitlist", size: "side", frame: "live", audience: "contributor", diffScope: "turn" },
    })
    expect(missingWaitlistHtml).toContain("Waitlist unavailable.")
    expect(missingWaitlistHtml).not.toContain("already active")
  })
})
