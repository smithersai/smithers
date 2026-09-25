import { z } from "zod"
import type { Card } from "./AppState"

/** Client request metadata uses the same persisted input slot as tutorial requests. */
export const WorkflowLaunchSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  owner: z.string(),
  repo: z.string(),
  workspaceId: z.string().optional(),
  workflow: z.string(),
  input: z.record(z.string(), z.unknown()),
  runId: z.string().optional(),
  preparationStartedAt: z.number().optional(),
  retryAt: z.number().optional(),
  /** A change request (change.request): a validated coding/request continues into coding/vibe. */
  then: z.literal("coding/vibe").optional(),
  /** The follow-up request this one started, so a reload never starts it twice. */
  next: z.string().optional(),
  error: z.object({ stage: z.enum(["preparation", "launch", "persistence"]), code: z.string(), message: z.string() }).optional()
})
export type WorkflowLaunch = z.infer<typeof WorkflowLaunchSchema>

export const workflowLaunchOf = (card: Card | undefined): WorkflowLaunch | undefined => {
  if (card?.kind !== "run-trace" || card.runtimeView?.revision !== undefined) return
  const parsed = WorkflowLaunchSchema.safeParse(card.payload.input?._workflowLaunch)
  return parsed.success && card.id === `flow-request-${parsed.data.id}` ? parsed.data : undefined
}

/** A flow's exact input stays separate from client metadata, including colliding keys. */
export const workflowInputOf = (card: Extract<Card, { kind: "run-trace" }>): Record<string, unknown> | undefined =>
  workflowLaunchOf(card)?.input ?? card.payload.input

export const pendingWorkflowLaunch = (card: Card | undefined): boolean => {
  const request = workflowLaunchOf(card)
  return request !== undefined && request.runId === undefined
}
