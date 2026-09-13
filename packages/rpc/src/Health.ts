/** Runtime-free mirror of @smthrs/control/Health.StatusRollup. Observations never grant authority. */
import { z } from "zod"

const counter = z.number().int().nonnegative()
export const StatusRollupSchema = z.object({
  subjectId: z.string(),
  state: z.enum(["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]),
  activity: z.enum(["working", "idle", "needs-input", "unknown"]),
  health: z.enum(["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]),
  attention: z.enum(["none", "awaiting-approval", "needs-input", "unhealthy"]),
  freshness: z.enum(["fresh", "stale", "unobserved"]),
  reason: z.enum(["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "unreachable", "probe-timeout", "probe-error", "owner-changed"]).optional(),
  provenance: z.object({ checkerId: z.string(), monitorId: z.string(), observedAt: counter, expiresAt: counter,
    evidenceSeq: counter, incarnation: z.string(), version: counter }).optional(),
  updatedAt: counter
})
export type StatusRollup = z.infer<typeof StatusRollupSchema>

export const PtyStatusFrameSchema = z.object({ type: z.literal("pty.status"), sessionId: z.string(), status: StatusRollupSchema })
  .refine((frame) => `session:${frame.sessionId}` === frame.status.subjectId, "Status must describe the subscribed session")
