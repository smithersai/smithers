import { useRef, type ReactNode } from "react"
import {
  AudienceSwitch,
  Badge,
  Button,
  CauseTrail,
  ForkBadge,
  FrameScrubber,
  PaneFrame,
  PlanTree,
  StateMachineView,
  WaitlistCard,
  WorkflowExecutionView,
  type AudienceRole,
  type CauseReceiptData,
  type PlanTreeNodeItem,
  type ProofVerdict,
  type StateTransitionItem,
  type WaitlistCardProps,
  type WorkflowNodeItem,
} from "@smthrs/ui"
import { PlaygroundFrame } from "./PlaygroundFrame.tsx"
import type { PlaygroundPreset, PlaygroundRequest } from "./playgroundBridge.ts"
import {
  clampAudienceRole,
  type DiffScope,
  type WorkbenchAction,
  type WorkbenchLayout,
  type WorkbenchPaneId,
} from "./layout.ts"

export type ActivityBurst = {
  readonly id: string
  readonly summary: string
  readonly count: number
  readonly pane: WorkbenchPaneId
  readonly cause?: CauseReceiptData
}

export type WorkbenchShellProps = {
  readonly repoSlug: string
  readonly layout: WorkbenchLayout
  readonly maxRole: AudienceRole
  readonly onDispatch: (action: WorkbenchAction) => void
  readonly totalFrames: number
  readonly fork?: {
    readonly forkOrg: string
    readonly upstreamRepo: string
    readonly upstreamHref?: string
  }
  readonly activityBursts?: ReadonlyArray<ActivityBurst>
  readonly chatColumn?: ReactNode
  readonly planNodes: ReadonlyArray<PlanTreeNodeItem>
  readonly onToggleAssumption?: (nodeId: string, assumptionId: string) => void
  readonly attachHref: string
  readonly workflow?: {
    readonly workflowTag: string
    readonly sourcePath: string
    readonly nodes: ReadonlyArray<WorkflowNodeItem>
    readonly onReplayFromNode?: (nodeId: string) => void
  }
  readonly stateMachine?: {
    readonly name: string
    readonly revision: string
    readonly verdict: ProofVerdict
    readonly transitions: ReadonlyArray<StateTransitionItem>
    readonly onVerifyProof?: () => void
  }
  readonly waitlist?: WaitlistCardProps
  readonly playground?: {
    readonly preset: PlaygroundPreset
    readonly onInvoke?: (request: PlaygroundRequest) => unknown | Promise<unknown>
  }
  readonly activeCause?: CauseReceiptData
  readonly onRevealRun?: (runId: string) => void
  readonly diffContent?: ReactNode
  readonly actionStrip?: ReactNode
}

const PANE_LABEL: Record<WorkbenchPaneId, string> = {
  plan: "Plan Tree",
  attach: "Attach agent",
  workflow: "Workflow run",
  "state-machine": "State machine",
  diff: "Diff review",
  waitlist: "Host repository",
  playground: "Playground",
}

const DIFF_SCOPE_LABEL: Record<DiffScope, string> = {
  turn: "Turn",
  branch: "Branch",
  all: "All changes",
}

/**
 * Ultra-thin React workbench presentation shell over URL-owned WorkbenchLayout.
 * Zero useState or useEffect hooks for application state.
 * Combines chat, collapsible activity summaries, host-owned 3-tier PaneFrame,
 * BYOA MCP attach, causal provenance trail, replay scrubber, and downward audience lens.
 */
