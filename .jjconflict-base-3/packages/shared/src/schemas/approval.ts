import { z } from "zod"

export const approvalStatusSchema = z.enum(["pending", "approved", "denied"])

export const approvalSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  label: z.string(),
  status: approvalStatusSchema,
  waitMinutes: z.number().int().nonnegative(),
  note: z.string().optional(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
})

export const approvalDecisionInputSchema = z.object({
  decidedBy: z.string().min(1),
  note: z.string().optional(),
})

export type Approval = z.infer<typeof approvalSchema>
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionInputSchema>
