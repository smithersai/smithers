import { describe, expect, test } from "vitest"
import type { CauseReceiptData } from "@smthrs/ui"
import {
  clampAudienceRole,
  defaultWorkbenchLayout,
  parseWorkbenchSearch,
  reduceWorkbenchLayout,
  serializeWorkbenchSearch,
  workbenchShortcutAction,
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

describe("workbench keyboard shortcut precedence", () => {
  test("workbenchShortcutAction respects editable targets, composition, modifiers, and Escape stepping", () => {
    const base = { ...defaultWorkbenchLayout("maintainer"), size: "full" as const, frame: 2 as const }
    expect(workbenchShortcutAction({ key: "2", targetTag: "INPUT" }, base, 10)).toBeNull()
    expect(workbenchShortcutAction({ key: "2", targetTag: "TEXTAREA" }, base, 10)).toBeNull()
    expect(workbenchShortcutAction({ key: "2", targetEditable: true }, base, 10)).toBeNull()
    expect(workbenchShortcutAction({ key: "2", isComposing: true }, base, 10)).toBeNull()
    expect(workbenchShortcutAction({ key: "2", defaultPrevented: true }, base, 10)).toBeNull()
    expect(workbenchShortcutAction({ key: "2", metaKey: true }, base, 10)).toBeNull()
    expect(workbenchShortcutAction({ key: "2", repeat: true }, base, 10)).toBeNull()

    expect(workbenchShortcutAction({ key: "2" }, base, 10)).toEqual({ type: "openPane", pane: "attach" })
    expect(workbenchShortcutAction({ key: "[" }, base, 10)).toEqual({ type: "stepBack", totalFrames: 10 })
    expect(workbenchShortcutAction({ key: "]" }, base, 10)).toEqual({ type: "stepForward", totalFrames: 10 })
    expect(workbenchShortcutAction({ key: "0" }, base, 10)).toEqual({ type: "returnLive" })
    expect(workbenchShortcutAction({ key: "Escape" }, base, 10)).toEqual({ type: "restore" })
    expect(workbenchShortcutAction({ key: "Escape" }, { ...base, size: "side" }, 10)).toEqual({ type: "close" })
    expect(workbenchShortcutAction({ key: "Escape" }, { ...base, size: "inline" }, 10)).toBeNull()
  })
})

describe("workbench layout reducer and parser edge coverage", () => {
  test("parses URLSearchParams and plain records with numbers and booleans", () => {
    const fromParams = parseWorkbenchSearch(new URLSearchParams("pane=diff&size=side&frame=4&diffScope=all"), "maintainer")
    expect(fromParams).toEqual({
      pane: "diff",
      size: "side",
      frame: 4,
      audience: "maintainer",
      diffScope: "all",
    })
    const fromRecord = parseWorkbenchSearch({ pane: "attach", frame: 2, size: true, node: "n1" }, "contributor")
    expect(fromRecord.pane).toBe("attach")
    expect(fromRecord.frame).toBe(2)
    expect(fromRecord.size).toBe("inline")
    expect(fromRecord.selectedId).toBe("n1")
  })

  test("covers openPane, inspect, restore, seek, stepBack/Forward on empty frames, selectNode, revealCause, setAudience, setDiffScope, and shortcut edge cases", () => {
    const init = defaultWorkbenchLayout("maintainer")
    const opened = reduceWorkbenchLayout(init, { type: "openPane", pane: "workflow" })
    expect(opened.size).toBe("side")
    expect(reduceWorkbenchLayout(opened, { type: "openPane", pane: "diff" }).size).toBe("side")
    expect(reduceWorkbenchLayout(opened, { type: "inspect" }).size).toBe("side")
    expect(reduceWorkbenchLayout(init, { type: "restore" }).size).toBe("inline")

    expect(reduceWorkbenchLayout(init, { type: "seek", frame: 1, totalFrames: 0 }).frame).toBe("live")
    expect(reduceWorkbenchLayout(init, { type: "seek", frame: Number.NaN, totalFrames: 5 }).frame).toBe("live")
    expect(reduceWorkbenchLayout(init, { type: "stepBack", totalFrames: 0 }).frame).toBe("live")
    expect(reduceWorkbenchLayout(init, { type: "stepForward", totalFrames: 0 }).frame).toBe("live")
    expect(reduceWorkbenchLayout(init, { type: "stepForward", totalFrames: 5 }).frame).toBe("live")
    expect(reduceWorkbenchLayout({ ...init, frame: 2 }, { type: "returnLive" }).frame).toBe("live")

    const withNode = reduceWorkbenchLayout(init, { type: "selectNode", id: "node-1" })
    expect(withNode.selectedId).toBe("node-1")
    expect(reduceWorkbenchLayout(withNode, { type: "selectNode", id: undefined }).selectedId).toBeUndefined()

    const withCause = reduceWorkbenchLayout(init, { type: "revealCause", causeRef: "out-1" })
    expect(withCause.size).toBe("side")
    expect(withCause.causeRef).toBe("out-1")
    expect(reduceWorkbenchLayout(withCause, { type: "revealCause", causeRef: undefined }).causeRef).toBeUndefined()

    expect(reduceWorkbenchLayout(init, { type: "setAudience", role: "visitor", maxRole: "maintainer" }).audience).toBe("visitor")
    expect(reduceWorkbenchLayout(init, { type: "setDiffScope", scope: "branch" }).diffScope).toBe("branch")

    expect(workbenchShortcutAction({ key: "1" }, init, 5)).toBeNull()
    expect(workbenchShortcutAction({ key: "0" }, init, 5)).toBeNull()
    expect(workbenchShortcutAction({ key: "Escape", repeat: true }, opened, 5)).toBeNull()
    expect(workbenchShortcutAction({ key: "x" }, init, 5)).toBeNull()
    // Overflow frame string and invalid frame state branches
    expect(parseWorkbenchSearch("?frame=999999999999999999999999999", "visitor").frame).toBe("live")
    expect(reduceWorkbenchLayout({ ...init, frame: -1 }, { type: "stepBack", totalFrames: 5 }).frame).toBe(3)
  })
})

describe("playground pane wiring", () => {
  test("supports digit 7 shortcut and renders strictly sandboxed iframe for preset repos", () => {
    const def = defaultWorkbenchLayout("visitor")
    expect(workbenchShortcutAction({ key: "7" }, def, 1)).toEqual({ type: "openPane", pane: "playground" })
    const opened = reduceWorkbenchLayout(def, { type: "openPane", pane: "playground" })
    expect(serializeWorkbenchSearch(opened, "visitor").toString()).toBe("pane=playground&size=side")
    expect(parseWorkbenchSearch("?pane=playground&size=side", "visitor").pane).toBe("playground")

    const withPreset = renderWorkbenchShell({
      repoSlug: "evmts/tevm-monorepo",
      layout: opened,
      maxRole: "visitor",
      onDispatch: () => {},
      totalFrames: 1,
      planNodes: [],
      attach: {
        mode: "local-stdio",
        state: "unattached",
        promptText: "connect",
        repoSlug: "evmts/tevm-monorepo",
        branch: "main",
        onModeChange: () => {},
        onCopyPrompt: () => {},
      },
      playground: {
        preset: {
          id: "tevm-evm",
          title: "Tevm Live Sandbox",
          summary: "Run deterministic EVM calls and inspect execution receipts in an isolated sandbox.",
          allowedFlows: ["playground/tevm-call"],
          defaultFlow: "playground/tevm-call",
        },
      },
    })
    expect(withPreset).toContain(`sandbox="allow-scripts"`)
    expect(withPreset).not.toContain("allow-same-origin")
    expect(withPreset).toContain("Tevm Live Sandbox")

    const withoutPreset = renderWorkbenchShell({
      repoSlug: "other/repo",
      layout: opened,
      maxRole: "visitor",
      onDispatch: () => {},
      totalFrames: 1,
      planNodes: [],
      attach: {
        mode: "local-stdio",
        state: "unattached",
        promptText: "connect",
        repoSlug: "other/repo",
        branch: "main",
        onModeChange: () => {},
        onCopyPrompt: () => {},
      },
    })
    expect(withoutPreset).toContain("No interactive playground is configured for this repository.")
  })
})
