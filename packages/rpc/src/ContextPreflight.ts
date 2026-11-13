/**
 * Host-owned context preflight contracts.
 *
 * @since 1.0.0
 */

import { z } from "zod"
import { ContextItemSchema } from "./CardPrimitives.ts"

/**
 * New selections always state their reason; historical lines remain readable.
 *
 * @since 1.0.0
 * @category schemas
 */
export const SelectedContextItemSchema = ContextItemSchema.extend({ reason: z.string().min(1) })
/**
 * Repository data, pinned by the provider before selection.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ContextCandidateSchema = z.object({
  item: ContextItemSchema.omit({ reason: true }).refine(
    (item) => item.kind !== "issue" && (item.kind !== "file" && item.kind !== "page" || Boolean(item.revision)),
    { message: "Preflight files and wiki pages need a pinned revision" }
  ),
  text: z.string()
}).strict()
/**
 * The SharedEntries provider supplies these values, never the browser.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ContextPreflightInputSchema = z.object({
  prompt: z.string().min(1),
  author: z.string().min(1),
  branch: z.string().min(1),
  state: z.string(),
  recent: z.array(z.object({ title: z.string(), summary: z.string().optional(), text: z.string() }).strict()),
  candidates: z.array(ContextCandidateSchema),
  tokenBudget: z.number().int().nonnegative().max(1000000).default(24000),
  wikiOnly: z.boolean().default(false)
}).strict()
/**
 * Stored as the first step's durable output.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ContextPreflightResultSchema = z.object({
  context: z.array(SelectedContextItemSchema),
  candidates: z.array(ContextItemSchema.omit({ reason: true })),
  model: z.string().min(1),
  durationMs: z.number().nonnegative()
}).strict()
/**
 * Pinned repository context.
 *
 * @since 1.0.0
 * @category models
 */
export type ContextCandidate = z.infer<typeof ContextCandidateSchema>
/**
 * Host-supplied selection input.
 *
 * @since 1.0.0
 * @category models
 */
export type ContextPreflightInput = z.infer<typeof ContextPreflightInputSchema>
/**
 * Durable context selection output.
 *
 * @since 1.0.0
 * @category models
 */
export type ContextPreflightResult = z.infer<typeof ContextPreflightResultSchema>

/**
 * Numbered pages of one durable preflight phase. Old unpaged frames remain readable.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ContextPreflightPageSchema = z.object({
  index: z.number().int().nonnegative(),
  total: z.number().int().positive()
}).strict().refine((page) => page.index < page.total)
/**
 * One journal frame; a paged frame always names its phase.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ContextPreflightFrameSchema = z.object({
  runId: z.string(),
  type: z.literal("context.preflight"),
  phase: z.enum(["started", "completed"]).optional(),
  page: ContextPreflightPageSchema.optional(),
  // Optional for replay of frames recorded before host timing was available.
  at: z.number().finite().nonnegative().optional(),
  clock: z.string().regex(/^host monotonic:.+$/).optional(),
  result: ContextPreflightResultSchema
}).refine((frame) => frame.page === undefined || frame.phase !== undefined)
  .refine((frame) => (frame.at === undefined) === (frame.clock === undefined))
/**
 * One durable preflight journal frame.
 *
 * @since 1.0.0
 * @category models
 */
export type ContextPreflightFrame = z.infer<typeof ContextPreflightFrameSchema>
