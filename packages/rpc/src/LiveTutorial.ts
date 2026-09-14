import { z } from "zod"
import { DiffFileSchema } from "./Changes.ts"

export const LiveTutorialOperationSchema = z.enum(["research", "plan", "implement", "change", "poc"])
export type LiveTutorialOperation = z.infer<typeof LiveTutorialOperationSchema>
export const LiveTutorialPlanSchema = z.object({
  id: z.string(), title: z.string(), summary: z.string(), baseCommitId: z.string(),
  steps: z.array(z.string()), files: z.array(z.string()),
})
export type LiveTutorialPlan = z.infer<typeof LiveTutorialPlanSchema>
export const LiveTutorialCommitSchema = z.object({
  commitId: z.string(), parentCommitId: z.string(), message: z.string(), files: z.array(z.string()),
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
})
export const LiveTutorialEventSchema = z.object({
  id: z.string(), label: z.string(), status: z.enum(["running", "completed", "failed"]),
  startedAt: z.number(), finishedAt: z.number().optional(), detail: z.string().optional(),
})
export const LiveTutorialRunSchema = z.object({
  sessionId: z.string(), runId: z.string(), operation: LiveTutorialOperationSchema,
  phase: z.enum(["queued", "running", "completed", "failed"]),
  createdAt: z.number(), updatedAt: z.number(), events: z.array(LiveTutorialEventSchema),
  error: z.string().optional(), result: z.string().optional(),
  plan: LiveTutorialPlanSchema.optional(), commits: z.array(LiveTutorialCommitSchema).optional(),
  diff: z.array(DiffFileSchema).optional(), files: z.record(z.string(), z.string()).optional(),
  branch: z.string().optional(), baseCommitId: z.string().optional(),
  tests: z.object({ command: z.string(), exitCode: z.number(), output: z.string() }).optional(),
  change: z.object({ id: z.string(), title: z.string(), summary: z.string(), commitIds: z.array(z.string()), baseCommitId: z.string() }).optional(),
})
export type LiveTutorialRun = z.infer<typeof LiveTutorialRunSchema>
export const LiveTutorialStartSchema = z.object({
  idempotencyKey: z.string().min(1).max(128), playthrough: z.number().int().nonnegative(),
  planId: z.string().optional(), commitIds: z.array(z.string()).max(20).optional(),
})
export type LiveTutorialStart = z.infer<typeof LiveTutorialStartSchema>
export const LIVE_TUTORIAL_API = "/api/tutorial/live"
