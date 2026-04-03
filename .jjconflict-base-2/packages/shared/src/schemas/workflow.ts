import { z } from "zod"

export const workflowStatusSchema = z.enum(["draft", "active", "hot", "archived"])

export const workflowSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  relativePath: z.string(),
  status: workflowStatusSchema.default("draft"),
  updatedAt: z.string().optional(),
})

export const workflowDocumentSchema = workflowSchema.extend({
  source: z.string(),
})

export const workflowFileSchema = z.object({
  path: z.string(),
})

export const workflowFileListSchema = z.object({
  workflowId: z.string(),
  files: z.array(workflowFileSchema),
})

export const workflowFileDocumentSchema = z.object({
  workflowId: z.string(),
  path: z.string(),
  source: z.string(),
})

export const workflowLaunchFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.literal("string"),
})

export const workflowLaunchFieldsResponseSchema = z.object({
  workflowId: z.string(),
  mode: z.enum(["inferred", "fallback"]),
  entryTaskId: z.string().nullable(),
  fields: z.array(workflowLaunchFieldSchema),
  message: z.string().optional(),
})

export const workflowAuthoringStageSchema = z.enum([
  "preparing",
  "running-agent",
  "validating",
  "retrying",
  "completed",
])

export const workflowAuthoringStatusEventSchema = z.object({
  type: z.literal("status"),
  stage: workflowAuthoringStageSchema,
  message: z.string(),
  attempt: z.number().int().positive().optional(),
  totalAttempts: z.number().int().positive().optional(),
  timestamp: z.string(),
})

export const workflowAuthoringResultEventSchema = z.object({
  type: z.literal("result"),
  workflow: workflowDocumentSchema,
  timestamp: z.string(),
})

export const workflowAuthoringErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  timestamp: z.string(),
})

export const workflowAuthoringAgentOutputEventSchema = z.object({
  type: z.literal("agent-output"),
  stream: z.enum(["stdout", "stderr"]),
  chunk: z.string(),
  timestamp: z.string(),
})

export const workflowAuthoringAgentEventTypeSchema = z.enum(["started", "action", "completed"])
export const workflowAuthoringAgentEventLevelSchema = z.enum([
  "debug",
  "info",
  "warning",
  "error",
])
export const workflowAuthoringAgentActionPhaseSchema = z.enum([
  "started",
  "updated",
  "completed",
])
export const workflowAuthoringAgentActionKindSchema = z.enum([
  "turn",
  "command",
  "tool",
  "file_change",
  "web_search",
  "todo_list",
  "reasoning",
  "warning",
  "note",
])
export const workflowAuthoringAgentEntryTypeSchema = z.enum(["thought", "message"])

export const workflowAuthoringAgentEventSchema = z.object({
  type: z.literal("agent-event"),
  eventType: workflowAuthoringAgentEventTypeSchema,
  engine: z.string(),
  title: z.string().optional(),
  message: z.string().optional(),
  resume: z.string().optional(),
  phase: workflowAuthoringAgentActionPhaseSchema.optional(),
  actionId: z.string().optional(),
  actionKind: workflowAuthoringAgentActionKindSchema.optional(),
  entryType: workflowAuthoringAgentEntryTypeSchema.optional(),
  ok: z.boolean().optional(),
  answer: z.string().optional(),
  error: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  level: workflowAuthoringAgentEventLevelSchema.optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string(),
})

export const workflowAuthoringStreamEventSchema = z.discriminatedUnion("type", [
  workflowAuthoringStatusEventSchema,
  workflowAuthoringResultEventSchema,
  workflowAuthoringErrorEventSchema,
  workflowAuthoringAgentOutputEventSchema,
  workflowAuthoringAgentEventSchema,
])

export const updateWorkflowInputSchema = z.object({
  source: z.string(),
})

export type Workflow = z.infer<typeof workflowSchema>
export type WorkflowDocument = z.infer<typeof workflowDocumentSchema>
export type WorkflowFile = z.infer<typeof workflowFileSchema>
export type WorkflowFileList = z.infer<typeof workflowFileListSchema>
export type WorkflowFileDocument = z.infer<typeof workflowFileDocumentSchema>
export type WorkflowLaunchField = z.infer<typeof workflowLaunchFieldSchema>
export type WorkflowLaunchFieldsResponse = z.infer<typeof workflowLaunchFieldsResponseSchema>
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>
export type WorkflowAuthoringStage = z.infer<typeof workflowAuthoringStageSchema>
export type WorkflowAuthoringStatusEvent = z.infer<typeof workflowAuthoringStatusEventSchema>
export type WorkflowAuthoringResultEvent = z.infer<typeof workflowAuthoringResultEventSchema>
export type WorkflowAuthoringErrorEvent = z.infer<typeof workflowAuthoringErrorEventSchema>
export type WorkflowAuthoringAgentOutputEvent = z.infer<typeof workflowAuthoringAgentOutputEventSchema>
export type WorkflowAuthoringAgentEvent = z.infer<typeof workflowAuthoringAgentEventSchema>
export type WorkflowAuthoringStreamEvent = z.infer<typeof workflowAuthoringStreamEventSchema>
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowInputSchema>
