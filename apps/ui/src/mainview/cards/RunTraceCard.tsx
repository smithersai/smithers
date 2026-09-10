/*
 * The run card starts with a cheap explanation of each recorded turn. A
 * selection opens that turn's recursive call tree and recorded details; the
 * timeline view exposes the full tree and waterfall. Both are the same
 * embedded card, and neither manufactures historical values from live state.
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
 * holds no state of its own.
 */
import { runSourceCommand } from "../flows/RunCommand"
import { EmptyState, StatusPill } from "@smthrs/ui"
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
  const { runId, phase, kind } = card.payload
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
  const turns = turnNarratives(model).filter((turn) => spanMatches(turn.frame, filter))
  const native = model.root.children.filter((span) =>
    (span.kind === "execution" || span.id.startsWith("engine-gap:") || span.id.startsWith("engine-invalid:")) && spanMatches(span, filter)
  )
  // Following a run is cheap. The debugger appears only after an explicit selection or timeline request.
  const inspecting = view === "timeline" || card.payload.selection !== undefined
  const wall = model.extent.end - model.extent.start
  return (
    <div className="run-trace" data-testid={`run-trace-${runId}`} data-kind={kind}>
      {kind === "prototype" ?
        (
          <p className="run-trace-banner" data-testid={`run-trace-banner-${runId}`}>
            <span className="run-trace-kind">kind: prototype · never promoted</span> {PROTOTYPE_BANNER}
          </p>
        ) :
        null}
      <CodingPlanBody card={card} onRunCommand={onRunCommand} workflowCatalogs={workflowCatalogs} />
      <CodingPocBody card={card} onRunCommand={onRunCommand} />
      <CodingVibeBody card={card} onRunCommand={onRunCommand} />
      <div className="run-trace-bar" role="group" aria-label="Trace filters">
        <div className="run-trace-views" role="group" aria-label="Trace presentation">
          {(["turns", "timeline"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="run-trace-filter"
              data-flow="runs.trace.view"
              aria-pressed={view === mode}
              onClick={() => onRunCommand("runs.trace.view", `${runId} ${mode}`)}
            >
              {mode === "turns" ? "Turns" : "Timeline"}
            </button>
          ))}
        </div>
        {filters.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="run-trace-filter"
            data-flow="runs.trace.filter"
            data-filter={id}
            data-on={filter === id}
            aria-pressed={filter === id}
            onClick={() => onRunCommand("runs.trace.filter", `${runId} ${id}`)}
          >
            {label}
          </button>
        ))}
        <span className="run-trace-clock" data-testid={`run-trace-clock-${runId}`}>
          {model.counts.spans === 0
            ? "no journal yet"
            : `${model.counts.spans} ${model.counts.spans === 1 ? "span" : "spans"}${
              model.counts.running > 0 ? ` · ${model.counts.running} running` : ""
            }${model.counts.failed > 0 ? ` · ${model.counts.failed} failed` : ""} · t = ${durationWords(wall)}`}
        </span>
        {card.payload.liveTail === false ?
          (
            <>
              {card.payload.cursorSeq !== undefined
                ? <span className="run-trace-cursor">At #{card.payload.cursorSeq}</span>
                : null}
              <button
                type="button"
                className="run-trace-filter"
                data-flow="runs.trace.live"
                onClick={() => onRunCommand("runs.trace.live", runId)}
              >
                Latest
              </button>
            </>
          ) :
          null}
      </div>
      {view === "turns" ?
        (
          <ol className="run-turns" aria-label="Turn explanations">
            {turns.map((turn) => (
              <li key={turn.frame.id}>
                <button
                  type="button"
                  className="run-turn"
                  data-flow="runs.trace.select"
                  data-turn={turn.number}
                  aria-pressed={card.payload.selection !== undefined && frame?.id === turn.frame.id}
                  title={turn.source === "model" ? "Recorded model text" : "Recorded journal activity"}
                  onClick={() => onRunCommand("runs.trace.select", `${runId} ${turn.frame.id}`)}
                >
                  <span className="run-turn-number">{turn.number}</span>
                  <span className="run-turn-text">{turn.text}</span>
                  <span className="run-trace-duration">{durationOf(turn.frame, model) ?? ""}</span>
                </button>
              </li>
            ))}
          </ol>
        ) :
        null}
      {view === "turns" && native.length > 0 ? (
        <ol className="run-turns" aria-label="Recorded engine work">
          {native.map((span) => (
            <li key={span.id}>
              <button
                type="button"
                className="run-turn"
                data-flow="runs.trace.select"
                data-engine-span={span.id}
                aria-pressed={card.payload.selection !== undefined && path.some((entry) => entry.id === span.id)}
                onClick={() => onRunCommand("runs.trace.select", `${runId} ${span.id}`)}
              >
                <span className="run-turn-text">{span.label} · {span.status}</span>
                <span className="run-trace-duration">{durationOf(span, model) ?? ""}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {model.counts.spans === 0 && !inspecting
        ? (
          <EmptyState
            description={`No journal yet. The run is ${phase}; turns appear as the workspace records them.`}
            data-testid={`run-trace-empty-${runId}`}
          />
        )
        : null}
      {inspecting ?
        (
          <>
            <nav className="run-trace-path" aria-label="Recorded call path">
              {path.map((ancestor, index) => (
                <span key={ancestor.id}>
                  {index > 0 ? <span aria-hidden>{" / "}</span> : null}
                  <button
                    type="button"
                    data-flow="runs.trace.select"
                    aria-current={ancestor.id === selected.id ? "location" : undefined}
                    onClick={() => onRunCommand("runs.trace.select", `${runId} ${ancestor.id}`)}
                  >
                    {ancestor.label}
                  </button>
                </span>
              ))}
            </nav>
            <div className="run-trace-body">
              <ol className="run-trace-tree" aria-label="Call tree">
                {rows.map((span) => (
                  <li key={span.id}>
                    <button
                      type="button"
                      className="run-trace-node"
                      data-flow="runs.trace.select"
                      data-trace-span={span.id}
                      data-kind={span.kind}
                      data-status={span.status}
                      data-depth={span.depth}
                      aria-selected={selected.id === span.id}
                      style={{ paddingLeft: `${0.25 + span.depth * 0.875}rem` }}
                      onClick={() => onRunCommand("runs.trace.select", `${runId} ${span.id}`)}
                    >
                      <span className="run-trace-dot" data-status={span.status} aria-hidden />
                      <span className="run-trace-label">{span.label}</span>
                      <span className="run-trace-duration">{durationOf(span, model) ?? ""}</span>
                    </button>
                  </li>
                ))}
              </ol>
              <div className="run-trace-detail">
                {model.counts.spans === 0 ?
                  (
                    <EmptyState
                      description={`No journal yet. The run is ${phase}; spans appear as the workspace records them.`}
                      data-testid={`run-trace-empty-${runId}`}
                    />
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
                                data-flow="runs.trace.select"
                                data-instant={instant}
                                data-open={span.endedAt === undefined}
                                aria-label={summary}
                                aria-pressed={selected.id === span.id}
                                title={summary}
                                style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                                onClick={() => onRunCommand("runs.trace.select", `${runId} ${span.id}`)}
                              />
                            </span>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                <SpanPane span={selected} model={model} runId={runId} />
                {selected.detail.childRunId !== undefined && selected.detail.childRunId !== "" &&
                    !/\s/.test(selected.detail.childRunId) ?
                  (
                    <button
                      type="button"
                      className="run-trace-filter"
                      data-flow="runs.open"
                      onClick={() => onRunCommand("runs.open", `${selected.detail.childRunId} ${card.payload.repo}`)}
                    >
                      Inspect child run
                    </button>
                  ) :
                  null}
              </div>
            </div>
          </>
        ) :
        null}
    </div>
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
        {span.kind} · {span.label} <StatusPill status={span.status} />
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
      {detail.source !== undefined ? <Block title="Cell" text={detail.source} /> : null}
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
