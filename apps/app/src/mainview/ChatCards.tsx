/*
 * The card shell: header (title, status pill, kind and time), the maximize and
 * frame controls, and the body from the kind's family renderer.
 *
 * Every card body lives in a family file under ./cards and registers itself in
 * cards/CardRenderers.tsx; this file never names a card kind except to stamp
 * the run id on a flow-run card's shell.
 */
import { Button, StatusPill } from "@smthrs/ui"
import { ArrowLeft, ArrowRight, GitFork, Maximize2, Minimize2, PanelTop } from "lucide-react"
import { memo, useRef } from "react"
import type { CardActions } from "./cards/CardFamily"
import { pillStatus, renderCardBody } from "./cards/CardRenderers"
import type { Card } from "./state/AppState"
import { timeLabel as clockLabel } from "./Timestamps"

export interface CardViewProps extends CardActions {
  readonly card: Card
  readonly maximized: boolean
  readonly onMaximize: (id: string) => void
  readonly onMinimize: () => void
  readonly onFrameBack?: () => void
  readonly onFrameForward?: () => void
  readonly onForkFrame?: () => void
  /* A maximized card's "Open in tab" (docs/LOCAL-APP.md "Cards"): user-triggered only. */
  readonly onOpenInTab: (id: string) => void
}

/*
 * Memoized: App renders the whole transcript on every streaming token, and a
 * card whose props are unchanged has nothing new to draw. Every callback comes
 * from cards/CardActions.ts, built once per controller, so the default shallow
 * comparison actually bails out — the only cards that re-render are the ones
 * whose record, maximized state, verbose flag or world documents changed.
 */
export const CardView = memo(function CardView({
  card,
  maximized,
  onDecideApproval,
  onGrantConfirm,
  onGrantCancel,
  onQueueApprove,
  onMaximize,
  onMinimize,
  onFrameBack,
  onFrameForward,
  onForkFrame,
  onOpenInTab,
  onConnectGitHub,
  onConnectLocal,
  onRunWorkflow,
  onStopRun,
  onRetryRun,
  onChooseWorkflowRepo,
  worldDocuments,
  onChangeWorldDocument,
  onAttachWorldEditor,
  onRunCommand,
  debugVerbose,
  workflowCatalogs,
  signedOut
}: CardViewProps) {
  /*
   * Maximize and minimize replace each other in the header, so the button
   * the pointer just pressed unmounts and focus falls to <body> — outside
   * the shell whose onKeyDown owns Escape. Each act hands focus to the
   * button that took its place, so Escape (and the Tab ring) keep working.
   */
  const maximizeRef = useRef<HTMLButtonElement>(null)
  const minimizeRef = useRef<HTMLButtonElement>(null)
  const maximizeThenFocus = (): void => {
    onMaximize(card.id)
    requestAnimationFrame(() => minimizeRef.current?.focus())
  }
  const minimizeThenFocus = (): void => {
    onMinimize()
    requestAnimationFrame(() => maximizeRef.current?.focus())
  }
  return (
    <>
      {maximized ?
        (
          <div
            className="card-maximize-backdrop"
            aria-hidden="true"
            onClick={minimizeThenFocus}
          />
        ) :
        null}
      <section
        className="smithers-card"
        data-kind={card.kind}
        data-status={card.status}
        data-maximized={maximized}
        data-run-id={card.kind === "run-trace" ? card.payload.runId : undefined}
        data-testid={`card-${card.id}`}
        aria-label={card.title}
      >
        <header className="smithers-card-header">
          <span className="smithers-card-title">{card.title}</span>
          <StatusPill status={pillStatus(card)} />
          <span className="smithers-card-meta" data-testid={`card-kind-${card.kind}`}>
            {card.kind} · {clockLabel(card.createdAt)}
          </span>
          {maximized ?
            (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  data-flow="frame.back"
                  data-testid="frame-back"
                  aria-label="Previous frame"
                  title="Previous frame"
                  onClick={() => onFrameBack?.()}
                >
                  <ArrowLeft size={13} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  data-flow="frame.forward"
                  data-testid="frame-forward"
                  aria-label="Next frame"
                  title="Next frame"
                  onClick={() => onFrameForward?.()}
                >
                  <ArrowRight size={13} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  data-flow="frame.fork"
                  data-testid="frame-fork"
                  aria-label="Fork frame"
                  title="Fork frame"
                  onClick={() => onForkFrame?.()}
                >
                  <GitFork size={13} />
                </Button>
                {/* Open in sidebar exists only on the maximized card: a user's explicit act (THE EMBED LAW). */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="card-maximize-btn"
                  data-flow="tab.card"
                  data-testid={`card-open-in-tab-${card.id}`}
                  aria-label="Open in sidebar"
                  title="Open in sidebar"
                  onClick={() => onOpenInTab(card.id)}
                >
                  <PanelTop size={13} />
                </Button>
                {
                  /*
                   * Ask 8 (will, 2026-09-02): "when I maximize a file I have no
                   * way of minimizing it". The way back is NAMED — an icon
                   * alone was not read as an exit — and the header it sits in
                   * sticks to the top of the scrolling card (cards.css), so it
                   * is on screen however far the body scrolls. It is the same
                   * restore flow Escape and the backdrop run.
                   */
                }
                <Button
                  ref={minimizeRef}
                  variant="ghost"
                  size="sm"
                  className="card-minimize-btn"
                  data-flow="card.minimize"
                  data-testid={`card-minimize-${card.id}`}
                  aria-label="Restore"
                  title="Restore"
                  onClick={minimizeThenFocus}
                >
                  <Minimize2 size={13} />
                  Restore
                </Button>
              </>
            ) :
            (
              <Button
                ref={maximizeRef}
                variant="ghost"
                size="icon"
                className="card-maximize-btn"
                data-flow="card.maximize"
                data-testid={`card-maximize-${card.id}`}
                aria-label="Maximize card"
                title="Maximize card"
                onClick={maximizeThenFocus}
              >
                <Maximize2 size={13} />
              </Button>
            )}
        </header>
        <div className="smithers-card-body">
          {renderCardBody(card, {
            onDecideApproval,
            onGrantConfirm,
            onGrantCancel,
            onQueueApprove,
            onConnectGitHub,
            onConnectLocal,
            onRunWorkflow,
            onStopRun,
            onRetryRun,
            onChooseWorkflowRepo,
            worldDocuments,
            onChangeWorldDocument,
  onAttachWorldEditor,
            onRunCommand,
            debugVerbose,
            workflowCatalogs,
            signedOut
          })}
        </div>
      </section>
    </>
  )
})
