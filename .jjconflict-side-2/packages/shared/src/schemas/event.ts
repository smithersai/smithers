import { z } from "zod"

export const runEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  runId: z.string(),
  type: z.string(),
  timestamp: z.string(),
  nodeId: z.string().optional(),
  message: z.string().optional(),
  rawPayload: z.unknown().optional(),
})

export type RunEvent = z.infer<typeof runEventSchema>
