import { z } from "zod"
import type { Card } from "./AppState"

/** The exact reviewed registration the human approved, retained through launch recovery. */
export const TriggerRegistrationSchema = z.object({
  requestId: z.string(), flow: z.string(), slug: z.string(), schedule: z.string(), input: z.string(),
  tokens: z.number().optional(), minutes: z.number().optional(), planId: z.string(), planDigest: z.string()
})
export type TriggerRegistration = z.infer<typeof TriggerRegistrationSchema>

/** Client request metadata uses the same persisted input slot as tutorial requests. */
export const WorkflowLaunchSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  owner: z.string(),
  repo: z.string(),
  workspaceId: z.string().optional(),
  workflow: z.string(),
  input: z.record(z.string(), z.unknown()),
  /** A rerun is new work even while the original request is still being observed. */
  rerunOf: z.string().optional(),
  /** A schedule dispatch resolves and pins its registered input in the background. */
  triggerDispatch: z.object({ slug: z.string() }).optional(),
  triggerRegistration: TriggerRegistrationSchema.optional(),
  inputPrepared: z.literal(true).optional(),
  runId: z.string().optional(),
  preparationStartedAt: z.number().optional(),
  retryAt: z.number().optional(),
  /** A change request (change.request): a validated coding/request continues into coding/vibe. */
  then: z.literal("coding/vibe").optional(),
  /**
   * Where a change request starts: the caller's pushed ref `name`, asked for
   * (`explicit`) or their default head. `commitId` is set once preparation
   * pinned it as coding/request's base, null when there was none to use.
   */
  source: z.object({ name: z.string(), explicit: z.boolean(), commitId: z.string().nullable().optional() }).optional(),
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

/**
 * The pushed ref a change request started from, once preparation pinned it.
 * Read from the card's input itself: the run's later projection keeps it.
 */
export const launchSourceOf = (card: Card | undefined): string | undefined => {
  if (card?.kind !== "run-trace") return
  const launch = card.payload.input?._workflowLaunch
  const parsed = WorkflowLaunchSchema.shape.source.safeParse(typeof launch === "object" && launch !== null ? (launch as { source?: unknown }).source : undefined)
  return parsed.success && typeof parsed.data?.commitId === "string" ? parsed.data.name : undefined
}

/** A flow's exact input stays separate from client metadata, including colliding keys. */
export const workflowInputOf = (card: Extract<Card, { kind: "run-trace" }>): Record<string, unknown> | undefined =>
  workflowLaunchOf(card)?.input ?? card.payload.input

export const pendingWorkflowLaunch = (card: Card | undefined): boolean => {
  const request = workflowLaunchOf(card)
  return request !== undefined && request.runId === undefined
}
