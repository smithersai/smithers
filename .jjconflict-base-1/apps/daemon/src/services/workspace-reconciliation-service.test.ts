import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "bun:test"

import {
  deleteWorkspaceRowById,
  findWorkspaceRowById,
  insertWorkspaceRow,
} from "@/db/repositories/workspace-repository"
import { pruneMissingWorkspaces } from "@/services/workspace-reconciliation-service"
import { resolveTestWorkspacePath } from "@/testing/test-workspace-path"

const workspacePathsToDelete = new Set<string>()
const workspaceIdsToDelete = new Set<string>()

function seedWorkspace(params: { createPath: boolean }) {
  const workspaceId = `test-workspace-${randomUUID()}`
  const workspacePath = resolveTestWorkspacePath(workspaceId)
  const now = new Date().toISOString()

  if (params.createPath) {
    mkdirSync(workspacePath, { recursive: true })
  }

  insertWorkspaceRow({
    id: workspaceId,
    name: workspaceId,
    path: workspacePath,
    sourceType: "create",
    runtimeMode: "burns-managed",
    healthStatus: existsSync(workspacePath) ? "healthy" : "disconnected",
    createdAt: now,
    updatedAt: now,
  })

  workspacePathsToDelete.add(workspacePath)
  workspaceIdsToDelete.add(workspaceId)

  return { workspaceId, workspacePath }
}

afterEach(() => {
  for (const workspacePath of workspacePathsToDelete) {
    rmSync(workspacePath, { recursive: true, force: true })
  }
  workspacePathsToDelete.clear()
  for (const workspaceId of workspaceIdsToDelete) {
    deleteWorkspaceRowById(workspaceId)
  }
  workspaceIdsToDelete.clear()
})

describe("workspace reconciliation service", () => {
  it("removes missing workspaces from the Burns registry", async () => {
    const missingWorkspace = seedWorkspace({ createPath: false })
    const existingWorkspace = seedWorkspace({ createPath: true })

    const summary = await pruneMissingWorkspaces()

    expect(summary).toMatchObject({
      checkedWorkspaces: expect.any(Number),
      removedWorkspaces: 1,
      failedWorkspaces: 0,
    })
    expect(findWorkspaceRowById(missingWorkspace.workspaceId)).toBeNull()
    expect(findWorkspaceRowById(existingWorkspace.workspaceId)).toMatchObject({
      id: existingWorkspace.workspaceId,
    })
  })
})
