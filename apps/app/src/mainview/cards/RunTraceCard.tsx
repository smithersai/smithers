import { flowAction } from "../flows/FlowAction"
/*
 * The embedded run card's body: what the run did, in the order a reader
 * needs it.
 *
 *   1. The outcome: one line, the run's phase in words plus the recorded
 *      facts (turns, calls, wall time), then the run's result text.
 *   2. The plan it executed, folded away (CodingPlanCard.tsx): planned work is
 *      not executed work, so a run card never repeats its plan open.
 *   3. Progress: the run's own step words, open while it moves, folded once
 *      it settled.
 *   4. The turns: one row per recorded turn, the model's first sentence and
 *      the flows it called. A row expands in place into that turn's recorded
 *      detail (its script, its calls, the selected span's journal facts).
 *      The timeline view is the same journal as a call tree and waterfall.
 *
 * The model is RunTrace.ts's fold over the run card's `events` (the
 * `run-events` projection the pump keeps current while the run is live). A
 * run with no journal yet is the root alone with the run's status. A run of
 * kind prototype wears the never-promoted banner and the narrower filter set
 * (§3); nothing else differs here.
 *
 * Every view fact lives in the card payload: `traceView`, `filter`,
 * `selection`, `cursorSeq` and `liveTail`. Buttons and agent/slash requests
 * enter the same runs.trace.* flows with their actor recorded. This component
 * holds no state of its own. A call that failed is a fact about that call:
 * the outcome line reads the run's phase, never a child span's status.
 */
import { runSourceCommand } from "../flows/RunCommand"
import { Button, Markdown, StatusPill } from "@smthrs/ui"
import { CodingPlanBody } from "./CodingPlanCard"
import { CodingPocBody } from "./CodingPocCard"
import { CodingVibeBody } from "./CodingVibeCard"
import type { Card } from "../state/AppState"
import { timeLabel } from "../Timestamps"
import type { RunCommand } from "./CardFamily"
import {
  durationWords,
  spanMatches,
  spanPath,
  type TraceFilter,
  traceFiltersFor,
  traceFromJournal,
  type TraceModel,
  type TraceSpan,
  turnNarratives,
  waterfallGeometry
} from "./RunTrace"

/** The banner every prototype run wears (spec 06 §3, mock #s6). */
export const PROTOTYPE_BANNER = "Prototypes are evidence for /implement, then reaped. No review, no gates, no landing."

/*
 * Wave 11 — the run's phase in words: live status from the relay event
 * stream, the result leading once the run settles. Stream loss is routine and
 * stated honestly ("reconnecting"), never a silent stall.
 */
export const WORKFLOW_RUN_PHASE_WORDS: Readonly<Record<string, string>> = {
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

/** The phases a run has settled in. */
export const TERMINAL_RUN_PHASES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "no-capacity"])

type RunTraceCard = Extract<Card, { kind: "run-trace" }>

const durationOf = (span: TraceSpan, model: TraceModel): string | undefined => {
  const end = span.endedAt ?? (span.status === "running" || span.status === "waiting" ? model.extent.end : undefined)
  if (end === undefined) return undefined
  return durationWords(Math.max(end - span.startedAt, 0))
}

const json = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

const sequenceOf = (record: Record<string, unknown>): number =>
  typeof record.sequence === "number" ? record.sequence : 0

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * The trace the card shows: the whole journal, or the journal up to the scrub
 * cursor (§2, the scrubber lands on a record and every region re-renders at
 * that seq from the fold the client already holds). At a cursor before the
 * journal's end the run had not settled, so the root wears `running` unless a
 * `control.run.*` record within the cursor says otherwise.
 *
 * @param card the run card
 */
export const traceOf = (card: RunTraceCard): TraceModel => {
  const { runId, workflow, phase, kind, events, cursorSeq } = card.payload
  const journal = events ?? []
  const latest = journal.reduce((max, record) => Math.max(max, sequenceOf(record)), 0)
  const scrubbed = cursorSeq !== undefined && cursorSeq < latest
  const records = scrubbed ? journal.filter((record) => sequenceOf(record) <= cursorSeq) : journal
  return traceFromJournal(
    { runId, flowId: workflow, status: scrubbed ? "running" : phase, ...(kind === undefined ? {} : { kind }) },
    records
  )
}

