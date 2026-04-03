import { readdirSync, rmSync } from "node:fs"
import path from "node:path"

import { DEFAULT_WORKSPACES_ROOT } from "@/config/paths"
import { db } from "@/db/client"

const TEST_WORKSPACE_ID_PREFIX = "test-workspace-"
const E2E_WORKSPACE_ID_PREFIX = "e2e-"

const TMP_ROOTS = [path.resolve("/tmp"), path.resolve("/private/tmp")]

type WorkspaceRow = {
  id: string
  path: string
}

export type TestWorkspaceCleanupSummary = {
  workspaceRowsDeleted: number
  approvalRowsDeleted: number
  runEventRowsDeleted: number
  directoriesDeleted: number
  deletedWorkspaceIds: string[]
  deletedDirectories: string[]
  skippedDirectories: string[]
  errors: string[]
}

function isPathWithinDirectory(targetPath: string, parentDirectory: string) {
  const resolvedParent = path.resolve(parentDirectory)
  const resolvedTarget = path.resolve(targetPath)
  const normalizedParent = resolvedParent.endsWith(path.sep)
    ? resolvedParent
    : `${resolvedParent}${path.sep}`

  return resolvedTarget === resolvedParent || resolvedTarget.startsWith(normalizedParent)
}

function isTestWorkspaceId(workspaceId: string) {
  return workspaceId.startsWith(TEST_WORKSPACE_ID_PREFIX)
}

function isE2eWorkspaceId(workspaceId: string) {
  return workspaceId.startsWith(E2E_WORKSPACE_ID_PREFIX)
}

function shouldDeleteWorkspacePath(workspaceId: string, workspacePath: string) {
  const resolvedPath = path.resolve(workspacePath)
  const directoryName = path.basename(resolvedPath)

  if (isTestWorkspaceId(workspaceId)) {
    if (!directoryName.startsWith(TEST_WORKSPACE_ID_PREFIX)) {
      return false
    }

    if (isPathWithinDirectory(resolvedPath, DEFAULT_WORKSPACES_ROOT)) {
      return true
    }

    return TMP_ROOTS.some((tmpRoot) => isPathWithinDirectory(resolvedPath, tmpRoot))
  }

  if (isE2eWorkspaceId(workspaceId)) {
    return (
      directoryName.startsWith(E2E_WORKSPACE_ID_PREFIX) &&
      isPathWithinDirectory(resolvedPath, DEFAULT_WORKSPACES_ROOT)
    )
  }

  return false
}

function listDirectories(rootPath: string) {
  try {
    return readdirSync(rootPath, { withFileTypes: true })
  } catch {
    return []
  }
}

function collectExtraDirectories() {
  const extraDirectories = new Set<string>()

  for (const tmpRoot of TMP_ROOTS) {
    const entries = listDirectories(tmpRoot)
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      if (entry.name.startsWith(TEST_WORKSPACE_ID_PREFIX)) {
        extraDirectories.add(path.join(tmpRoot, entry.name))
      }
    }
  }

  const workspaceEntries = listDirectories(DEFAULT_WORKSPACES_ROOT)
  for (const entry of workspaceEntries) {
    if (!entry.isDirectory()) {
      continue
    }

    if (
      entry.name.startsWith(TEST_WORKSPACE_ID_PREFIX) ||
      entry.name.startsWith(E2E_WORKSPACE_ID_PREFIX)
    ) {
      extraDirectories.add(path.join(DEFAULT_WORKSPACES_ROOT, entry.name))
    }
  }

  return extraDirectories
}

function removeDirectory(directoryPath: string) {
  rmSync(directoryPath, { recursive: true, force: true })
}

export function cleanupTestWorkspaceArtifacts(): TestWorkspaceCleanupSummary {
  const workspaceRows = db
    .query<WorkspaceRow, []>(
      `
        SELECT id, path
        FROM workspaces
        WHERE id LIKE 'test-workspace-%'
           OR id LIKE 'e2e-%'
      `
    )
    .all()

  const workspaceIds = workspaceRows.map((row) => row.id)

  const deleteApprovalByWorkspaceId = db.query(`DELETE FROM approvals WHERE workspace_id = ?1`)
  const deleteRunEventsByWorkspaceId = db.query(`DELETE FROM run_events WHERE workspace_id = ?1`)
  const deleteWorkspaceById = db.query(`DELETE FROM workspaces WHERE id = ?1`)

  let approvalRowsDeleted = 0
  let runEventRowsDeleted = 0
  let workspaceRowsDeleted = 0

  for (const workspaceId of workspaceIds) {
    approvalRowsDeleted += deleteApprovalByWorkspaceId.run(workspaceId).changes
    runEventRowsDeleted += deleteRunEventsByWorkspaceId.run(workspaceId).changes
    workspaceRowsDeleted += deleteWorkspaceById.run(workspaceId).changes
  }

  const skippedDirectories: string[] = []
  const deletedDirectories: string[] = []
  const errors: string[] = []
  const candidateDirectories = new Set<string>()

  for (const workspaceRow of workspaceRows) {
    if (shouldDeleteWorkspacePath(workspaceRow.id, workspaceRow.path)) {
      candidateDirectories.add(path.resolve(workspaceRow.path))
      continue
    }

    skippedDirectories.push(workspaceRow.path)
  }

  for (const directoryPath of collectExtraDirectories()) {
    candidateDirectories.add(path.resolve(directoryPath))
  }

  for (const directoryPath of candidateDirectories) {
    try {
      removeDirectory(directoryPath)
      deletedDirectories.push(directoryPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${directoryPath}: ${message}`)
    }
  }

  return {
    workspaceRowsDeleted,
    approvalRowsDeleted,
    runEventRowsDeleted,
    directoriesDeleted: deletedDirectories.length,
    deletedWorkspaceIds: workspaceIds,
    deletedDirectories,
    skippedDirectories,
    errors,
  }
}
