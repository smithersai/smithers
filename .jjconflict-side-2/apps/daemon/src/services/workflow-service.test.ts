import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "bun:test"

import { deleteWorkspaceRowById, insertWorkspaceRow } from "@/db/repositories/workspace-repository"
import { ensureDefaultWorkflowTemplates } from "@/services/workflow-service"

const workspaceIdsToDelete = new Set<string>()
const workspacePathsToDelete = new Set<string>()

function createWorkspacePath() {
  const workspacePath = mkdtempSync(path.join(tmpdir(), "burns-workflow-service-"))
  workspacePathsToDelete.add(workspacePath)
  return workspacePath
}

function seedWorkspace(workspacePath: string) {
  const workspaceId = `test-workspace-${randomUUID()}`
  const now = new Date().toISOString()

  insertWorkspaceRow({
    id: workspaceId,
    name: workspaceId,
    path: workspacePath,
    sourceType: "create",
    runtimeMode: "burns-managed",
    healthStatus: "healthy",
    createdAt: now,
    updatedAt: now,
  })

  workspaceIdsToDelete.add(workspaceId)
  return workspaceId
}

afterEach(() => {
  for (const workspaceId of workspaceIdsToDelete) {
    deleteWorkspaceRowById(workspaceId)
  }
  workspaceIdsToDelete.clear()

  for (const workspacePath of workspacePathsToDelete) {
    rmSync(workspacePath, { recursive: true, force: true })
  }
  workspacePathsToDelete.clear()
})

describe("workflow service", () => {
  it("adds selected template workflows without overwriting existing workflows", () => {
    const workspacePath = createWorkspacePath()
    const workspaceId = seedWorkspace(workspacePath)
    const existingWorkflowPath = path.join(
      workspacePath,
      ".smithers",
      "workflows",
      "existing-flow",
      "workflow.tsx"
    )

    mkdirSync(path.dirname(existingWorkflowPath), { recursive: true })
    writeFileSync(existingWorkflowPath, "// existing workflow\n", "utf8")

    ensureDefaultWorkflowTemplates(workspaceId, ["pr-feedback"])

    expect(readFileSync(existingWorkflowPath, "utf8")).toBe("// existing workflow\n")
    expect(
      existsSync(path.join(workspacePath, ".smithers", "workflows", "pr-feedback", "workflow.tsx"))
    ).toBe(true)
    expect(
      existsSync(path.join(workspacePath, ".smithers", "workflows", "issue-to-pr", "workflow.tsx"))
    ).toBe(false)
  })
})
