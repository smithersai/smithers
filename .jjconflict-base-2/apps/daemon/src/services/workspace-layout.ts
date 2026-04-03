import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync } from "node:fs"
import path from "node:path"

import { REPOSITORY_ROOT } from "@/config/paths"

const WORKSPACE_SMITHERS_DIRECTORY = ".smithers"
const WORKSPACE_WORKFLOWS_DIRECTORY = "workflows"
const WORKSPACE_STATE_DIRECTORY = "state"
const MANAGED_SMITHERS_DB_BASENAME = "smithers.db"

function hasFilesystemEntry(targetPath: string) {
  try {
    lstatSync(targetPath)
    return true
  } catch {
    return false
  }
}

function ensureWorkspaceNodeModulesLink(workspacePath: string) {
  const workspaceNodeModulesPath = path.join(workspacePath, "node_modules")
  if (hasFilesystemEntry(workspaceNodeModulesPath)) {
    return
  }

  const daemonNodeModulesPath = path.join(REPOSITORY_ROOT, "node_modules")
  if (!existsSync(daemonNodeModulesPath)) {
    return
  }

  symlinkSync(daemonNodeModulesPath, workspaceNodeModulesPath, "dir")
}

function moveIfPresent(sourcePath: string, destinationPath: string) {
  if (!existsSync(sourcePath) || existsSync(destinationPath)) {
    return
  }

  mkdirSync(path.dirname(destinationPath), { recursive: true })
  renameSync(sourcePath, destinationPath)
}

function migrateLegacyDirectory(workspacePath: string, relativeSourcePath: string, relativeDestinationPath: string) {
  moveIfPresent(
    path.join(workspacePath, relativeSourcePath),
    path.join(workspacePath, relativeDestinationPath)
  )
}

function migrateLegacySmithersDatabaseFiles(workspacePath: string) {
  const stateDirectoryPath = getWorkspaceSmithersStateDirectory(workspacePath)

  for (const suffix of ["", "-shm", "-wal"]) {
    moveIfPresent(
      path.join(workspacePath, `${MANAGED_SMITHERS_DB_BASENAME}${suffix}`),
      path.join(stateDirectoryPath, `${MANAGED_SMITHERS_DB_BASENAME}${suffix}`)
    )
  }
}

export function getWorkspaceSmithersRoot(workspacePath: string) {
  return path.join(workspacePath, WORKSPACE_SMITHERS_DIRECTORY)
}

export function getWorkspaceWorkflowRootPath(workspacePath: string) {
  return path.join(getWorkspaceSmithersRoot(workspacePath), WORKSPACE_WORKFLOWS_DIRECTORY)
}

export function getWorkspaceSmithersStateDirectory(workspacePath: string) {
  return path.join(getWorkspaceSmithersRoot(workspacePath), WORKSPACE_STATE_DIRECTORY)
}

export function getManagedSmithersDbPath(workspacePath: string) {
  return path.join(getWorkspaceSmithersStateDirectory(workspacePath), MANAGED_SMITHERS_DB_BASENAME)
}

export function ensureWorkspaceSmithersLayout(workspacePath: string) {
  migrateLegacyDirectory(workspacePath, ".mr-burns/workflows", ".smithers/workflows")
  migrateLegacyDirectory(workspacePath, ".burns/workflows", ".smithers/workflows")
  migrateLegacyDirectory(workspacePath, ".mr-burns/state", ".smithers/state")
  migrateLegacyDirectory(workspacePath, ".burns/state", ".smithers/state")
  migrateLegacySmithersDatabaseFiles(workspacePath)

  const workflowRoot = getWorkspaceWorkflowRootPath(workspacePath)
  mkdirSync(workflowRoot, { recursive: true })
  mkdirSync(getWorkspaceSmithersStateDirectory(workspacePath), { recursive: true })
  ensureWorkspaceNodeModulesLink(workspacePath)

  return {
    smithersRoot: getWorkspaceSmithersRoot(workspacePath),
    workflowRoot,
    stateRoot: getWorkspaceSmithersStateDirectory(workspacePath),
    dbPath: getManagedSmithersDbPath(workspacePath),
  }
}
