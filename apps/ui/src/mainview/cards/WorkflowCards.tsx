/*
 * The workflow cards: the embedded run card (run-trace) with its trace body
 * and steer row, the which-repository chooser (workflow-repo), and the
 * workspace's workflow listing (workflow-list). WorkflowRunCardBody and WorkflowListCardBody are
 * exported because the Flows pane and the runs tests mount them directly: one
 * list with two mounts, never a second implementation of the same listing.
 */
import { runSourceCommand } from "../flows/RunCommand"
import { Button, Markdown } from "@smthrs/ui"
import { useState } from "react"
import type { KeyboardEvent } from "react"
import type { Card } from "../state/AppState"
import { timeLabel as clockLabel } from "../Timestamps"
import type { CardFamily, RunCommand } from "./CardFamily"
import { defaultPill, settledPill } from "./CardFamily"
import { RunTraceBody } from "./RunTraceCard"
import { flowArgs } from "../flows/FlowArgs"

/*
 * Wave 11 — the embedded run card: live status from the relay event stream,
 * node progress in words, the result leading once the run settles. Stream
 * loss is routine and stated honestly ("reconnecting"), never a silent stall.
 */
const WORKFLOW_RUN_PHASE_WORDS: Readonly<Record<string, string>> = {
  launching: "Starting the run…",
  running: "Running on your workspace.",
  "waiting-approval": "Waiting for your approval below.",
  reconnecting: "Reconnecting to the workspace — the run continues; this card catches up on its own.",
  /* Wave 12 §3 — the bounded stance: honest, not silent, and not still polling. */
  quiet: "This run has gone quiet — no progress from your workspace for a long time, so I stopped checking.",
  stopped: "I stopped watching this run. It may still be running on your workspace.",
  completed: "Finished.",
  failed: "Failed.",
  cancelled: "Cancelled.",
  "no-capacity": "No workspace capacity right now."
}

