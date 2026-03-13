import { z } from "zod"

export const smithersAuthModeSchema = z.enum(["bearer", "x-smithers-key"])
export type SmithersAuthMode = z.infer<typeof smithersAuthModeSchema>

export const rootDirPolicySchema = z.enum(["workspace-root", "process-default"])
export type RootDirPolicy = z.infer<typeof rootDirPolicySchema>

export const diagnosticsLogLevelSchema = z.enum([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "silent",
])
export type DiagnosticsLogLevel = z.infer<typeof diagnosticsLogLevelSchema>

export const settingsSchema = z.object({
  workspaceRoot: z.string(),
  defaultAgent: z.string(),
  smithersBaseUrl: z.string(),
  allowNetwork: z.boolean().default(false),
  smithersManagedPerWorkspace: z.boolean().default(false),
  smithersAuthMode: smithersAuthModeSchema.default("bearer"),
  hasSmithersAuthToken: z.boolean().default(false),
  rootDirPolicy: rootDirPolicySchema.default("workspace-root"),
  diagnosticsLogLevel: diagnosticsLogLevelSchema.default("info"),
  diagnosticsPrettyLogs: z.boolean().default(false),
})

export type Settings = z.infer<typeof settingsSchema>

export const settingsReconcileSummarySchema = z.object({
  managedRuntimeSettingsChanged: z.boolean().default(false),
  managedModeChanged: z.boolean().default(false),
  affectedManagedWorkspaces: z.number().int().nonnegative().default(0),
  restartedManagedWorkspaces: z.number().int().nonnegative().default(0),
  stoppedManagedWorkspaces: z.number().int().nonnegative().default(0),
  daemonSettingsChanged: z.boolean().default(false),
  daemonRestartScheduled: z.boolean().default(false),
})

export type SettingsReconcileSummary = z.infer<typeof settingsReconcileSummarySchema>

export const settingsMutationResultSchema = z.object({
  settings: settingsSchema,
  reconcileSummary: settingsReconcileSummarySchema,
})

export type SettingsMutationResult = z.infer<typeof settingsMutationResultSchema>

export const updateSettingsInputSchema = z.object({
  workspaceRoot: z.string().trim().min(1),
  defaultAgent: z.string().trim().min(1),
  smithersBaseUrl: z.string().trim().min(1),
  allowNetwork: z.boolean().default(false),
  smithersManagedPerWorkspace: z.boolean().default(false),
  smithersAuthMode: smithersAuthModeSchema.default("bearer"),
  rootDirPolicy: rootDirPolicySchema.default("workspace-root"),
  diagnosticsLogLevel: diagnosticsLogLevelSchema.default("info"),
  diagnosticsPrettyLogs: z.boolean().default(false),
  smithersAuthToken: z.string().trim().min(1).optional(),
  clearSmithersAuthToken: z.boolean().default(false),
})

export type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>

export const onboardingStatusSchema = z.object({
  completed: z.boolean().default(false),
})

export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>

export const factoryResetResultSchema = z.object({
  ok: z.literal(true),
  deletedWorkspaceCount: z.number().int().nonnegative(),
})

export type FactoryResetResult = z.infer<typeof factoryResetResultSchema>
