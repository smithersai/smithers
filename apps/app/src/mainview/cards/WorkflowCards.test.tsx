import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { WorkflowListCardBody, WorkflowRunCardBody } from "./WorkflowCards"
import type { Card } from "../state/AppState"
import type { WorkflowLaunch } from "../state/WorkflowLaunch"

test("a pending launch states only Requested and a refusal offers the existing Retry flow", () => {
  const request: WorkflowLaunch = { version: 1, id: "request", owner: "owner", repo: "owner/repo", workflow: "review", input: { args: "inspect" } }
  const card: Extract<Card, { kind: "run-trace" }> = { id: "flow-request-request", kind: "run-trace", title: "review", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: request.repo, workflow: request.workflow, runId: "pending-request", phase: "launching", steps: [], result: null, lastSeq: 0, input: { _workflowLaunch: request } } }
  const render = () => renderToStaticMarkup(<WorkflowRunCardBody card={card} onStopRun={() => {}} onRetryRun={() => {}} onRunCommand={() => {}} />)
  expect(render()).toContain('role="status">Requested</p>')
  expect(render()).not.toContain("<button")
  request.error = { stage: "launch", code: "provider_unavailable", message: "Provider unavailable" }
  expect(render()).toContain('role="alert">Provider unavailable</p>')
  expect(render()).toContain('data-flow="flow.run.retry"')
  expect(render()).toContain(">Retry</button>")
})

test("flow rows lead with their human description and retain an identifier fallback", () => {
  const card: Extract<Card, { kind: "workflow-list" }> = {
    id: "flows", kind: "workflow-list", title: "Flows", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "practice:smithersai/hello-server", workflows: [
      { key: "issue/repro", description: "Research and reproduce before implementation" },
      { key: "lint", description: null },
    ] },
  }
  const html = renderToStaticMarkup(<WorkflowListCardBody card={card} onRunCommand={() => {}} />)
  expect(html).toContain("<strong>Research and reproduce before implementation</strong>")
  expect(html).toContain("<span>issue.repro</span>")
  expect(html).toContain("<strong>lint</strong>")
})
