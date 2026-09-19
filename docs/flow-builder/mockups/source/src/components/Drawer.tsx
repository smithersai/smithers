import { useState } from "react"

import {
  AGENTS,
  ATTEMPTS,
  JEV_ROUTE,
  JEVS,
  journalFor,
  OUTPUTS,
  PREDICTIONS,
  TRIGGER,
  type AgentDetail,
  type JevDetail
} from "../detail.ts"
import { formatDuration, type FlowNodeSpec, type NodeState } from "../flow.ts"
import { AST_PATH, FLOW_SOURCE, TRIGGER_SOURCE } from "../source.ts"
import { CodeView } from "./CodeView.tsx"
import { IconMaximize, IconMinimize, IconX, KIND_ICON } from "./Icons.tsx"

type Tab = "schedule" | "frames" | "questions" | "question" | "output" | "input" | "code" | "key" | "attempts" | "events"

const TAB_LABEL: Record<Tab, string> = {
  schedule: "Schedule",
  frames: "Frames",
  questions: "Questions",
  question: "Question",
  output: "Output",
  input: "Input",
  code: "Code",
  key: "Key",
  attempts: "Attempts",
  events: "Events"
}

const SETTLED: readonly NodeState[] = ["built", "clean"]

/** A tab with nothing behind it never appears. */
const tabsFor = (spec: FlowNodeSpec, state: NodeState, scripted: boolean): Tab[] => {
  if (spec.kind === "trigger") return ["schedule", "code"]
  const tabs: Tab[] = []
  if (scripted && spec.kind === "agent" && AGENTS[spec.id] && state !== "idle") tabs.push("frames")
  if (scripted && spec.kind === "jev" && JEVS[spec.id] && SETTLED.includes(state)) tabs.push("questions")
  if (spec.kind === "human") tabs.push("question")
  if (scripted && SETTLED.includes(state) && OUTPUTS[spec.id]) tabs.push("output")
  if (spec.payload.length > 0) tabs.push("input")
  if (scripted && FLOW_SOURCE.ranges[spec.id]) tabs.push("code")
  tabs.push("key")
  if (scripted && ATTEMPTS[spec.id] && state !== "idle") tabs.push("attempts")
  if (scripted && state === "built") tabs.push("events")
  return tabs
}

const Bar = ({ value, tone }: { value: number; tone?: string }) => (
  <span className="pbar" data-tone={tone} aria-hidden="true"><span style={{ width: `${Math.round(value * 100)}%` }} /></span>
)

const Rows = ({ rows }: { rows: readonly (readonly [string, string])[] }) => (
  <dl className="kv">
    {rows.map(([key, value]) => (
      <div key={key}><dt>{key}</dt><dd>{value}</dd></div>
    ))}
  </dl>
)

