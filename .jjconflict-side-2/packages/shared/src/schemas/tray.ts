import { z } from "zod"

export const burnsTrayPendingTargetSchema = z.union([
  z.object({
    kind: z.literal("inbox"),
  }),
  z.object({
    kind: z.literal("run"),
    workspaceId: z.string(),
    runId: z.string(),
  }),
])

export const burnsTrayStatusSchema = z.object({
  pendingCount: z.number().int().nonnegative(),
  runningCount: z.number().int().nonnegative(),
  pendingTarget: burnsTrayPendingTargetSchema.nullable(),
})

export type BurnsTrayPendingTarget = z.infer<typeof burnsTrayPendingTargetSchema>
export type BurnsTrayStatus = z.infer<typeof burnsTrayStatusSchema>
