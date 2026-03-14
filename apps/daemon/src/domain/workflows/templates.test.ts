import { describe, expect, it } from "bun:test"

import { defaultWorkflowTemplates } from "@/domain/workflows/templates"

function getTemplateSource(templateId: string) {
  return defaultWorkflowTemplates.find((template) => template.id === templateId)?.source ?? ""
}

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
    const issueToPr = getTemplateSource("issue-to-pr")
    const prFeedback = getTemplateSource("pr-feedback")
    const approvalGate = getTemplateSource("approval-gate")

    expect(issueToPr).toContain("<Ralph")
    expect(prFeedback).toContain("<Ralph")
    expect(approvalGate).toContain("needsApproval")
  })

  it("keeps pr feedback fixes in a proper implement validate review loop", () => {
    const source = getTemplateSource("pr-feedback")

    expect(source).toContain('id="implement-fixes"')
    expect(source).toContain('id="validate-fixes"')
    expect(source).toContain('id="review-fixes"')
    expect(source).not.toContain("<Parallel>")

    const implementIndex = source.indexOf('id="implement-fixes"')
    const validateIndex = source.indexOf('id="validate-fixes"')
    const reviewIndex = source.indexOf('id="review-fixes"')

    expect(implementIndex).toBeGreaterThan(-1)
    expect(validateIndex).toBeGreaterThan(implementIndex)
    expect(reviewIndex).toBeGreaterThan(validateIndex)
    expect(source).toContain("Prior validation failures:")
    expect(source).toContain("Prior review findings:")
    expect(source).toContain("Focus on correctness, regressions, and any feedback that is still unaddressed.")
  })

  it("keeps the approval gate template production-oriented with preflight evidence and a final summary", () => {
    const source = getTemplateSource("approval-gate")

    expect(source).toContain("rollbackPlan")
    expect(source).toContain("blockers")
    expect(source).toContain("evidence")
    expect(source).toContain('id="summarize"')
    expect(source).toContain("Approve production deployment")
    expect(source).toContain("Return only JSON that matches the summarize schema.")
  })
})
