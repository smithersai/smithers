import { z } from "zod"

export const CommandIntentActorSchema = z.enum(["user", "smithers", "system"])
export const CommandIntentSourceSchema = z.enum(["command", "form", "automatic"])
export const CommandIntentOutcomeSchema = z.enum(["executed", "failed", "unknown-command", "unavailable", "form"])
const Position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** A durable permission to attempt one command, never an instruction for replay to execute. */
export const CommandIntentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  actor: CommandIntentActorSchema,
  source: CommandIntentSourceSchema,
  acceptedAt: z.number().finite(),
  acceptedRevision: Position,
  /** A digest of the durable chain call identity, never its input or authorization. */
  invocationKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  status: z.enum(["accepted", "settled"]),
  outcome: CommandIntentOutcomeSchema.optional(),
  /** A typed authorization refusal proved the target did not execute; another approval attempt is safe. */
  retryable: z.boolean().optional(),
  settledAt: z.number().finite().optional(),
  settledRevision: Position.optional()
}).strict().superRefine((row, context) => {
  const settled = row.outcome !== undefined && row.settledAt !== undefined && row.settledRevision !== undefined
  if (row.status === "settled" ? !settled : row.outcome !== undefined || row.settledAt !== undefined || row.settledRevision !== undefined) {
    context.addIssue({ code: "custom", message: "Command settlement must be complete and match its status" })
  }
  if (row.settledRevision !== undefined && row.settledRevision <= row.acceptedRevision) {
    context.addIssue({ code: "custom", message: "Command settlement must follow acceptance" })
  }
  if (row.retryable === true && (row.status !== "settled" || row.outcome !== "failed")) context.addIssue({ code: "custom", message: "Only a settled refusal can be retryable" })
})
export type CommandIntent = z.infer<typeof CommandIntentSchema>
export type CommandIntentOutcome = z.infer<typeof CommandIntentOutcomeSchema>
