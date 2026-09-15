import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { WorkflowListCardBody } from "./WorkflowCards"
import type { Card } from "../state/AppState"

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