export const WorkflowRunCardBody = ({
  card,
  onStopRun,
  onRetryRun,
  onRunCommand: sendRunCommand,
  debugVerbose = false
}: {
  readonly card: Extract<Card, { kind: "run-trace" }>
  readonly onStopRun: (cardId: string) => void
  readonly onRetryRun: (cardId: string) => void
  readonly onRunCommand: RunCommand
  readonly debugVerbose?: boolean
}) => {
  const onRunCommand = runSourceCommand(card.id, sendRunCommand)
  const { phase, steps, result, error, observationError, runId, kind } = card.payload
  const facet = card.payload.facet ?? "steps"
  return (
    <div className="flow-run-card" data-run-kind={kind}>
      {result !== null ? <Markdown className="smithers-card-markdown" content={result} /> : null}
      <p className="smithers-card-note">{WORKFLOW_RUN_PHASE_WORDS[phase] ?? phase}</p>
      {/* Lane runs: why a live run is not moving, in the control plane's word. */}
      {card.payload.waiting !== undefined ?
        (
          <p className="smithers-card-note" data-testid={`flow-run-waiting-${runId}`}>
            {card.payload.waiting === "executor"
              ? "Accepted — nothing is driving it yet. /runs.resume starts it."
              : `Waiting on ${card.payload.waiting}.`}
          </p>
        ) :
        null}
      {card.payload.steeringPending === true ?
        <p className="smithers-card-note">steering pending · delivered at the next turn</p> :
        null}
      {/* The run as a trace (spec 06): the card's body for every run kind. Its chips and rows dispatch runs.trace.*. */}
      <RunTraceBody card={card} onRunCommand={onRunCommand} />
      {/*
       * The secondary tabs (lane runs): the steps tail by default, the
       * transcript on demand (runs.logs), the raw journal only where verbose
       * is on (runs.events). Each tab is a registered flow, never local state.
       */}
      <div className="flow-run-actions" role="tablist" aria-label="Run views">
        <Button
          size="sm"
          variant={facet === "steps" ? "default" : "outline"}
          data-flow="runs.steps"
          data-testid={`flow-run-facet-steps-${runId}`}
          onClick={() => onRunCommand("runs.steps", runId)}
        >
          Steps
        </Button>
        <Button
          size="sm"
          variant={facet === "transcript" ? "default" : "outline"}
          data-flow="runs.logs"
          data-testid={`flow-run-facet-transcript-${runId}`}
          onClick={() => onRunCommand("runs.logs", runId)}
        >
          Transcript
        </Button>
        {debugVerbose ?
          (
            <Button
              size="sm"
              variant={facet === "events" ? "default" : "outline"}
              data-flow="runs.events"
              data-testid={`flow-run-facet-events-${runId}`}
              onClick={() => onRunCommand("runs.events", runId)}
            >
              Events
            </Button>
          ) :
          null}
      </div>
      {facet === "transcript" ?
        card.payload.transcriptRows === undefined || card.payload.transcriptRows.length === 0 ?
          <p className="smithers-card-note">The transcript is empty so far.</p> :
          (
            <ul className="flow-run-steps" data-testid={`flow-run-transcript-${runId}`}>
              {card.payload.transcriptRows.map((row) => (
                <li key={row.sequence}>
                  {row.turn !== undefined ? `turn ${row.turn} · ` : ""}{row.at !== undefined ? `${clockLabel(row.at)} · ` : ""}{row.kind !== undefined ? `${row.kind} · ` : ""}{row.text}
                </li>
              ))}
            </ul>
          ) :
        null}
      {facet === "events" && debugVerbose ?
        card.payload.events === undefined || card.payload.events.length === 0 ?
          <p className="smithers-card-note">No events recorded yet.</p> :
          (
            <ul className="flow-run-steps" data-testid={`flow-run-events-${runId}`}>
              {card.payload.events.map((event, index) => (
                <li key={index}>{JSON.stringify(event)}</li>
              ))}
            </ul>
          ) :
        null}
      {facet === "steps" && steps.length > 0 ?
        (
          <ul className="flow-run-steps">
            {steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}
          </ul>
        ) :
        null}
      {/* §3: the two acts a quiet run offers — both registered commands. */}
      {phase === "quiet" ?
        (
          <div className="flow-run-actions">
            <Button size="sm" data-flow="flow.run.retry" onClick={() => onRetryRun(card.id)}>
              Check again
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-flow="flow.run.stop"
              onClick={() => onStopRun(card.id)}
            >
              Stop watching
            </Button>
          </div>
        ) :
        null}
      {(phase === "completed" || phase === "failed" || phase === "cancelled" || phase === "no-capacity") && error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
      {observationError !== undefined ? <p className="sui-approval-error" role="alert">{observationError}</p> : null}
      {TERMINAL_RUN_PHASES.has(phase) && (error !== undefined || observationError !== undefined || card.payload.events?.some((event) => event.kind === "control.engine.projection-gap")) ? (
        <Button size="sm" data-flow="flow.run.retry" onClick={() => onRetryRun(card.id)}>
          Check again
        </Button>
      ) : null}
      {/*
       * Lane runs — the lifecycle acts. Stop is available on every
       * non-terminal phase (the flow confirms); Resume answers a wait the
       * control plane named (anything but an approval, which the approval
       * card below answers); Run again relaunches a settled run with the
       * same input and refuses honestly when this client never recorded one.
       */}
      {LIVE_RUN_PHASES.has(phase) ?
        (
          <div className="flow-run-actions">
            {card.payload.waiting !== undefined && card.payload.waiting !== "approval" ?
              (
                <Button
                  size="sm"
                  variant="outline"
                  data-flow="runs.resume"
                  data-testid={`flow-run-resume-${runId}`}
                  onClick={() => onRunCommand("runs.resume", runId)}
                >
                  Resume
                </Button>
              ) :
              null}
            <Button
              size="sm"
              variant="outline"
              data-flow="flow.run.stop"
              data-testid={`flow-run-stop-${runId}`}
              onClick={() => onStopRun(card.id)}
            >
              Stop
            </Button>
          </div>
        ) :
        null}
      {TERMINAL_RUN_PHASES.has(phase) ?
        (
          <div className="flow-run-actions">
            <Button
              size="sm"
              variant="outline"
              data-flow="runs.rerun"
              data-testid={`flow-run-rerun-${runId}`}
              onClick={() => onRunCommand("runs.rerun", runId)}
            >
              Run again
            </Button>
          </div>
        ) :
        null}
      {/* Spec 06 §3: a prototype is never steered; its header has no Steer, so its card has no steer row. */}
      {LIVE_RUN_PHASES.has(phase) && kind !== "prototype" ? <RunSteerRow runId={runId} onRunCommand={onRunCommand} /> : null}
    </div>
  )
}

/** The phases a run can still be steered, resumed, or stopped in. */
const LIVE_RUN_PHASES: ReadonlySet<string> = new Set(["launching", "running", "waiting-approval", "reconnecting"])
/** The phases a Run again answers. */
// "stopped" is the phase a REFUSED cancel leaves (workflow-pump stopWatchingRun): the run may still be live, so it is not terminal.
const TERMINAL_RUN_PHASES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "no-capacity"])

