import { existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"

import type {
  CreateWorkspaceInput,
  DeleteWorkspaceInput,
  DeleteWorkspaceResult,
  Workspace,
} from "@burns/shared"

import { DEFAULT_AGENT } from "@/config/app-config"
import {
  deleteWorkspaceRowById,
  findWorkspaceRowById,
  insertWorkspaceRow,
  listWorkspaceRows,
} from "@/db/repositories/workspace-repository"
import { deleteApprovalRowsByWorkspaceId } from "@/db/repositories/approval-repository"
import { deleteRunEventRowsByWorkspaceId } from "@/db/repositories/run-event-repository"
import {
  assertDirectoryUsable,
  cloneRepository,
  getCurrentBranch,
  getOriginUrl,
  initRepository,
  isGitRepository,
} from "@/services/git-service"
import {
  dropWorkspaceSmithersRecord,
  startWorkspaceSmithersInBackground,
  stopWorkspaceSmithersServer,
} from "@/services/smithers-instance-service"
import { getSettings } from "@/services/settings-service"
import { ensureWorkspaceSmithersLayout } from "@/services/workspace-layout"
import { ensureDefaultWorkflowTemplates } from "@/services/workflow-service"
import { HttpError } from "@/utils/http-error"

function slugifyWorkspaceName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function ensureWorkflowDirectory(workspacePath: string) {
  ensureWorkspaceSmithersLayout(workspacePath)
}

function isPathWithinDirectory(targetPath: string, parentDirectory: string) {
  const resolvedParent = path.resolve(parentDirectory)
  const resolvedTarget = path.resolve(targetPath)
  const parentWithSeparator = resolvedParent.endsWith(path.sep)
    ? resolvedParent
    : `${resolvedParent}${path.sep}`

  return resolvedTarget === resolvedParent || resolvedTarget.startsWith(parentWithSeparator)
}

function resolveRelativeTargetFolder(targetFolder: string | undefined, workspaceId: string) {
  const { workspaceRoot } = getSettings()
  const trimmedTargetFolder = targetFolder?.trim() || workspaceId
  if (!trimmedTargetFolder) {
    throw new HttpError(400, "Target folder is required")
  }

  if (path.isAbsolute(trimmedTargetFolder)) {
    throw new HttpError(400, "Target folder must be relative to workspace root")
  }

  const resolvedPath = path.resolve(workspaceRoot, trimmedTargetFolder)
  if (!isPathWithinDirectory(resolvedPath, workspaceRoot)) {
    throw new HttpError(400, "Target folder must stay within workspace root")
  }

  return resolvedPath
}

function resolveWorkspacePath(input: CreateWorkspaceInput, workspaceId: string) {
  if (input.sourceType === "local") {
    const localPath = input.localPath.trim()
    if (!path.isAbsolute(localPath)) {
      throw new HttpError(400, "Local repository path must be absolute")
    }

    return path.resolve(localPath)
  }

  return resolveRelativeTargetFolder(input.targetFolder, workspaceId)
}

function assertWorkspacePathCanBeDeleted(workspacePath: string) {
  const resolvedWorkspacePath = path.resolve(workspacePath)
  const rootPath = path.parse(resolvedWorkspacePath).root

  if (resolvedWorkspacePath === rootPath) {
    throw new HttpError(400, "Refusing to delete a filesystem root path")
  }
}

function assertWorkspaceDoesNotExist(id: string, workspacePath: string) {
  const existingWorkspace = listWorkspaceRows().find(
    (workspace) => workspace.id === id || workspace.path === workspacePath
  )

  if (existingWorkspace) {
    throw new HttpError(409, `Workspace already exists: ${existingWorkspace.name}`)
  }
}

function createWorkspaceRecord(input: CreateWorkspaceInput, workspacePath: string): Workspace {
  const settings = getSettings()
  const id = slugifyWorkspaceName(input.name)
  const now = new Date().toISOString()
  const branch = getCurrentBranch(workspacePath)
  const repoUrl = input.sourceType === "clone" ? input.repoUrl : getOriginUrl(workspacePath)
  const runtimeMode = input.runtimeMode ?? "burns-managed"

  return {
    id,
    name: input.name,
    path: workspacePath,
    branch,
    repoUrl,
    defaultAgent: input.defaultAgent ?? settings.defaultAgent ?? DEFAULT_AGENT,
    healthStatus: existsSync(workspacePath) ? "healthy" : "disconnected",
    sourceType: input.sourceType,
    runtimeMode,
    smithersBaseUrl: runtimeMode === "self-managed" ? input.smithersBaseUrl : undefined,
    createdAt: now,
    updatedAt: now,
  }
}

export function initializeWorkspaceService() {
  void getSettings()
}

export function listWorkspaces() {
  return listWorkspaceRows()
}

export function getWorkspace(workspaceId: string) {
  return findWorkspaceRowById(workspaceId)
}

export function createWorkspace(input: CreateWorkspaceInput) {
  const workspaceId = slugifyWorkspaceName(input.name)
  if (!workspaceId) {
    throw new HttpError(400, "Workspace name must contain letters or numbers")
  }

  const workspacePath = resolveWorkspacePath(input, workspaceId)
  assertWorkspaceDoesNotExist(workspaceId, workspacePath)

  if (input.sourceType === "local") {
    if (!existsSync(workspacePath)) {
      throw new HttpError(400, `Local path does not exist: ${workspacePath}`)
    }

    if (!isGitRepository(workspacePath)) {
      throw new HttpError(400, `Local path is not a git repository: ${workspacePath}`)
    }
  }

  if (input.sourceType === "clone") {
    assertDirectoryUsable(workspacePath)
    cloneRepository(input.repoUrl, workspacePath)
  }

  if (input.sourceType === "create") {
    assertDirectoryUsable(workspacePath)
    mkdirSync(workspacePath, { recursive: true })
    initRepository(workspacePath)
  }

  ensureWorkflowDirectory(workspacePath)

  const workspace = createWorkspaceRecord(input, workspacePath)
  const persistedWorkspace = insertWorkspaceRow(workspace)

  if (
    input.runtimeMode === "burns-managed" &&
    Object.prototype.hasOwnProperty.call(input, "workflowTemplateIds")
  ) {
    ensureDefaultWorkflowTemplates(persistedWorkspace.id, input.workflowTemplateIds)
  }

  startWorkspaceSmithersInBackground(persistedWorkspace)

  return persistedWorkspace
}

export async function deleteWorkspace(
  workspaceId: string,
  input: DeleteWorkspaceInput
): Promise<DeleteWorkspaceResult> {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) {
    throw new HttpError(404, `Workspace not found: ${workspaceId}`)
  }

  await stopWorkspaceSmithersServer(workspaceId)
  dropWorkspaceSmithersRecord(workspaceId)

  if (input.mode === "delete") {
    assertWorkspacePathCanBeDeleted(workspace.path)
    rmSync(workspace.path, { recursive: true, force: true })
  }

  deleteApprovalRowsByWorkspaceId(workspaceId)
  deleteRunEventRowsByWorkspaceId(workspaceId)
  deleteWorkspaceRowById(workspaceId)

  return {
    workspaceId,
    mode: input.mode,
    path: workspace.path,
    filesDeleted: input.mode === "delete",
  }
}

export async function factoryResetWorkspaces() {
  const workspaces = listWorkspaceRows()

  for (const workspace of workspaces) {
    await deleteWorkspace(workspace.id, {
      mode: "unlink",
    })
  }

  return workspaces.length
}
