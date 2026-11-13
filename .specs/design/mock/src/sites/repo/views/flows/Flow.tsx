import { pluralize } from "../../ui/pluralize"
import { WriteControl } from "../../frame/WriteControl"
import { useCallback, useEffect, useState } from "react"
import { useMock } from "../../../core/mock"
import { Link, navigate, useLocation } from "../../../core/router"
import { file, flow as findFlow, repo, run, to } from "../../fixtures"
import type { Flow as FlowRecord, Trigger } from "../../fixtures/types"
import { Empty, Failed, Loading, registerSlash, useView } from "../../frame"
import { ViewFrame as RepoFrame } from "../checklist/ViewFrame"
import { Box, CodeView, Icon, PageHeader, RelTime, StateIcon, Tabs, toast } from "../../ui"
import { FlowRunForm, useFlowCommands } from "./actions"
import { triggerLabel } from "./Flows"
import { useAgents } from "./agent-models"

const FlowGraph = ({ flow }: { flow: FlowRecord }) => {
  const { nodes, edges } = flow.graph
  const kinds = { agent: "agent", check: "check", approval: "issue", step: "file" }
  const levels = new Map(nodes.map(node => [node.id, 0]))
  for (let i = 0; i < nodes.length; i++) {
    edges.forEach(([from, to]) => {
      if (levels.has(from) && levels.has(to)) levels.set(to, Math.min(nodes.length - 1, Math.max(levels.get(to)!, levels.get(from)! + 1)))
    })
  }
  const columns = Math.max(1, ...levels.values()) + 1
  const columnNodes = Array.from({ length: columns }, (_, i) => nodes.filter(node => levels.get(node.id) === i))
  const height = Math.max(1, ...columnNodes.map(group => group.length)) * 100 + 32
  const points = new Map(nodes.map(node => [node.id, {
    x: (levels.get(node.id) ?? 0) * 178 + 16,
    y: columnNodes[levels.get(node.id) ?? 0].findIndex(item => item.id === node.id) * 100 + 16
  }]))
  return (
    <Box header="Flow">
      <div className="repo-flows-graph-scroll">
        <div className="repo-flows-graph" style={{ width: columns * 178 + 8, height }}>
          <svg className="repo-flows-edges" width={columns * 178 + 8} height={height} aria-label="Flow connections">
            {edges.map(([from, to], i) => {
              const a = points.get(from)
              const b = points.get(to)
              return a && b ? (
                <g key={i}>
                  <title>{nodes.find(node => node.id === from)?.label} → {nodes.find(node => node.id === to)?.label}</title>
                  <path d={`M ${a.x + 144} ${a.y + 30} C ${a.x + 165} ${a.y + 30}, ${b.x - 20} ${b.y + 30}, ${b.x - 4} ${b.y + 30}`} />
                  <path d={`m ${b.x - 9} ${b.y + 26} 5 4 -5 4`} />
                </g>
              ) : null
            })}
          </svg>
          {nodes.map(node => {
            const point = points.get(node.id)!
            const previous = edges.filter(([, to]) => to === node.id)
              .map(([from]) => nodes.find(node => node.id === from)?.label).filter(Boolean)
            return (
              <div className={`repo-flows-node repo-flows-node-${node.kind}`} key={node.id} style={{ left: point.x, top: point.y }}>
                <div><Icon name={kinds[node.kind]} /><span>{node.label}</span></div>
                <small>{node.kind}</small>
                {previous.length > 0 && <span className="repo-flows-node-after">After {previous.join(", ")}</span>}
              </div>
            )
          })}
        </div>
      </div>
    </Box>
  )
}

