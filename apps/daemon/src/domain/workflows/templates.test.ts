import { describe, expect, it } from "bun:test"

import { defaultWorkflowTemplates } from "@/domain/workflows/templates"

describe("default workflow templates", () => {
  it("ships production-leaning seeded workflows with explicit agent setup", () => {
    for (const template of defaultWorkflowTemplates) {
      expect(template.source).toContain('from "smithers-orchestrator"')
      expect(template.source).toContain("createSmithers")
      expect(template.source).toContain("ClaudeCodeAgent")
      expect(template.source).toContain("CodexAgent")
      expect(template.source).toContain("const SHARED_SYSTEM_PROMPT")
      expect(template.source).toContain("output={outputs.")
      expect(template.source).toContain("timeoutMs")
      expect(template.source).toContain("export default smithers((ctx) =>")
    }
  })

  it("keeps advanced control flow in the templates that need it", () => {
    const issueToPr = defaultWorkflowTemplates.find((template) => template.id === "issue-to-pr")
    const prFeedback = defaultWorkflowTemplates.find((template) => template.id === "pr-feedback")
    const approvalGate = defaultWorkflowTemplates.find((template) => template.id === "approval-gate")

    expect(issueToPr?.source).toContain("<Ralph")
    expect(prFeedback?.source).toContain("<Parallel>")
    expect(approvalGate?.source).toContain("needsApproval")
  })
})
