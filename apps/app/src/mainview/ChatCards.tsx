/*
 * The card shell: header (title and actionable status), the maximize and
 * frame controls, and the body from the kind's family renderer.
 *
 * Every card body lives in a family file under ./cards and registers itself in
 * cards/CardRenderers.tsx; this file never names a card kind except for narrow presentation adaptations in the shared shell.
 */
import { Button, StatusPill } from "@smthrs/ui"
import { ArrowLeft, ArrowRight, GitFork, Maximize2, Minimize2, PanelTop } from "lucide-react"
import { memo, useRef } from "react"
import type { CardActions } from "./cards/CardFamily"
import { pillStatus, renderCardBody } from "./cards/CardRenderers"
import { Component, type ErrorInfo, type ReactNode } from "react"

/*
 * One card's body failing to render stays inside that card: a lazy viewer
 * chunk that no longer loads (an old tab after a deploy, or the dev server
 * re-optimizing its dependencies) or a renderer that cannot read a payload.
 * Without this the error reaches the app's startup boundary and the whole
 * app reads "Smithers failed to start".
 */
export class CardBodyBoundary extends Component<{ readonly cardId: string; readonly onRunCommand: CardActions["onRunCommand"]; readonly children: ReactNode }, { readonly error: Error | null }> {
  override state: { readonly error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Card ${this.props.cardId} could not render`, error, info.componentStack)
  }
  override render() {
    const { error } = this.state
    if (error === null) return this.props.children
    const chunk = /dynamically imported module|Loading chunk|Importing a module script failed/i.test(error.message)
    return (
      <div className="world-card-empty" role="alert" data-card-error="">
        <p>{chunk ? "This card's viewer did not load; the app was updated. Reload the app to see it." : `This card could not be shown: ${error.message}`}</p>
        {chunk && <Button type="button" size="sm" variant="outline" data-flow="chat.reload"
          onClick={() => this.props.onRunCommand("chat.reload")}>Reload app</Button>}
      </div>
    )
  }
}
import type { Card } from "./state/AppState"
import { timeLabel as clockLabel } from "./Timestamps"
import { StatusDetails, statusPresentation } from "./StatusDetails"

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
  const title = card.kind === "repo-update" ? "Activity" :
    card.kind === "issue-list" ? "Issues" : card.kind === "issue" ? "Issue" :
    card.kind === "pr-list" ? "Pull requests" : card.kind === "pr" ? "Pull request" : card.title
  const fallback = pillStatus(card)
  const health = card.kind === "agent" || card.kind === "run-trace" ? card.payload.statusRollup : undefined
  const status = statusPresentation(health, fallback).status
  const quietStatus = ["done", "completed", "succeeded", "success"].includes(status)
  const hasLocalHistory = card.navigation !== undefined && card.navigation.length > 1
  const hasRunDetails = card.kind === "agent" || card.kind === "run-trace"
  const statusNode = card.kind === "agent" || card.kind === "run-trace" ?
    <StatusDetails status={health} fallback={fallback} /> :
    fallback === "" ? null : <StatusPill status={fallback} />
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
        onKeyDown={(event) => {
          if (!maximized || event.key !== "Escape" || event.defaultPrevented) return
          event.preventDefault()
          event.stopPropagation()
          minimizeThenFocus()
        }}
      >
        <header className="smithers-card-header">
          {hasLocalHistory && card.navigation && <nav className="card-local-history" aria-label="Frame history">
            <button type="button" data-flow="card.history.back" aria-label="Back in frame" disabled={card.navigation.index === 0}
              onClick={() => onRunCommand("card.history.back", card.id)}><ArrowLeft size={16} /></button>
            <button type="button" data-flow="card.history.forward" aria-label="Forward in frame" disabled={card.navigation.index + 1 === card.navigation.length}
              onClick={() => onRunCommand("card.history.forward", card.id)}><ArrowRight size={16} /></button>
          </nav>}
          <span className="smithers-card-title">{title}</span>
          {/* A family that has no status word for a card (a picker awaiting its human) renders no pill: "" is not a status. */}
          {!quietStatus && statusNode}
          {maximized ?
            (
              <>
                {!hasLocalHistory && (
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
                  </>
                )}
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
          <CardBodyBoundary cardId={card.id} onRunCommand={onRunCommand}>
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
          </CardBodyBoundary>
        </div>
        {hasRunDetails && <details className="smithers-card-details">
          <summary aria-label={`${title} details`}>Details</summary>
          <dl>
            {quietStatus && <><dt>Status</dt><dd>{statusNode}</dd></>}
            <dt>Created</dt><dd><time dateTime={new Date(card.createdAt).toISOString()}>{clockLabel(card.createdAt)}</time></dd>
          </dl>
        </details>}
      </section>
    </>
  )
})