const FlowTriggers = ({ flow }: { flow: FlowRecord }) => {
  const { flags } = useMock()
  const [triggers, setTriggers] = useState(flow.triggers)
  const canEdit = flags.as === "in" && flags.role === "member"
  const reason = flags.as === "out" ? "Sign in to change triggers." : "Only members can change triggers."
  const change = useCallback((index: number, enabled: boolean) => {
    if (!canEdit || !flow.triggers[index]) return
    setTriggers(current => current.map((trigger, i) => i === index ? { ...trigger, enabled } : trigger))
    toast(`Trigger ${enabled ? "enabled" : "disabled"}.`)
  }, [canEdit, flow])
  useEffect(() => registerSlash("triggers.set", {
    purpose: "Set a flow trigger",
    fields: [
      { name: "trigger", label: "Trigger", options: flow.triggers.map((_, i) => String(i + 1)) },
      { name: "enabled", label: "Enabled", options: ["on", "off"] }
    ],
    confirm: false,
    run: ({ trigger, enabled }) => change(Number(trigger) - 1, enabled === "on")
  }), [flow, change])
  return (
    <Box header="Triggers">
      {triggers.map((trigger: Trigger, i) => (
        <div className="repo-flows-trigger" key={`${trigger.kind}-${i}`}>
          <div><strong>{triggerLabel(trigger)}</strong><code>{trigger.spec}</code></div>
          {flags.as === "out" ? <span className="repo-ui-muted">{trigger.enabled ? "On" : "Off"}</span> : <button
            role="switch"
            aria-checked={trigger.enabled}
            aria-label={`${triggerLabel(trigger)} trigger`}
            className="repo-flows-switch"
            disabled={!canEdit}
            title={`/triggers.set ${i + 1} ${trigger.enabled ? "off" : "on"}${canEdit ? "" : ` · ${reason}`}`}
            onClick={() => change(i, !trigger.enabled)}
          >
            <span aria-hidden="true" />{trigger.enabled ? "On" : "Off"}
          </button>}
        </div>
      ))}
      {flags.as !== "out" && !canEdit && <p className="repo-flows-permission">{reason}</p>}
    </Box>
  )
}

export const FlowOverview = ({ flow }: { flow: FlowRecord }) => {
  const agents = useAgents()
  return (
    <div className="repo-flows-overview">
      <FlowGraph flow={flow} />
      <Box header="Inputs">
        {flow.inputs.length ? (
          <div className="repo-flows-input-table" role="table" aria-label="Flow inputs">
            {flow.inputs.map(input => (
              <div role="row" key={input.name}>
                <span role="cell"><code>{input.name}</code><small>{input.type} · {input.required ? "required" : "optional"}</small></span>
                <span role="cell">{input.description}</span>
              </div>
            ))}
          </div>
        ) : <p className="repo-flows-padding repo-ui-muted">No inputs.</p>}
      </Box>
      <div className="repo-flows-details-grid">
        <FlowTriggers flow={flow} />
        <Box header="Roles">
          {flow.roles.map(role => {
            const agent = agents.find(agent => agent.id === role.agent)
            return (
              <div className="repo-flows-role" key={role.role}>
                <strong>{role.role}</strong>
                <Link to={to("agents")}><Icon name="agent" />{agent?.name ?? role.agent}</Link>
                <code>{agent?.model}</code>
              </div>
            )
          })}
          {!flow.roles.length && <p className="repo-flows-padding repo-ui-muted">No agent roles.</p>}
        </Box>
      </div>
    </div>
  )
}

export const FlowSource = ({ flow }: { flow: FlowRecord }) => {
  const source = file(flow.file)
  return source ? <CodeView code={source.content} path={flow.file} /> : <Empty title="Source isn't available in this mock." />
}
export const FlowRuns = ({ flow }: { flow: FlowRecord }) => (
  <Box header={`${flow.runs.length} ${pluralize(flow.runs.length, "run")}`}>
    {flow.runs.length ? flow.runs.map(id => {
      const item = run(id)
      return item ? (
        <div className="repo-flows-run-row" key={id}>
          <StateIcon state={item.state} />
          <div><Link to={to(`runs/${id}`)}>{item.title}</Link><small>{item.id} · {item.state} · <RelTime date={item.started} /></small></div>
        </div>
      ) : null
    }) : <Empty title="No runs yet." />}
  </Box>
)
export const FlowLoading = () => <Loading variant="detail" rows={5} />
export const FlowError = () => <Failed what="this flow" reason="The repository host didn't respond. The flow hasn't loaded." />
export const FlowNotFound = () => <Empty title="Flow not found." action={<Link to={to("flows")}>All flows</Link>} />
export const FlowEmpty = () => <Empty title="No flows yet." action={<Link to={to("docs")}>Read the docs</Link>} />