/**
 * The selected node: the payload's selection when it names a row still in the
 * fold, else the newest frame while live tail holds (§2: live tail follows the
 * newest frame), else the run itself.
 *
 * @param card the run card
 * @param model its trace
 */
export const selectedSpan = (card: RunTraceCard, model: TraceModel): TraceSpan => {
  const { selection, liveTail } = card.payload
  const named = selection === undefined ? undefined : model.rows.find((span) => span.id === selection)
  if (named !== undefined) return named
  if (liveTail !== false) {
    const frames = model.rows.filter((span) => span.kind === "frame")
    const newest = frames.at(-1)
    if (newest !== undefined) return newest
  }
  return model.root
}

/** The calls a turn made, in order, each once: the row's summary of what the agent did. */
const callsOf = (frame: TraceSpan): ReadonlyArray<TraceSpan> => {
  const calls: Array<TraceSpan> = []
  const walk = (span: TraceSpan): void => {
    if (span.kind === "call") calls.push(span)
    for (const child of span.children) walk(child)
  }
  walk(frame)
  return calls
}

export const RunTraceBody = ({
  card,
  onRunCommand: sendRunCommand,
  workflowCatalogs
}: {
  readonly card: RunTraceCard
  readonly workflowCatalogs?: ReadonlyArray<Extract<Card, { kind: "workflow-list" }>>
  readonly onRunCommand: RunCommand
}) => {
  const onRunCommand = runSourceCommand(card.id, sendRunCommand)
  const { runId, phase, kind, steps, result } = card.payload
  /* A tutorial plan card is a plan, not a run: it has no outcome, no progress and no journal to show. */
  const planOnly = kind === "change-plan"
  const repositorySetup = card.payload.workflow === "repository/setup"
  const model = traceOf(card)
  const view = card.payload.traceView ?? "turns"
  const filters = traceFiltersFor(kind)
  const filter: TraceFilter = filters.some(([id]) => id === card.payload.filter) ? card.payload.filter ?? "all" : "all"
  const selected = selectedSpan(card, model)
  const path = spanPath(model, selected.id)
  const frame = path.find((span) => span.kind === "frame" || span.kind === "execution")
  const frameIndex = frame === undefined ? -1 : model.rows.findIndex((span) => span.id === frame.id)
  const scopeEnd = frame === undefined
    ? -1
    : model.rows.findIndex((span, index) => index > frameIndex && span.depth <= frame.depth)
  const scope = frameIndex < 0 ? model.rows : model.rows.slice(frameIndex, scopeEnd < 0 ? undefined : scopeEnd)
  const rows = (view === "timeline" ? model.rows : scope).filter((span) =>
    span.kind === "run" || spanMatches(span, filter)
  )
  const turns = turnNarratives(model)
  const native = model.root.children.filter((span) =>
    span.kind === "execution" || span.id.startsWith("engine-gap:") || span.id.startsWith("engine-invalid:")
  )
  // Following a run is cheap. The debugger appears only after an explicit selection or timeline request.
  const inspecting = view === "timeline" || card.payload.selection !== undefined
  const wall = model.extent.end - model.extent.start
  const calls = model.rows.filter((span) => span.kind === "call").length
  const settled = TERMINAL_RUN_PHASES.has(phase)
  const facts = [
    turns.length > 0 ? count(turns.length, "turn") : undefined,
    calls > 0 ? count(calls, "call") : undefined,
    model.counts.spans > 0 ? durationWords(wall) : undefined
  ].filter((fact) => fact !== undefined)
  const scrub = card.payload.liveTail === false ? (
    <span className="run-trace-scrub">
      {card.payload.cursorSeq !== undefined ? <span className="run-trace-cursor">At #{card.payload.cursorSeq}</span> : null}
      <button type="button" className="run-trace-filter"  {...flowAction(onRunCommand, "runs.trace.live", runId)}>
        Latest
      </button>
    </span>
  ) : null
  const detail = (
    <TurnDetail card={card} model={model} selected={selected} path={path} scope={scope} rows={rows} frame={frame} onRunCommand={onRunCommand} />
  )
  return (
    <div className="run-trace" data-testid={`run-trace-${runId}`} data-kind={kind} data-view={planOnly ? "plan" : view}>
      <Button size="sm" variant="outline" 
        {...flowAction(onRunCommand, "runs.handoff", runId)}>Prepare handoff</Button>
      {kind === "prototype" ?
        (
          <p className="run-trace-banner" data-testid={`run-trace-banner-${runId}`}>
            <span className="run-trace-kind">kind: prototype · never promoted</span> {PROTOTYPE_BANNER}
          </p>
        ) :
        null}
      {planOnly ? null : (
        <header className="run-outcome" data-phase={phase} data-testid={`run-outcome-${runId}`}>
          <span className="run-outcome-dot" data-status={phase} aria-hidden />
          <span className="run-outcome-words">{WORKFLOW_RUN_PHASE_WORDS[phase] ?? phase}</span>
          {facts.length > 0 ? <span className="run-outcome-facts">{facts.join(" · ")}</span> : null}
        </header>
      )}
      {!planOnly && result !== null ? repositorySetup ? (
        <details className="run-progress-fold">
          <summary>Technical details</summary>
          <pre className="run-trace-code" tabIndex={0} aria-label="Run output">{result}</pre>
        </details>
      ) : <Markdown className="smithers-card-markdown run-result" content={result} /> : null}
      <CodingPlanBody card={card} onRunCommand={onRunCommand} workflowCatalogs={workflowCatalogs} />
      <CodingPocBody card={card} onRunCommand={onRunCommand} />
      <CodingVibeBody card={card} onRunCommand={onRunCommand} />
      {/* The run's progress words (payload.steps, a short tail the pump and replays write), newest last. */}
      {planOnly || steps.length === 0 ? null : settled ? (
        <details className="run-progress-fold">
          <summary><span className="run-fold-title">Progress</span><span className="run-fold-meta">{count(steps.length, "update")}</span></summary>
          <ol className="run-progress" aria-label="Progress" data-run-steps="">
            {steps.map((step, index) => <li key={`${index}:${step}`}>{step}</li>)}
          </ol>
        </details>
      ) : (
        <ol className="run-progress" aria-label="Progress" data-run-steps="">
          {steps.map((step, index) => <li key={`${index}:${step}`}>{step}</li>)}
        </ol>
      )}
      {planOnly ? null : view === "turns" ? (
        <>
          {turns.length > 0 || native.length > 0 || scrub !== null ? (
            <div className="run-trace-bar" data-view="turns" role="group" aria-label="Trace presentation">
              <span className="run-trace-bar-title">Turns</span>
              {scrub}
              <button
                type="button"
                className="run-trace-filter run-trace-view"
                aria-pressed={false}
                {...flowAction(onRunCommand, "runs.trace.view", `${runId} timeline`)}
              >
                Timeline
              </button>
            </div>
          ) : null}
          {turns.length > 0 ? (
            <ol className="run-turns" aria-label="Turn explanations">
              {turns.map((turn) => {
                const open = inspecting && frame?.id === turn.frame.id
                const detailId = `${card.id}-turn-${turn.number}`
                const made = callsOf(turn.frame)
                return (
                  <li key={turn.frame.id} data-turn-open={open}>
                    <button
                      type="button"
                      className="run-turn"
                      data-turn={turn.number}
                      aria-pressed={open}
                      aria-expanded={open}
                      aria-controls={open ? detailId : undefined}
                      title={turn.source === "model" ? "Recorded model text" : "Recorded journal activity"}
                      {...flowAction(onRunCommand, "runs.trace.select", `${runId} ${turn.frame.id}`)}
                    >
                      <span className="run-turn-number">{turn.number}</span>
                      <span className="run-turn-body">
                        <span className="run-turn-text">{turn.text}</span>
                        {made.length > 0 ? (
                          <span className="run-turn-calls" aria-label="Flows called">
                            {made.map((call) => (
                              <span key={call.id} className="run-turn-call" data-status={call.status}>{call.label}</span>
                            ))}
                          </span>
                        ) : null}
                      </span>
                      <span className="run-trace-duration">{durationOf(turn.frame, model) ?? ""}</span>
                    </button>
                    {open ? <div id={detailId} className="run-turn-detail">{detail}</div> : null}
                  </li>
                )
              })}
            </ol>
          ) : null}
          {native.length > 0 ? (
            <ol className="run-turns run-engine" aria-label="Recorded engine work">
              {native.map((span) => {
                const open = inspecting && frame?.id === span.id
                const detailId = `${card.id}-engine-${span.id}`
                return (
                  <li key={span.id} data-turn-open={open}>
                    <button
                      type="button"
                      className="run-turn"
                      data-engine-span={span.id}
                      aria-pressed={open}
                      aria-expanded={open}
                      aria-controls={open ? detailId : undefined}
                      {...flowAction(onRunCommand, "runs.trace.select", `${runId} ${span.id}`)}
                    >
                      <span className="run-turn-number"><span className="run-trace-dot" data-status={span.status} aria-hidden /></span>
                      <span className="run-turn-body">
                        <span className="run-turn-text">{span.label} · {span.status}</span>
                      </span>
                      <span className="run-trace-duration">{durationOf(span, model) ?? ""}</span>
                    </button>
                    {open ? <div id={detailId} className="run-turn-detail">{detail}</div> : null}
                  </li>
                )
              })}
            </ol>
          ) : null}
          {model.counts.spans === 0 && !inspecting && !repositorySetup ? (
            <p className="run-trace-empty" data-testid={`run-trace-empty-${runId}`}>
              {settled ? "No turns were recorded." : "No turns yet."}
            </p>
          ) : null}
          {/* A selection outside any turn (the run itself, or an engine span with no row) still gets its detail. */}
          {inspecting && frame === undefined ? <div className="run-turn-detail run-turn-detail-root">{detail}</div> : null}
        </>
      ) : (
        <>
          <div className="run-trace-bar" data-view="timeline" role="group" aria-label="Trace filters">
            <button
              type="button"
              className="run-trace-filter run-trace-view"
              aria-pressed={false}
              {...flowAction(onRunCommand, "runs.trace.view", `${runId} turns`)}
            >
              Turns
            </button>
            <span className="run-trace-bar-title">Timeline</span>
            {filters.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="run-trace-filter"
                data-filter={id}
                data-on={filter === id}
                aria-pressed={filter === id}
                {...flowAction(onRunCommand, "runs.trace.filter", `${runId} ${id}`)}
              >
                {label}
              </button>
            ))}
            <span className="run-trace-clock" data-testid={`run-trace-clock-${runId}`}>
              {model.counts.spans === 0
                ? "no journal yet"
                : `${count(model.counts.spans, "span")}${
                  model.counts.running > 0 ? ` · ${model.counts.running} running` : ""
                }${model.counts.failed > 0 ? ` · ${model.counts.failed} failed` : ""} · t = ${durationWords(wall)}`}
            </span>
            {scrub}
          </div>
          <nav className="run-trace-path" aria-label="Recorded call path">
            <PathCrumbs path={path} selected={selected} runId={runId} onRunCommand={onRunCommand} />
          </nav>
          <div className="run-trace-body">
            <CallTree rows={rows} selected={selected} model={model} runId={runId} onRunCommand={onRunCommand} />
            <div className="run-trace-detail">
              {model.counts.spans === 0 ?
                (
                  <p className="run-trace-empty" data-testid={`run-trace-empty-${runId}`}>
                    {settled ? "No spans were recorded." : "No spans yet."}
                  </p>
                ) :
                (
                  <ol className="run-trace-waterfall" aria-label="Waterfall">
                    {rows.filter((span) => span.kind !== "run").map((span) => {
                      const bar = waterfallGeometry(span, model.extent)
                      const instant = span.endedAt !== undefined && span.endedAt <= span.startedAt
                      const summary = `${span.label} · ${span.status}${
                        durationOf(span, model) === undefined ? "" : ` · ${durationOf(span, model)}`
                      }`
                      return (
                        <li
                          key={span.id}
                          className="run-trace-water-row"
                          data-trace-bar={span.id}
                          data-status={span.status}
                        >
                          <span className="run-trace-water-label">{span.label}</span>
                          <span className="run-trace-track">
                            <button
                              type="button"
                              className="run-trace-water-bar"
                              data-instant={instant}
                              data-open={span.endedAt === undefined}
                              aria-label={summary}
                              aria-pressed={selected.id === span.id}
                              title={summary}
                              style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                              {...flowAction(onRunCommand, "runs.trace.select", `${runId} ${span.id}`)}
                            />
                          </span>
                        </li>
                      )
                    })}
                  </ol>
                )}
              {frame !== undefined ? <TurnSource scope={scope} /> : null}
              <SpanPane span={selected} model={model} runId={runId} />
              <ChildRunDoor span={selected} repo={card.payload.repo} onRunCommand={onRunCommand} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** The recorded ancestry of the selection, each a door back up. */
const PathCrumbs = ({ path, selected, runId, onRunCommand }: {
  readonly path: ReadonlyArray<TraceSpan>
  readonly selected: TraceSpan
  readonly runId: string
  readonly onRunCommand: RunCommand
}) => (
  <>
    {path.map((ancestor, index) => (
      <span key={ancestor.id}>
        {index > 0 ? <span aria-hidden>{" / "}</span> : null}
        <button
          type="button"
          aria-current={ancestor.id === selected.id ? "location" : undefined}
          {...flowAction(onRunCommand, "runs.trace.select", `${runId} ${ancestor.id}`)}
        >
          {ancestor.label}
        </button>
      </span>
    ))}
  </>
)

/** The spans in scope as rows: a row is a button that selects its span. */
const CallTree = ({ rows, selected, model, runId, onRunCommand }: {
  readonly rows: ReadonlyArray<TraceSpan>
  readonly selected: TraceSpan
  readonly model: TraceModel
  readonly runId: string
  readonly onRunCommand: RunCommand
}) => (
  <ol className="run-trace-tree" aria-label="Call tree">
    {rows.map((span) => (
      <li key={span.id}>
        <button
          type="button"
          className="run-trace-node"
          data-trace-span={span.id}
          data-kind={span.kind}
          data-status={span.status}
          data-depth={span.depth}
          aria-pressed={selected.id === span.id}
          style={{ paddingLeft: `${0.5 + span.depth * 0.875}rem` }}
          {...flowAction(onRunCommand, "runs.trace.select", `${runId} ${span.id}`)}
        >
          <span className="run-trace-dot" data-status={span.status} aria-hidden />
          <span className="run-trace-label">{span.label}</span>
          {/* The dot already says completed; only another status earns its word. */}
          <span className="run-trace-status">{span.status === "completed" ? "" : span.status}</span>
          <span className="run-trace-duration">{durationOf(span, model) ?? ""}</span>
        </button>
      </li>
    ))}
  </ol>
)

/** The script the turn ran, as the journal recorded it. */
const TurnSource = ({ scope }: { readonly scope: ReadonlyArray<TraceSpan> }) => {
  const cells = scope.filter((span) => span.detail.source !== undefined)
  return (
    <section className="run-turn-source" aria-label="Recorded turn source">
      {cells.length > 0
        ? cells.map((span) => <Block key={span.id} title="Script" text={span.detail.source!} />)
        : <p className="run-trace-empty">No script source was recorded for this turn.</p>}
    </section>
  )
}

/** A detached child run, only once the journal recorded its id. */
const ChildRunDoor = ({ span, repo, onRunCommand }: { readonly span: TraceSpan; readonly repo: string; readonly onRunCommand: RunCommand }) =>
  span.detail.childRunId !== undefined && span.detail.childRunId !== "" && !/\s/.test(span.detail.childRunId) ?
    (
      <button
        type="button"
        className="run-trace-filter"
        {...flowAction(onRunCommand, "runs.open", `${span.detail.childRunId} ${repo}`)}
      >
        Inspect child run
      </button>
    ) :
    null

/**
 * One turn, expanded in place: where the selection sits, the turn's script,
 * its calls as a tree, and the selected span's recorded facts. The same
 * pieces the timeline shows, scoped to the turn the reader opened.
 */
const TurnDetail = ({ card, model, selected, path, scope, rows, frame, onRunCommand }: {
  readonly card: RunTraceCard
  readonly model: TraceModel
  readonly selected: TraceSpan
  readonly path: ReadonlyArray<TraceSpan>
  readonly scope: ReadonlyArray<TraceSpan>
  readonly rows: ReadonlyArray<TraceSpan>
  readonly frame: TraceSpan | undefined
  readonly onRunCommand: RunCommand
}) => {
  const { runId } = card.payload
  return (
    <>
      <nav className="run-trace-path" aria-label="Recorded call path">
        <PathCrumbs path={path} selected={selected} runId={runId} onRunCommand={onRunCommand} />
      </nav>
      {frame !== undefined && frame.kind === "frame" ? <TurnSource scope={scope} /> : null}
      <CallTree rows={rows} selected={selected} model={model} runId={runId} onRunCommand={onRunCommand} />
      <SpanPane span={selected} model={model} runId={runId} />
      <ChildRunDoor span={selected} repo={card.payload.repo} onRunCommand={onRunCommand} />
    </>
  )
}

/** The selected span's facts, and nothing the journal did not record. */
const SpanPane = (
  { span, model, runId }: { readonly span: TraceSpan; readonly model: TraceModel; readonly runId: string }
) => {
  const { detail } = span
  const duration = durationOf(span, model)
  return (
    <div className="run-trace-pane" data-testid={`run-trace-pane-${runId}`} data-span={span.id}>
      <h5 className="run-trace-pane-title">
        <span className="run-trace-pane-kind">{span.kind}</span> · {span.label} <StatusPill status={span.status} />
      </h5>
      <dl className="run-trace-kv">
        {span.startedAt > 0 ?
          (
            <>
              <dt>started</dt>
              <dd>{timeLabel(span.startedAt)}</dd>
            </>
          ) :
          null}
        {duration !== undefined ?
          (
            <>
              <dt>duration</dt>
              <dd>{duration}{span.endedAt === undefined ? " · open" : ""}</dd>
            </>
          ) :
          null}
        {detail.seat !== undefined ?
          (
            <>
              <dt>seat</dt>
              <dd>{detail.seat}</dd>
            </>
          ) :
          null}
        {detail.usage !== undefined &&
            (detail.usage.inputTokens !== undefined || detail.usage.outputTokens !== undefined) ?
          (
            <>
              <dt>tokens</dt>
              <dd>{detail.usage.inputTokens ?? 0} in / {detail.usage.outputTokens ?? 0} out</dd>
            </>
          ) :
          null}
        {detail.event !== undefined ?
          (
            <>
              <dt>journal</dt>
              <dd>{detail.event}{detail.sequence !== undefined ? ` · #${detail.sequence}` : ""}</dd>
            </>
          ) :
          null}
      </dl>
      {detail.source !== undefined ? <Block title="Script" text={detail.source} /> : null}
      {detail.printed !== undefined ? <Block title="Printed" text={detail.printed} /> : null}
      {detail.input !== undefined ? <Block title="Input" text={json(detail.input)} /> : null}
      {detail.output !== undefined ? <Block title="Output" text={detail.output} /> : null}
      {detail.message !== undefined ? <Block title="Failure" text={detail.message} alert /> : null}
      {detail.fields !== undefined ?
        (
          <Block
            title="Journal fields"
            text={Object.entries(detail.fields).map(([key, value]) => `${key.padEnd(12)}${json(value)}`).join("\n")}
          />
        ) :
        null}
    </div>
  )
}

const Block = (
  { title, text, alert = false }: { readonly title: string; readonly text: string; readonly alert?: boolean }
) => (
  <div className="run-trace-block">
    <h5>{title}</h5>
    <pre className="run-trace-code" tabIndex={0} aria-label={title} {...(alert ? { role: "alert" } : {})}>{text}</pre>
  </div>
)
