import { HeldCodeChange } from "../../ui/HeldCodeChange"
import { useEffect, useId, useRef, useState } from "react"
import { useMock } from "../../../core/mock"
import { navigate, useLocation } from "../../../core/router"
import { flows, issues, MOCK_NOW, people, pulls, repo, runs, tags, to } from "../../fixtures"
import type { Flow, Run } from "../../fixtures/types"
import { Denied, registerSlash, SignInWall } from "../../frame"
import { Box, CopyButton, toast } from "../../ui"
import { allAgents } from "./agent-models"

export const changesCode = (flow: Flow) => /implement|land|release(?!-notes)|docs-sync|docs-generate/.test(flow.name)
  || flow.graph.nodes.some(node => /implement|open pull|commit|publish|merge|write code/i.test(node.label))

export const runDefaults = (flow: Flow): Record<string, string> => Object.fromEntries(flow.inputs.map(input => [
  input.name,
  input.name === "issue" ? String(issues.find(issue => issue.state === "open")?.n ?? "")
    : input.name === "pull" ? String(pulls.find(pull => pull.state === "open")?.n ?? "")
    : /^(ref|branch)$/.test(input.name) ? repo.defaultBranch
    : input.name === "tag" ? tags[0]?.name ?? ""
    : input.type === "boolean" ? "false" : ""
]))

/** The run family reads this tab-local overlay. No fixture records are changed. */
export const startFlowRun = (flow: Flow, inputs: Record<string, string>) => {
  const id = `run-local-${Date.now()}`
  const by = people.find(person => person.role === "owner")?.login ?? repo.owner
  const agent = allAgents().find(agent => agent.id === flow.roles[0]?.agent)
  const prototype = runs.find(run => run.flow === flow.name)
  const record: Run = {
    id,
    flow: flow.name,
    title: `${flow.description}${inputs.issue ? ` #${inputs.issue}` : inputs.pull ? ` #${inputs.pull}` : ""}`,
    state: "running",
    trigger: { kind: "manual", by, ref: inputs.ref ?? inputs.branch ?? repo.defaultBranch },
    harness: agent ? `${agent.harness === "codex" ? "Codex" : "Claude Code"} · ${agent.model}`
      : prototype?.harness ?? "Repository workflow",
    started: MOCK_NOW,
    duration: "0 s",
    cost: { usd: 0, tokens: 0 },
    issue: inputs.issue ? Number(inputs.issue) : undefined,
    pull: inputs.pull ? Number(inputs.pull) : undefined,
    stages: flow.graph.nodes.map((node, index) => ({
      id: node.id,
      label: node.label,
      state: index === 0 ? "running" : "queued",
      started: index === 0 ? MOCK_NOW : undefined,
      summary: index === 0 ? "Starting" : "Waiting for the previous step",
      log: index === 0 ? [`Started manually by ${by}`] : []
    })),
    approvals: [],
    trace: [{ at: MOCK_NOW, stage: flow.graph.nodes[0]?.id ?? "", kind: "message", text: `Started ${flow.name}` }]
  }
  try {
    const key = `repo-runs:${repo.slug}`
    const previous = JSON.parse(sessionStorage.getItem(key) ?? '{"runs":{},"approvals":{}}')
    sessionStorage.setItem(key, JSON.stringify({ ...previous, runs: { ...previous.runs, [id]: record } }))
    window.dispatchEvent(new Event("repo-runs-local-change"))
  } catch {
    toast("Browser storage is unavailable. The run wasn't started.")
    return
  }
  toast("Run started.")
  navigate(to(`runs/${id}`))
  return id
}

export const FlowDenied = () => <Denied act="run flows" />
export const FlowSignedOut = () => <SignInWall act="run a flow" />
export const FlowHeld = ({ flow }: { flow: Flow }) => (
  <div className="repo-flows-held" role="note">
    <strong>Run this flow on your install</strong>
    <HeldCodeChange />
    <div className="repo-flows-command">
      <code>smthrs flow start {flow.name}</code>
      <CopyButton text={`smthrs flow start ${flow.name}`} small />
    </div>
  </div>
)

export const useFlowCommands = (open: (name?: string) => void, selected?: Flow) => {
  useEffect(() => registerSlash("flow.run", {
    purpose: "Run a flow",
    fields: [{ name: "flow", label: "Flow", options: flows.map(flow => flow.name), required: false }],
    confirm: false,
    run: ({ flow }, context) => {
      open(flow || selected?.name)
      context.closeAsk()
    }
  }), [open, selected])
}