export function WorkbenchShell({
  repoSlug,
  layout,
  maxRole,
  onDispatch,
  totalFrames,
  fork,
  activityBursts = [],
  chatColumn,
  planNodes,
  onToggleAssumption,
  attachHref,
  workflow,
  stateMachine,
  waitlist,
  playground,
  activeCause,
  onRevealRun,
  diffContent,
  actionStrip,
}: WorkbenchShellProps) {
  const paneContainerRef = useRef<HTMLDivElement>(null)
  const effectiveAudience = clampAudienceRole(layout.audience, maxRole)
  const safeTotal = Number.isSafeInteger(totalFrames) && totalFrames > 0 ? totalFrames : 0
  const maxFrame = Math.max(0, safeTotal - 1)
  const isLive = layout.frame === "live" || safeTotal === 0
  const currentFrame = isLive
    ? maxFrame
    : Math.min(Math.max(0, Number.isSafeInteger(layout.frame) ? layout.frame : maxFrame), maxFrame)
  const isFull = layout.size === "full"

  const focusPaneControlAfterTransition = (targetLabel: string) => {
    if (typeof queueMicrotask !== "function") return
    queueMicrotask(() => {
      const container = paneContainerRef.current
      if (!container) return
      const target =
        container.querySelector<HTMLElement>(`button[aria-label="${targetLabel}"]`) ??
        container.querySelector<HTMLElement>('[data-slot="pane-frame-controls"] button') ??
        container
      target.focus()
    })
  }

  const paneTitle = PANE_LABEL[layout.pane]

  const paneBody = (() => {
    switch (layout.pane) {
      case "plan":
        return (
          <PlanTree
            nodes={planNodes}
            {...(layout.selectedId !== undefined ? { selectedId: layout.selectedId } : {})}
            onSelect={(id) => onDispatch({ type: "selectNode", id })}
            {...(onToggleAssumption !== undefined ? { onToggleAssumption } : {})}
            onRevealCause={(receipt) => onDispatch({ type: "revealCause", causeRef: receipt.outputRef })}
          />
        )
      case "attach":
        return <Button asChild variant="outline"><a href={attachHref}>Attach in branch chat</a></Button>
      case "workflow":
        return workflow ? (
          <WorkflowExecutionView
            workflowTag={workflow.workflowTag}
            sourcePath={workflow.sourcePath}
            nodes={workflow.nodes}
            {...(layout.selectedId !== undefined ? { selectedNodeId: layout.selectedId } : {})}
            onSelectNode={(id) => onDispatch({ type: "selectNode", id })}
            {...(workflow.onReplayFromNode !== undefined ? { onReplayFromNode: workflow.onReplayFromNode } : {})}
            onRevealCause={(receipt) => onDispatch({ type: "revealCause", causeRef: receipt.outputRef })}
          />
        ) : (
          <div data-slot="workbench-empty-pane">No workflow run selected.</div>
        )
      case "state-machine":
        return stateMachine ? (
          <StateMachineView
            name={stateMachine.name}
            revision={stateMachine.revision}
            verdict={stateMachine.verdict}
            transitions={stateMachine.transitions}
            {...(layout.selectedId !== undefined ? { selectedTransitionId: layout.selectedId } : {})}
            onSelectTransition={(id) => onDispatch({ type: "selectNode", id })}
            {...(stateMachine.onVerifyProof !== undefined ? { onVerifyProof: stateMachine.onVerifyProof } : {})}
          />
        ) : (
          <div data-slot="workbench-empty-pane">No state machine loaded.</div>
        )
      case "diff":
        return (
          <div data-slot="workbench-diff-pane" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div role="group" aria-label="Diff scope" style={{ display: "flex", gap: "6px" }}>
              {(["turn", "branch", "all"] as const).map((scope) => (
                <Button
                  key={scope}
                  type="button"
                  size="sm"
                  variant={layout.diffScope === scope ? "default" : "ghost"}
                  aria-pressed={layout.diffScope === scope}
                  onClick={() => onDispatch({ type: "setDiffScope", scope })}
                >
                  {DIFF_SCOPE_LABEL[scope]}
                </Button>
              ))}
            </div>
            {diffContent ?? <div data-slot="workbench-empty-pane">No diff changes in this scope.</div>}
          </div>
        )
      case "waitlist":
        return waitlist ? (
          <WaitlistCard {...waitlist} />
        ) : (
          <div data-slot="workbench-empty-pane">Waitlist unavailable.</div>
        )
      case "playground":
        return playground ? (
          <PlaygroundFrame
            preset={playground.preset}
            {...(playground.onInvoke !== undefined ? { onInvoke: playground.onInvoke } : {})}
          />
        ) : (
          <div data-slot="workbench-empty-pane">No interactive playground is configured for this repository.</div>
        )
    }
  })()

  return (
    <div
      data-slot="workbench-shell"
      data-repo={repoSlug}
      data-pane={layout.pane}
      data-size={layout.size}
      data-audience={effectiveAudience}
      onKeyDown={(event) => {
        if (event.key === "Escape" && isFull) {
          event.preventDefault()
          onDispatch({ type: "restore" })
          focusPaneControlAfterTransition(`Maximize ${paneTitle}`)
        }
      }}
      style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "100%", overflowX: "clip" }}
    >
      <header
        data-slot="workbench-topbar"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <strong data-slot="workbench-repo-slug">{repoSlug}</strong>
          {fork ? (
            <ForkBadge
              forkOrg={fork.forkOrg}
              upstreamRepo={fork.upstreamRepo}
              {...(fork.upstreamHref !== undefined ? { upstreamHref: fork.upstreamHref } : {})}
            />
          ) : null}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <nav aria-label="Workbench panes" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
            {(["plan", "attach", "workflow", "state-machine", "diff", "waitlist", "playground"] as const).map((paneId) => (
              <Button
                key={paneId}
                type="button"
                size="sm"
                variant={layout.pane === paneId ? "default" : "ghost"}
                aria-pressed={layout.pane === paneId}
                onClick={() => onDispatch({ type: "openPane", pane: paneId })}
              >
                {PANE_LABEL[paneId]}
              </Button>
            ))}
          </nav>

          <AudienceSwitch
            maxRole={maxRole}
            activeRole={effectiveAudience}
            onChange={(role) => onDispatch({ type: "setAudience", role, maxRole })}
          />
        </div>
      </header>

      <FrameScrubber
        totalFrames={safeTotal}
        currentFrame={currentFrame}
        isLive={isLive}
        onStepBack={() => onDispatch({ type: "stepBack", totalFrames: safeTotal })}
        onStepForward={() => onDispatch({ type: "stepForward", totalFrames: safeTotal })}
        onSeek={(frame) => onDispatch({ type: "seek", frame, totalFrames: safeTotal })}
        onReturnLive={() => onDispatch({ type: "returnLive" })}
      />

      {activeCause ? (
        <div data-slot="workbench-cause-bar">
          <CauseTrail
            receipt={activeCause}
            onRevealPlan={(r) => onDispatch({ type: "revealCause", causeRef: r.outputRef })}
            {...(onRevealRun !== undefined ? { onRevealRun } : {})}
          />
        </div>
      ) : null}

      <div
        data-slot="workbench-body"
        style={{
          display: "grid",
          gridTemplateColumns:
            isFull || layout.size === "inline"
              ? "minmax(0, 1fr)"
              : "repeat(auto-fit, minmax(min(100%, 300px), 1fr))",
          gap: "12px",
          alignItems: "start",
          minWidth: 0,
        }}
      >
        {!isFull ? (
          <section
            data-slot="workbench-chat-column"
            aria-label="Chat and activity"
            style={{ display: "flex", flexDirection: "column", gap: "10px", minWidth: 0 }}
          >
            {chatColumn}
            {activityBursts.length > 0 ? (
              <ul
                data-slot="workbench-activity-bursts"
                aria-label="Recent workflow activity"
                style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}
              >
                {activityBursts.map((burst) => (
                  <li key={burst.id}>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onDispatch({ type: "openPane", pane: burst.pane, size: "side" })}
                    >
                      <span>{burst.summary}</span>
                      <Badge variant="muted">{burst.count}</Badge>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        <div ref={paneContainerRef} tabIndex={-1} style={{ minWidth: 0, outline: "none" }}>
          <PaneFrame
            paneId={layout.pane}
            title={paneTitle}
            size={layout.size}
            origin="core"
            onInspect={() => {
              onDispatch({ type: "inspect" })
              focusPaneControlAfterTransition(`Maximize ${paneTitle}`)
            }}
            onMaximize={() => {
              onDispatch({ type: "maximize" })
              focusPaneControlAfterTransition(`Restore ${paneTitle}`)
            }}
            onRestore={() => {
              onDispatch({ type: "restore" })
              focusPaneControlAfterTransition(`Maximize ${paneTitle}`)
            }}
            onClose={() => {
              onDispatch({ type: "close" })
              focusPaneControlAfterTransition(`Inspect ${paneTitle}`)
            }}
            {...(actionStrip !== undefined ? { actionStrip } : {})}
          >
            {paneBody}
          </PaneFrame>
        </div>
      </div>
    </div>
  )
}