const ScheduleTab = () => (
  <>
    <section className="dblock">
      <div className="cron">
        <code>{TRIGGER.schedule}</code>
        <span>{TRIGGER.narrated}</span>
      </div>
      <Rows rows={[["timezone", TRIGGER.timezone], ["overlap", TRIGGER.overlap], ["catch-up", TRIGGER.catchUp]]} />
    </section>
    <section className="dblock">
      <h3>Next 5 runs</h3>
      <table className="next">
        <tbody>
          {TRIGGER.next.map((row) => (
            <tr key={row.local}><td>{row.local}</td><td>{row.utc}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
    <section className="dblock">
      <h3>Last 14</h3>
      <div className="strip" role="img" aria-label="12 completed, 2 failed, 1 cancelled">
        {TRIGGER.history.map((status, index) => <span key={index} data-status={status} title={status} />)}
      </div>
    </section>
  </>
)

const FramesTab = ({ agent }: { agent: AgentDetail }) => {
  const [open, setOpen] = useState(agent.frames[0].frame)
  return (
    <>
      <section className="dblock">
        <Rows rows={[
          ["seat", agent.seat.seat],
          ["model", agent.seat.modelId],
          ["route", agent.seat.routeId],
          ["protocol", agent.seat.protocolId],
          ["context", `${(agent.seat.contextWindowTokens / 1000).toFixed(0)}k tokens`]
        ]} />
      </section>
      <section className="dblock">
        <h3>System · 3 digested sections</h3>
        <ul className="sections">
          {agent.system.map((part) => (
            <li key={part.section}><span>{part.section}</span><code>{part.digest}</code><p>{part.text}</p></li>
          ))}
        </ul>
      </section>
      <section className="dblock">
        <h3>Frames · {agent.frames.length} of {agent.framesTotal}</h3>
        <ol className="frames">
          {agent.frames.map((frame) => (
            <li key={frame.frame} data-open={open === frame.frame ? "true" : undefined}>
              <button type="button" className="frame-head" onClick={() => setOpen(open === frame.frame ? -1 : frame.frame)}>
                <span className="frame-n">{frame.frame}</span>
                <span className="frame-t">{frame.transition}</span>
                <span className="frame-calls">
                  {frame.calls.map((call, index) => <i key={index} data-outcome={call.outcome}>{call.flow}</i>)}
                </span>
                <span className="frame-ms">{formatDuration(frame.ms)}</span>
              </button>
              {open === frame.frame ? (
                <div className="frame-body">
                  <h4>cell · javascript</h4>
                  <CodeView text={frame.cell} />
                  {frame.calls.length ? (
                    <>
                      <h4>ctx.call</h4>
                      <ul className="calls">
                        {frame.calls.map((call, index) => (
                          <li key={index} data-outcome={call.outcome}>
                            <code>{call.flow}</code><span>{call.note ?? call.outcome}</span><em>{formatDuration(call.ms)}</em>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {frame.printed ? (<><h4>printed</h4><pre className="printed">{frame.printed}</pre></>) : null}
                  <h4>model events</h4>
                  <ul className="mevents">
                    {frame.events.map((event, index) => (
                      <li key={index}><em>{(event.at / 1000).toFixed(1)}s</em><code data-type={event.type.split("-")[0]}>{event.type}</code><span>{event.note}</span></li>
                    ))}
                  </ul>
                  <div className="usage">
                    <span><b>{frame.usage.input.toLocaleString()}</b> in</span>
                    <span><b>{frame.usage.output.toLocaleString()}</b> out</span>
                    <span><b>{frame.usage.cacheRead.toLocaleString()}</b> cache read</span>
                    {frame.usage.thinking ? <span><b>{frame.usage.thinking.toLocaleString()}</b> thinking</span> : null}
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
      <section className="dblock">
        <h3>Armed ceilings</h3>
        <div className="chips">
          {agent.ceilings.map((ceiling) => <span key={ceiling.name} className="fl-chip">{ceiling.name} {ceiling.value}</span>)}
        </div>
      </section>
    </>
  )
}

const QuestionsTab = ({ jev }: { jev: JevDetail }) => (
  <>
    <section className="dblock">
      <Rows rows={[
        ["classifier", jev.classifier],
        ["model", JEV_ROUTE.modelId],
        ["latency", `${jev.latencyMs}ms of ${JEV_ROUTE.deadlineMs}ms`],
        ["digest", jev.digest]
      ]} />
    </section>
    <section className="dblock">
      <h3>State</h3>
      <pre className="printed">{jev.state}</pre>
    </section>
    <section className="dblock">
      <h3>Questions</h3>
      <ul className="questions">
        {jev.questions.map((question) => (
          <li key={question.id}>
            <div className="q-head">
              <span className="fl-chip">{question.type}</span>
              <strong>{question.instructions}</strong>
              <code data-answer={question.answer}>{question.answer}</code>
            </div>
            {question.probabilities.map((row) => (
              <div className="q-row" key={row.option}>
                <span>{row.option}</span>
                <Bar value={row.p} tone={row.option === question.answer || (question.answer === "clean" && row.option === "clean") ? "info" : undefined} />
                <em>{row.p.toFixed(2)}</em>
              </div>
            ))}
          </li>
        ))}
      </ul>
      {jev.thresholds ? (
        <p className="dnote">flag ≥ {jev.thresholds.flag} · clean ≤ {jev.thresholds.clean} · between is uncertain</p>
      ) : null}
    </section>
  </>
)

interface DrawerProps {
  readonly spec: FlowNodeSpec | null
  readonly state: NodeState | undefined
  readonly rekeyed: boolean
  readonly settledMs: number | undefined
  readonly scripted: boolean
  readonly onClose: () => void
  readonly onSelect: (id: string) => void
}

export const Drawer = ({ spec, state, rekeyed, settledMs, scripted, onClose, onSelect }: DrawerProps) => {
  const [picked, setPicked] = useState<Tab | null>(null)
  const [max, setMax] = useState(false)
  if (!spec || !state) return null

  const tabs = tabsFor(spec, state, scripted)
  const tab = picked && tabs.includes(picked) ? picked : tabs[0]
  const Glyph = KIND_ICON[spec.kind]
  const prediction = PREDICTIONS[spec.tag]
  const source = spec.kind === "trigger" ? TRIGGER_SOURCE : FLOW_SOURCE
  const range = source.ranges[spec.id]
  const path = AST_PATH[spec.id]

  return (
    <aside className="drawer" data-max={max ? "true" : undefined} aria-label={`${spec.title} details`}>
      <header className="drawer-head">
        <span className="inspector-glyph" data-kind={spec.kind} aria-hidden="true"><Glyph /></span>
        <div className="drawer-title">
          <h2>{spec.title}</h2>
          <code>{spec.tag}</code>
        </div>
        <span className="drawer-state" data-state={state}>
          {state === "dirty" ? "will re-run" : state}
        </span>
        <button type="button" className="icon-btn" onClick={() => setMax((value) => !value)} aria-label={max ? "Restore" : "Maximize"}>
          {max ? <IconMinimize /> : <IconMaximize />}
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><IconX /></button>
      </header>

      <div className="drawer-meta">
        <span className="fl-chip" data-tier={spec.tier}>{spec.tier}</span>
        {spec.seat ? <span className="fl-chip fl-chip-quiet">{spec.seat}</span> : null}
        {prediction && state !== "built" && state !== "clean" && state !== "skipped" ? (
          <span className="predict">~{formatDuration(prediction.p50)} <em>p50 of {prediction.samples}</em></span>
        ) : null}
        {state === "built" && settledMs !== undefined ? (
          <span className="predict">{formatDuration(settledMs)}{prediction ? <em> · p50 {formatDuration(prediction.p50)}</em> : null}</span>
        ) : null}
      </div>

      <nav className="tabs" role="tablist">
        {tabs.map((name) => (
          <button key={name} type="button" role="tab" aria-selected={tab === name} className="tab" data-active={tab === name ? "true" : undefined} onClick={() => setPicked(name)}>
            {TAB_LABEL[name]}
            {name === "attempts" ? <i>{ATTEMPTS[spec.id].length}</i> : null}
          </button>
        ))}
      </nav>

      <div className="drawer-scroll">
        {tab === "schedule" ? <ScheduleTab /> : null}
        {tab === "frames" ? <FramesTab agent={AGENTS[spec.id]} /> : null}
        {tab === "questions" ? <QuestionsTab jev={JEVS[spec.id]} /> : null}

        {tab === "question" ? (
          <section className="dblock">
            <pre className="printed">{`{
  "task": "human",
  "name": "approve-change",
  "kind": "confirm",
  "prompt": "Land a failing test on a new change?",
  "attempt": 1,
  "maxAttempts": 10
}`}</pre>
            <p className="dnote">flows_runs.waiting_request · one durable wait point per attempt</p>
          </section>
        ) : null}

        {tab === "output" ? (
          <section className="dblock">
            {state === "clean" ? (
              <div className="served">
                <span>served from run <code>r_8f2c41</code> · event <code>#412</code></span>
                <button type="button" className="btn">Jump to original run</button>
              </div>
            ) : null}
            <h3>{spec.success}</h3>
            <CodeView text={OUTPUTS[spec.id]} />
          </section>
        ) : null}

        {tab === "input" ? (
          <section className="dblock">
            <ul className="ports">
              {spec.payload.map((field) => (
                <li key={field.name}>
                  <span className="port-badge" data-ref={field.from ? "Ref" : "Literal"}>{field.from ? "Ref" : "Literal"}</span>
                  <span className="port-name">{field.name}</span>
                  <span className="port-type">{field.type}</span>
                  {field.from ? (
                    <button type="button" className="port-ref" onClick={() => onSelect(field.from!.split(".")[0])}>← {field.from}</button>
                  ) : (
                    <span className="port-literal">{field.literal}</span>
                  )}
                </li>
              ))}
            </ul>
            {spec.effects ? (<><h3>Effects</h3><p className="inspector-effects">{spec.effects}</p></>) : null}
          </section>
        ) : null}

        {tab === "code" ? (
          <section className="dblock dblock-code">
            <div className="code-head">
              <code className="code-path">{source.path}</code>
              {range ? <span className="code-lines">L{range[0]}–{range[1]}</span> : null}
              <button type="button" className="btn">Open file</button>
            </div>
            {path ? (
              <div className="crumbs-ast" aria-label="Plan node id">
                {path.map((part, index) => <span key={index}>{part}</span>)}
              </div>
            ) : null}
            <CodeView text={source.text} highlight={range} maxHeight={max ? undefined : 420} />
          </section>
        ) : null}

        {tab === "key" ? (
          <section className="dblock">
            <div className="keyline" data-rekeyed={rekeyed ? "true" : undefined}>
              <code data-stale={rekeyed ? "true" : undefined}>{spec.key}</code>
              {rekeyed && spec.rekey ? (<><span aria-hidden="true">→</span><code data-fresh="true">{spec.rekey}</code></>) : null}
            </div>
            {rekeyed ? <p className="dnote">changed: <code>inputs[0]</code> · voids 1 approval</p> : null}
            <h3>StepKey.content</h3>
            <CodeView text={`StepKey.content({
  body: { action: "${spec.tag}" },
  inputs: [${spec.payload.map((field) => field.from ? `Ref("${field.from}")` : `Literal`).join(", ")}],
  layers: ["${spec.tag.split("/")[0]}"],
  capabilities: [],
  kind: "${spec.tier}"
})`} />
          </section>
        ) : null}

        {tab === "attempts" ? (
          <section className="dblock">
            <ol className="attempts">
              {ATTEMPTS[spec.id].map((row) => (
                <li key={row.attempt} data-state={row.state}>
                  <div><span className="frame-n">{row.attempt}</span><strong>{row.state}</strong><em>{formatDuration(row.ms)}</em></div>
                  {row.error ? <pre className="printed" data-tone="danger">{row.error}</pre> : null}
                </li>
              ))}
            </ol>
            <p className="dnote">retry 200ms × 1.5, max 30s · bounds are per step key and survive process death</p>
          </section>
        ) : null}

        {tab === "events" ? (
          <section className="dblock">
            <ul className="journal">
              {journalFor(spec.id, spec.key).map((row) => (
                <li key={row.seq}><em>{row.seq}</em><code>{row.type}</code><span>{row.payload}</span></li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <footer className="inspector-foot">
        {spec.kind === "trigger" ? (
          <>
            <button type="button" className="btn btn-primary">Fire now</button>
            <button type="button" className="btn">Disable</button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary">Edit</button>
            <button type="button" className="btn">Open file</button>
          </>
        )}
      </footer>
    </aside>
  )
}
