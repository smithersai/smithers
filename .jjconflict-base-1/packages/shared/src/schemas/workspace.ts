import { z } from "zod"

import { rootDirPolicySchema, smithersAuthModeSchema } from "./settings"

export const workspaceHealthStatusSchema = z.enum([
  "healthy",
  "degraded",
  "disconnected",
  "unknown",
])

export const workspaceSourceTypeSchema = z.enum(["local", "clone", "create"])
export const workspaceRuntimeModeSchema = z.enum(["burns-managed", "self-managed"])
export const workspaceDeleteModeSchema = z.enum(["unlink", "delete"])
export const workspaceServerProcessStateSchema = z.enum([
  "starting",
  "healthy",
  "crashed",
  "stopped",
  "self-managed",
  "disabled",
])

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  branch: z.string().optional(),
  repoUrl: z.string().optional(),
  defaultAgent: z.string().optional(),
  healthStatus: workspaceHealthStatusSchema.default("unknown"),
  sourceType: workspaceSourceTypeSchema,
  runtimeMode: workspaceRuntimeModeSchema.default("burns-managed"),
  smithersBaseUrl: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const workspaceServerStatusSchema = z.object({
  workspaceId: z.string(),
  runtimeMode: workspaceRuntimeModeSchema,
  processState: workspaceServerProcessStateSchema,
  lastHeartbeatAt: z.string().nullable(),
  restartCount: z.number().int().nonnegative(),
  crashCount: z.number().int().nonnegative(),
  port: z.number().int().positive().nullable(),
  baseUrl: z.string().nullable(),
})

export const workspaceSmithersManagementModeSchema = z.enum([
  "self-managed",
  "burns-managed",
  "disabled",
])

export const workspaceSmithersBaseUrlSourceSchema = z.enum([
  "workspace",
  "global-setting",
  "managed-instance",
  "pending-managed-instance",
])

export const workspaceSmithersRuntimeConfigSchema = z.object({
  workspaceId: z.string(),
  workspaceRuntimeMode: workspaceRuntimeModeSchema,
  managementMode: workspaceSmithersManagementModeSchema,
  baseUrl: z.string().nullable(),
  baseUrlSource: workspaceSmithersBaseUrlSourceSchema,
  allowNetwork: z.boolean(),
  rootDirPolicy: rootDirPolicySchema,
  smithersAuthMode: smithersAuthModeSchema,
  hasSmithersAuthToken: z.boolean(),
  canAutoRestart: z.boolean(),
})

export const localWorkflowDiscoveryItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  relativePath: z.string(),
  updatedAt: z.string().optional(),
})

export const localWorkflowDiscoveryResponseSchema = z.object({
  localPath: z.string(),
  workflows: z.array(localWorkflowDiscoveryItemSchema),
})

export const deleteWorkspaceInputSchema = z.object({
  mode: workspaceDeleteModeSchema,
})

export const deleteWorkspaceResultSchema = z.object({
  workspaceId: z.string(),
  mode: workspaceDeleteModeSchema,
  path: z.string(),
  filesDeleted: z.boolean(),
})

export const createWorkspaceInputSchema = z.discriminatedUnion("sourceType", [
  z.object({
    name: z.string().min(1),
    sourceType: z.literal("local"),
    localPath: z.string().min(1),
    defaultAgent: z.string().optional(),
    workflowTemplateIds: z.array(z.string()).optional(),
    runtimeMode: workspaceRuntimeModeSchema.optional(),
    smithersBaseUrl: z.string().optional(),
  }),
  z.object({
    name: z.string().min(1),
    sourceType: z.literal("clone"),
    repoUrl: z.string().min(1),
    targetFolder: z.string().min(1).optional(),
    defaultAgent: z.string().optional(),
    workflowTemplateIds: z.array(z.string()).optional(),
    runtimeMode: workspaceRuntimeModeSchema.optional(),
    smithersBaseUrl: z.string().optional(),
  }),
  z.object({
    name: z.string().min(1),
    sourceType: z.literal("create"),
    targetFolder: z.string().min(1).optional(),
    defaultAgent: z.string().optional(),
    workflowTemplateIds: z.array(z.string()).optional(),
    runtimeMode: workspaceRuntimeModeSchema.optional(),
    smithersBaseUrl: z.string().optional(),
  }),
])

export type Workspace = z.infer<typeof workspaceSchema>
export type WorkspaceHealthStatus = z.infer<typeof workspaceHealthStatusSchema>
export type WorkspaceSourceType = z.infer<typeof workspaceSourceTypeSchema>
export type WorkspaceRuntimeMode = z.infer<typeof workspaceRuntimeModeSchema>
export type WorkspaceDeleteMode = z.infer<typeof workspaceDeleteModeSchema>
export type WorkspaceServerProcessState = z.infer<typeof workspaceServerProcessStateSchema>
export type WorkspaceServerStatus = z.infer<typeof workspaceServerStatusSchema>
export type WorkspaceSmithersManagementMode = z.infer<typeof workspaceSmithersManagementModeSchema>
export type WorkspaceSmithersBaseUrlSource = z.infer<typeof workspaceSmithersBaseUrlSourceSchema>
export type WorkspaceSmithersRuntimeConfig = z.infer<typeof workspaceSmithersRuntimeConfigSchema>
export type LocalWorkflowDiscoveryItem = z.infer<typeof localWorkflowDiscoveryItemSchema>
export type LocalWorkflowDiscoveryResponse = z.infer<typeof localWorkflowDiscoveryResponseSchema>
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>
export type DeleteWorkspaceInput = z.infer<typeof deleteWorkspaceInputSchema>
export type DeleteWorkspaceResult = z.infer<typeof deleteWorkspaceResultSchema>
