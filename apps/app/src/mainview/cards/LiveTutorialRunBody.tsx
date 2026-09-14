import { GuideButton } from "../onboarding/GuideButton"
import { runSourceCommand } from "../flows/RunCommand"
import { liveTutorialTranscript } from "../state/LiveTutorialTranscript"
import { flowArgs } from "../flows/FlowArgs"
import { Button, Markdown } from "@smthrs/ui"
import { LiveTutorialRunSchema } from "@smthrs/rpc/LiveTutorial"
import type { Card } from "../state/AppState"
import type { RunCommand } from "./CardFamily"

/** The official run card's live tutorial projection. Every row comes from observed execution. */
export function LiveTutorialRunBody({ card, onRunCommand }: { card: Extract<Card, {kind:"run-trace"}>; onRunCommand: RunCommand }) {
  const decoded = LiveTutorialRunSchema.safeParse(card.payload.input?.liveTutorialSnapshot)
  const run = decoded.success ? decoded.data : undefined
  const reproducesBug = run?.operation === "research" && run.events.some(event => event.id === "reproduce" && event.status === "completed")
  const plan = run?.operation === "plan" ? run.plan : undefined
  const busy = card.payload.phase === "launching" || card.payload.phase === "running"
  const failure = card.payload.observationError ?? run?.error
  const expired = failure?.toLowerCase().includes("expired") === true
  const facet=card.payload.facet??"steps"
  const scoped=runSourceCommand(card.id,onRunCommand)
  const views=<div className="flow-run-tabs" role="tablist" aria-label="Run views">
    <Button size="sm" variant={facet === "steps" ? "default" : "outline"} type="button" role="tab" aria-selected={facet==="steps"} data-flow="runs.steps" onClick={()=>scoped("runs.steps",card.payload.runId)}>Trace</Button>
    <Button size="sm" variant={facet === "transcript" ? "default" : "outline"} type="button" role="tab" aria-selected={facet==="transcript"} data-flow="runs.logs" onClick={()=>scoped("runs.logs",card.payload.runId)}>Transcript</Button>
  </div>
  if(facet==="transcript"){
    const rows=card.payload.follow&&run?liveTutorialTranscript(run):card.payload.transcriptRows??[]
    return <div className="live-tutorial-run">{views}{rows.length===0?<p>No observed steps yet.</p>:<ol className="flow-run-transcript" aria-label="Transcript">{rows.map(row=><li key={row.sequence}><span className="flow-run-transcript-meta">{row.kind}</span><pre className="flow-run-transcript-text">{row.text}</pre></li>)}</ol>}</div>
  }
  return <div className="live-tutorial-run" aria-busy={busy}>
    {views}
    {busy && <p className="live-tutorial-progress" role="status">{run?.events.slice().reverse().find(event => event.status === "running")?.label ?? "Starting the live workspace…"}</p>}
    {plan && <section className="live-tutorial-plan" aria-label="Implementation plan">
      <p>{plan.summary}</p>
      <ol>{plan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
      {plan.files.length > 0 && <p className="live-tutorial-files">{plan.files.map(path => <code key={path}>{path}</code>)}</p>}
      {card.status === "acted" ? <p className="live-tutorial-outcome">Implementation started</p> : <GuideButton className="guide-primary" data-flow="agent.change.start"
        onClick={() => onRunCommand("agent.change.start", card.id)}>Start implementation</GuideButton>}
    </section>}
    {!plan && run?.result && <div className="live-tutorial-result"><Markdown content={run.result} /></div>}
    {run?.tests && <p className="live-tutorial-check" data-passed={run.tests.exitCode === 0}>{run.tests.exitCode === 0 ? "✓ Tests passed" : reproducesBug ? "Tests failed (expected: reproduces the bug)" : "Tests failed"} <code>{run.tests.command}</code></p>}
    {run?.tests && <details className="live-tutorial-test-output"><summary>Test output</summary><pre tabIndex={0}>{run.tests.output}</pre></details>}
    {run?.commits && run.operation === "implement" && <p className="live-tutorial-outcome">{run.commits.length} {run.commits.length === 1 ? "commit" : "commits"} on <code>{run.branch}</code></p>}
    {(run?.events.length ?? 0) > 0 && <ol className="live-tutorial-events" aria-label="Run trace">
      {run!.events.map(event => {
        const selected = card.payload.selection === event.id
        const duration = event.finishedAt === undefined ? undefined : Math.max(0, event.finishedAt - event.startedAt) / 1000
        return <li key={event.id} data-status={event.status}>
          <button type="button" data-flow="tutorial.live.inspect" aria-expanded={selected}
            onClick={() => onRunCommand("tutorial.live.inspect", flowArgs("tutorial.live.inspect", { cardId: card.id, eventId: event.id }))}>
            <span className="live-event-mark" aria-label={event.status}>{event.status === "completed" ? "✓" : event.status === "failed" ? "!" : "·"}</span>
            <span>{event.label}</span><time>{duration === undefined ? "Running" : `${duration.toFixed(1)}s`}</time>
          </button>
          {selected && <pre tabIndex={0}>{event.detail ?? "No additional output for this step."}</pre>}
        </li>
      })}
    </ol>}
    {failure && <p className="live-tutorial-error" role="alert">{failure}</p>}
    {expired && <button type="button" className="guide-text-button" data-flow="onboarding.act" onClick={() => onRunCommand("onboarding.act", "restart")}>Start new tutorial</button>}
    {!expired && (failure || run?.phase === "failed") && <button type="button" className="guide-text-button" data-flow="tutorial.live.retry"
      onClick={() => onRunCommand("tutorial.live.retry", card.id)}>{run?.phase === "failed" ? "Retry" : "Reconnect"}</button>}
    {run?.operation === "implement" && run.phase === "completed" && !failure && <button type="button" className="guide-primary" data-flow="files.implementation-diff"
      onClick={() => onRunCommand("files.implementation-diff")}>View diff</button>}
  </div>
}