export const FlowRunForm = ({ initial, onClose }: { initial?: Flow; onClose: () => void }) => {
  const { flags } = useMock()
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const started = useRef(false)
  const query = new URLSearchParams(useLocation().split("?")[1])
  const [name, setName] = useState(initial?.name ?? flows[0]?.name ?? "")
  const selected = flows.find(flow => flow.name === name)
  const [values, setValues] = useState<Record<string, string>>(() => selected ? runDefaults(selected) : {})
  const [confirm, setConfirm] = useState(query.get("confirm") === "1")
  useEffect(() => heading.current?.focus(), [])
  const close = () => onClose()
  const blocked = flags.host === "hosted" && flags.landing === "install" && selected && changesCode(selected)
  const validate = () => Boolean(selected && selected.inputs.every(input =>
    (!input.required || values[input.name]?.trim())
    && (input.type !== "number" || !values[input.name] || (Number.isFinite(Number(values[input.name])) && Number(values[input.name]) >= 1))
  ))
  const canRun = flags.as === "in" && flags.role === "member" && !blocked
    && !(flags.host === "hosted" && flags.hosted === "paused")
  const launch = () => {
    if (!canRun || !validate() || !selected || started.current) return
    started.current = Boolean(startFlowRun(selected, values))
  }
  useEffect(() => {
    const dispose = [
      registerSlash("flow.cancel", { purpose: "Close run form", fields: [], confirm: false, access: "public", run: () => close() }),
      registerSlash("flow.inputs", { purpose: "Edit run inputs", fields: [], confirm: false, run: () => setConfirm(false) }),
      registerSlash("flow.confirm", {
        purpose: "Review run inputs", fields: [], confirm: false,
        run: (_, context) => {
          if (canRun && validate()) { setConfirm(true); context.closeAsk() }
          else formRef.current?.reportValidity()
        }
      }),
      registerSlash("flow.start", {
        purpose: "Start this flow", fields: [], confirm: "Start this run?",
        run: (_, context) => {
          if (canRun && validate() && selected) { context.closeAsk(); launch() }
          else { setConfirm(false); context.closeAsk(); formRef.current?.reportValidity() }
        }
      })
    ]
    return () => dispose.forEach(off => off())
  }, [canRun, selected, values, onClose])
  return (
    <Box className="repo-flows-run-card">
      <section className="repo-flows-form" aria-label="Run a flow" onKeyDown={event => {
        if (event.key === "Escape") close()
      }}>
        <div className="repo-flows-form-heading">
          <h2 tabIndex={-1} ref={heading}>{confirm ? "Start this run?" : initial ? `Run ${initial.name}` : "Run a flow"}</h2>
          <button className="repo-ui-icon-btn" title="/flow.cancel" aria-label="Close run form" onClick={close}>×</button>
        </div>
        {flags.as === "out" ? <FlowSignedOut />
          : flags.role !== "member" ? <FlowDenied />
          : flags.hosted === "paused" && flags.host === "hosted" ? <p role="status">Hosted machines are paused. Try again when they resume.</p>
          : (
            <form ref={formRef} onSubmit={event => {
              event.preventDefault()
              if (!canRun || !validate()) return
              if (confirm && selected) launch()
              else setConfirm(true)
            }}>
              {!initial && !confirm && (
                <label htmlFor={`${id}-flow`}>
                  Flow
                  <select id={`${id}-flow`} className="repo-ui-input" value={name} onChange={event => {
                    setName(event.target.value)
                    const flow = flows.find(flow => flow.name === event.target.value)
                    setValues(flow ? runDefaults(flow) : {})
                  }}>
                    {flows.map(flow => <option key={flow.name} value={flow.name}>{flow.name}</option>)}
                  </select>
                </label>
              )}
              {blocked && selected ? <FlowHeld flow={selected} /> : confirm ? (
                <div className="repo-flows-confirm">
                  <strong>{selected?.name}</strong>
                  <span className="repo-ui-muted">{repo.slug} · {repo.defaultBranch}</span>
                  <dl>
                    {selected?.inputs.map(input => (
                      <div key={input.name}><dt>{input.name}</dt><dd>{values[input.name] || "—"}</dd></div>
                    ))}
                  </dl>
                </div>
              ) : selected?.inputs.map(input => (
                <label htmlFor={`${id}-${input.name}`} key={input.name}>
                  {input.name}{!input.required && <span className="repo-ui-muted"> (optional)</span>}
                  {input.type === "boolean" ? (
                    <select
                      className="repo-ui-input"
                      id={`${id}-${input.name}`}
                      value={values[input.name] || "false"}
                      onChange={event => setValues(current => ({ ...current, [input.name]: event.target.value }))}
                    >
                      <option value="false">False</option>
                      <option value="true">True</option>
                    </select>
                  ) : (
                    <input
                      className="repo-ui-input"
                      id={`${id}-${input.name}`}
                      type={input.type === "number" ? "number" : "text"}
                      min={input.type === "number" ? 1 : undefined}
                      required={input.required}
                      value={values[input.name] ?? ""}
                      onChange={event => setValues(current => ({ ...current, [input.name]: event.target.value }))}
                      aria-describedby={`${id}-${input.name}-help`}
                    />
                  )}
                  <span id={`${id}-${input.name}-help`} className="repo-ui-muted">{input.description}</span>
                </label>
              ))}
              <div className="repo-ui-actions">
                {!blocked && selected && (
                  <button className="repo-ui-btn repo-ui-btn-primary" title={confirm ? "/flow.start" : "/flow.confirm"}>
                    {confirm ? "Start run" : "Continue"}
                  </button>
                )}
                {confirm && (
                  <button type="button" className="repo-ui-btn" title="/flow.inputs" onClick={() => setConfirm(false)}>Back</button>
                )}
                <button type="button" className="repo-ui-btn repo-ui-btn-quiet" title="/flow.cancel" onClick={close}>Cancel</button>
              </div>
            </form>
          )}
      </section>
    </Box>
  )
}
