import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"

import type { CreateWorkspaceInput, Workspace } from "@mr-burns/shared"

import { DEFAULT_AGENT } from "@/config/app-config"
import { DEFAULT_WORKSPACES_ROOT } from "@/config/paths"
import {
  countWorkspaces,
  findWorkspaceRowById,
  insertWorkspaceRow,
  listWorkspaceRows,
} from "@/db/repositories/workspace-repository"
import {
  assertDirectoryUsable,
  cloneRepository,
  getCurrentBranch,
  getOriginUrl,
  initRepository,
  isGitRepository,
} from "@/services/git-service"
import { ensureDefaultWorkflowTemplates } from "@/services/workflow-service"
import { getLogger } from "@/logging/logger"
import { HttpError } from "@/utils/http-error"

const logger = getLogger().child({ component: "workspace.service" })

function slugifyWorkspaceName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function ensureWorkflowDirectory(workspacePath: string) {
  mkdirSync(path.join(workspacePath, ".mr-burns", "workflows"), { recursive: true })
}

function resolveWorkspacePath(input: CreateWorkspaceInput, workspaceId: string) {
  if (input.sourceType === "local") {
    return path.resolve(input.localPath)
  }

  return path.resolve(DEFAULT_WORKSPACES_ROOT, input.targetFolder ?? workspaceId)
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
  const id = slugifyWorkspaceName(input.name)
  const now = new Date().toISOString()
  const branch = getCurrentBranch(workspacePath)
  const repoUrl = input.sourceType === "clone" ? input.repoUrl : getOriginUrl(workspacePath)

  return {
    id,
    name: input.name,
    path: workspacePath,
    branch,
    repoUrl,
    defaultAgent: input.defaultAgent ?? DEFAULT_AGENT,
    healthStatus: existsSync(workspacePath) ? "healthy" : "disconnected",
    sourceType: input.sourceType,
    createdAt: now,
    updatedAt: now,
  }
}

export function initializeWorkspaceService() {
  if (countWorkspaces() > 0) {
    return
  }

  try {
    createWorkspace({
      name: "burns-web-app",
      sourceType: "create",
      targetFolder: "burns-web-app",
      defaultAgent: DEFAULT_AGENT,
    })
  } catch (error) {
    logger.warn({ event: "workspace.seed_failed", err: error }, "Failed to seed initial workspace")
  }
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

  if (input.sourceType === "create") {
    ensureDefaultWorkflowTemplates(persistedWorkspace.id, input.workflowTemplateIds)
  }

  return persistedWorkspace
}