export const FlowReady = ({ flow }: { flow: FlowRecord }) => {
  const { flags } = useMock()
  const canEdit = flags.as === "in" && flags.role === "member"
  const location = useLocation()
  const query = new URLSearchParams(location.split("?")[1])
  const tab = query.get("tab") === "source" ? "source" : query.get("tab") === "runs" ? "runs" : "overview"
  const [form, setForm] = useState(query.get("run") === "1")
  const open = useCallback((name?: string) => {
    if (name && name !== flow.name) navigate(to(`flows/${name}?run=1`))
    else setForm(true)
  }, [flow.name])
  useFlowCommands(open, flow)
  useEffect(() => registerSlash("file.edit", {
    purpose: "Edit flow source",
    fields: [{ name: "path", label: "File", required: false }],
    confirm: false,
    run: ({ path }) => navigate(to(`blob/${repo.defaultBranch}/${path || flow.file}?edit=1`))
  }), [flow.file])
  useEffect(() => setForm(query.get("run") === "1"), [location])
  return (
    <>
      <Link className="repo-flows-back" to={to("flows")}>Flows</Link>
      <PageHeader title={flow.name} description={flow.description} actions={(
        <WriteControl primary access="signed-in">{canEdit ? <button className={`repo-ui-btn${form ? "" : " repo-ui-btn-primary"}`} title={`/flow.run ${flow.name}`} onClick={() => open()} aria-expanded={form}>
          Run this flow
        </button> : <button className="repo-ui-btn repo-ui-btn-primary" title="/repo.request-access" onClick={() => toast("Access requested from the repository owner.")}>Request access</button>}</WriteControl>
      )}>
        <div className="repo-flows-file-line">
          <Icon name="file" />
          <Link to={to(`blob/${repo.defaultBranch}/${flow.file}`)}>{flow.file}</Link>
          {canEdit ? (
            <Link className="repo-ui-btn repo-ui-btn-quiet" title={`/file.edit ${flow.file}`} to={to(`blob/${repo.defaultBranch}/${flow.file}?edit=1`)}>Edit</Link>
          ) : <WriteControl><button className="repo-ui-btn repo-ui-btn-quiet" title={`/file.edit ${flow.file} · Only members can edit flows.`} disabled>Edit</button></WriteControl>}
        </div>
      </PageHeader>
      {flags.as === "in" && !canEdit && <p className="repo-flows-permission">Only members can run flows.</p>}
      {form && canEdit && <FlowRunForm initial={flow} onClose={() => setForm(false)} />}
      <Tabs active={tab} items={[
        { id: "overview", label: "Overview", to: to(`flows/${flow.name}`) },
        { id: "source", label: "Source", to: to(`flows/${flow.name}?tab=source`) },
        { id: "runs", label: "Runs", to: to(`flows/${flow.name}?tab=runs`), count: flow.runs.length }
      ]} />
      <div className="repo-flows-tab-content">
        {tab === "source" ? <FlowSource flow={flow} /> : tab === "runs" ? <FlowRuns flow={flow} /> : <FlowOverview flow={flow} />}
      </div>
    </>
  )
}

export const Flow = ({ name }: { name: string }) => {
  const state = useView(`flow:${repo.slug}:${name}`)
  const flow = findFlow(name)
  return (
    <RepoFrame tab="flows" title={`${repo.slug} · ${name}`} askView="flow" askContext={`${name} in ${repo.slug}`}>
      {state === "loading" ? <FlowLoading /> : state === "error" ? <FlowError />
        : state === "empty" ? <FlowEmpty /> : !flow ? <FlowNotFound /> : <FlowReady key={`${repo.slug}:${name}`} flow={flow} />}
    </RepoFrame>
  )
}
