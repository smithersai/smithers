import { describe, expect, it } from "bun:test"

import {
  buildWorkflowEditPrompt,
  buildWorkflowGenerationPrompt,
  buildWorkflowRepairPrompt,
} from "@/services/workflow-service"

const guideLinks = [
  "https://smithers.sh/guides/tutorial-workflow",
  "https://smithers.sh/guides/patterns",
  "https://smithers.sh/guides/project-structure",
  "https://smithers.sh/guides/best-practices",
  "https://smithers.sh/guides/model-selection",
  "https://smithers.sh/guides/review-loop",
  "https://smithers.sh/guides/mdx-prompts",
  "https://smithers.sh/guides/structured-output",
  "https://smithers.sh/guides/error-handling",
]

const availableAgentClis = [
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    binaryPath: "/usr/local/bin/codex",
    logoProvider: "openai",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    binaryPath: "/usr/local/bin/claude",
    logoProvider: "anthropic",
  },
]

describe("workflow authoring prompts", () => {
  it("generation prompt includes Smithers guide digest and Burns constraints", () => {
    const prompt = buildWorkflowGenerationPrompt({
      workflowName: "Issue to PR",
      workflowId: "issue-to-pr",
      workspacePath: "/tmp/workspace",
      userPrompt: "Build a workflow",
      selectedAgentId: "codex",
      availableAgentClis,
    })

    expect(prompt).toContain("Smithers authoring guidance")
    expect(prompt).toContain("Smithers syntax quick reference")
    expect(prompt).toContain("Model and agent selection guidance (explicit)")
    expect(prompt).toContain("Codex (gpt-5.3-codex) — Implementation")
    expect(prompt).toContain("Claude Opus (claude-opus-4-6) — Planning and Review")
    expect(prompt).toContain("Claude Sonnet (claude-sonnet-4-5-20250929) — Simple Tasks")
    expect(prompt).toContain("CLI Agents vs AI SDK Agents")
    expect(prompt).toContain("ClaudeCodeAgent, CodexAgent, KimiAgent")
    expect(prompt).toContain("Feature implementation flow example")
    expect(prompt).toContain("Selected authoring CLI agent for this run: codex")
    expect(prompt).toContain("Installed CLI agents currently available on this machine")
    expect(prompt).toContain("codex | Codex | command: codex")
    expect(prompt).toContain("createSmithers")
    expect(prompt).toContain("output={outputs.<schemaKey>}")
    expect(prompt).toContain("Define reusable agents")
    expect(prompt).toContain("ClaudeCodeAgent")
    expect(prompt).toContain("CodexAgent")
    expect(prompt).toContain("<Ralph")
    for (const link of guideLinks) {
      expect(prompt).toContain(link)
    }
  })

  it("edit prompt includes Smithers guide digest and overwrite guidance", () => {
    const prompt = buildWorkflowEditPrompt({
      workflowName: "Issue to PR",
      workflowId: "issue-to-pr",
      workspacePath: "/tmp/workspace",
      relativeFilePath: ".smithers/workflows/issue-to-pr/workflow.tsx",
      userPrompt: "Add a review step",
      selectedAgentId: "codex",
      availableAgentClis,
    })

    expect(prompt).toContain("Smithers authoring guidance")
    expect(prompt).toContain("Smithers syntax quick reference")
    expect(prompt).toContain("Model and agent selection guidance (explicit)")
    expect(prompt).toContain("CLI Agents vs AI SDK Agents")
    expect(prompt).toContain("Feature implementation flow example")
    expect(prompt).toContain("Selected authoring CLI agent for this run: codex")
    expect(prompt).toContain("overwrite that same file")
    expect(prompt).toContain("output={outputs.<schemaKey>}")
    expect(prompt).toContain("shared prompt constants")
    expect(prompt).toContain("ClaudeCodeAgent")
    expect(prompt).toContain("CodexAgent")
    for (const link of guideLinks) {
      expect(prompt).toContain(link)
    }
  })

  it("repair prompt includes Smithers guide digest and validation context", () => {
    const prompt = buildWorkflowRepairPrompt({
      workflowName: "Issue to PR",
      workflowId: "issue-to-pr",
      workspacePath: "/tmp/workspace",
      relativeFilePath: ".smithers/workflows/issue-to-pr/workflow.tsx",
      userPrompt: "Fix my workflow",
      validationError: "Missing createSmithers",
      selectedAgentId: "codex",
      availableAgentClis,
    })

    expect(prompt).toContain("Smithers authoring guidance")
    expect(prompt).toContain("Smithers syntax quick reference")
    expect(prompt).toContain("Model and agent selection guidance (explicit)")
    expect(prompt).toContain("CLI Agents vs AI SDK Agents")
    expect(prompt).toContain("Feature implementation flow example")
    expect(prompt).toContain("Selected authoring CLI agent for this run: codex")
    expect(prompt).toContain("Validation error to fix")
    expect(prompt).toContain("output={outputs.<schemaKey>}")
    expect(prompt).toContain("define them explicitly")
    expect(prompt).toContain("ClaudeCodeAgent")
    expect(prompt).toContain("CodexAgent")
    for (const link of guideLinks) {
      expect(prompt).toContain(link)
    }
  })
})