/** The thinking levels a steer may name — the wire's own vocabulary (@smthrs/notifications). */
const THINKING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const

/*
 * Lane runs §5 — the steer row: an operator message into the next turn, and
 * the mono strip of the other three steer kinds. Every submit is the flow
 * (runs.steer / runs.seat / runs.thinking / runs.tools); the text under the
 * pointer is presentation state, cleared the moment its flow takes it.
 */
const RunSteerRow = ({
  runId,
  onRunCommand
}: {
  readonly runId: string
  readonly onRunCommand: RunCommand
}) => {
  const [message, setMessage] = useState("")
  const [seat, setSeat] = useState("")
  const [tools, setTools] = useState("")
  const sendMessage = (): void => {
    const body = message.trim()
    if (body === "") return
    onRunCommand("runs.steer", flowArgs("runs.steer", { runId, body }))
    setMessage("")
  }
  const sendSeat = (): void => {
    const value = seat.trim()
    if (value === "") return
    onRunCommand("runs.seat", `${runId} ${value}`)
    setSeat("")
  }
  const sendTools = (): void => {
    const value = tools.trim()
    if (value === "") return
    onRunCommand("runs.tools", `${runId} ${value}`)
    setTools("")
  }
  const onEnter = (submit: () => void) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      submit()
    }
  }
  return (
    <div className="flow-run-steer" data-testid={`flow-run-steer-${runId}`}>
      <div className="flow-run-actions">
        <input
          className="flow-run-steer-input"
          aria-label="Steer this run"
          placeholder="Steer this run — a message for the next turn"
          value={message}
          data-testid={`flow-run-steer-input-${runId}`}
          onInput={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={onEnter(sendMessage)}
        />
        <Button
          size="sm"
          variant="outline"
          data-flow="runs.steer"
          disabled={message.trim() === ""}
          onClick={() => {
            if (message.trim() === "") return
            onRunCommand("runs.steer", flowArgs("runs.steer", { runId, body: message.trim() }))
            setMessage("")
          }}
        >
          Steer
        </Button>
      </div>
      <div className="flow-run-actions flow-run-steer-strip">
        <input
          className="flow-run-steer-input flow-run-steer-small"
          aria-label="Move the run to a seat"
          placeholder="seat — provider:model"
          value={seat}
          onInput={(event) => setSeat(event.currentTarget.value)}
          onKeyDown={onEnter(sendSeat)}
        />
        <select
          className="flow-run-steer-select"
          aria-label="Change the thinking level"
          data-testid={`flow-run-thinking-${runId}`}
          value=""
          onChange={(event) => {
            const level = event.currentTarget.value
            if (level !== "") onRunCommand("runs.thinking", `${runId} ${level}`)
          }}
        >
          <option value="" disabled>
            thinking ▾
          </option>
          {THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        <input
          className="flow-run-steer-input flow-run-steer-small"
          aria-label="Add tools to the run"
          placeholder="tools — comma-separated"
          value={tools}
          onInput={(event) => setTools(event.currentTarget.value)}
          onKeyDown={onEnter(sendTools)}
        />
      </div>
    </div>
  )
}

/*
 * Wave 12 §2 — which loaded repository. Embedded, keyboard-complete (arrows
 * move, Enter chooses), and one act: choosing IS the confirm, so the create
 * resumes immediately on the repo the human named.
 */
const WorkflowRepoCardBody = ({
  card,
  onChooseWorkflowRepo
}: {
  readonly card: Extract<Card, { kind: "workflow-repo" }>
  readonly onChooseWorkflowRepo: (fullName: string) => void
}) => {
  const { repos, chosen, description } = card.payload
  const [highlighted, setHighlighted] = useState(0)
  const index = Math.min(highlighted, Math.max(repos.length - 1, 0))
  if (chosen !== null) {
    return <p className="smithers-card-note">Creating it on {chosen}.</p>
  }
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (repos.length === 0) return
      setHighlighted(
        event.key === "ArrowDown" ? (index + 1) % repos.length : (index + repos.length - 1) % repos.length
      )
      return
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      const repo = repos[index]
      if (repo !== undefined) onChooseWorkflowRepo(repo)
    }
  }
  return (
    <div className="workflow-repo-chooser">
      <p className="smithers-card-note">{description}</p>
      <ul
        className="workflow-repo-list"
        role="listbox"
        aria-label="Your loaded repositories"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {repos.map((repo, position) => (
          <li key={repo}>
            <button
              type="button"
              role="option"
              aria-selected={position === index}
              data-highlighted={position === index}
              className="workflow-repo-row"
              data-flow="flow.repo.choose"
              onMouseEnter={() => setHighlighted(position)}
              onClick={() => onChooseWorkflowRepo(repo)}
            >
              {repo}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}


/*
 * The workspace's workflows (flow.list) — each row's Run is a command binding.
 * Exported because the Flows pane (ask 5, App.tsx) renders THESE rows: one
 * list with two mounts, never a second implementation of the same listing.
 */
export const WorkflowListCardBody = ({
  card,
  onRunWorkflow
}: {
  readonly card: Extract<Card, { kind: "workflow-list" }>
  readonly onRunWorkflow: (name: string) => void
}) => {
  const { workflows } = card.payload
  if (workflows.length === 0) {
    return <p className="smithers-card-note">No flows on this workspace yet. Ask for one and I'll create it.</p>
  }
  return (
    <ul className="workflow-list">
      {workflows.map((workflow) => (
        <li key={workflow.key} className="workflow-list-row">
          <span className="workflow-list-text">
            <strong>{workflow.key}</strong>
            {workflow.description !== null ? <span>{workflow.description}</span> : null}
          </span>
          <Button
            size="sm"
            variant="outline"
            data-flow="flow.run"
            onClick={() => onRunWorkflow(workflow.key)}
          >
            Run
          </Button>
        </li>
      ))}
    </ul>
  )
}

export const workflowCardFamily: CardFamily<"run-trace" | "workflow-repo" | "workflow-list"> = {
  "run-trace": {
    render: (card, actions) => (
      <WorkflowRunCardBody
        card={card}
        onStopRun={actions.onStopRun}
        onRetryRun={actions.onRetryRun}
        onRunCommand={actions.onRunCommand}
        debugVerbose={actions.debugVerbose}
      />
    ),
    pill: (card) => {
      if (card.payload.phase === "completed") return "done"
      if (
        card.payload.phase === "failed" || card.payload.phase === "cancelled" || card.payload.phase === "no-capacity"
      ) {
        return "failed"
      }
      if (card.payload.phase === "waiting-approval") return "waiting-approval"
      /*
       * Wave 12 §3: a card whose body says the run has gone quiet, or that
       * nobody is watching it any more, may not wear a Running pill. The pill
       * is the most glanceable claim on the card, and "Running" is precisely
       * the thing neither of these states can vouch for — they read Quiet and
       * Stopped, muted, through the shared status vocabulary.
       */
      if (card.payload.phase === "quiet" || card.payload.phase === "stopped") return card.payload.phase
      return "running"
    }
  },
  "workflow-repo": {
    render: (card, actions) => <WorkflowRepoCardBody card={card} onChooseWorkflowRepo={actions.onChooseWorkflowRepo} />,
    pill: defaultPill
  },
  "workflow-list": {
    render: (card, actions) => <WorkflowListCardBody card={card} onRunWorkflow={actions.onRunWorkflow} />,
    pill: settledPill
  }
}
