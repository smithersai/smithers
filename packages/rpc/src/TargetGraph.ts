/**
 * Target node data carried by target cards.
 *
 * @since 1.0.0
 */

import { z } from "zod"

/** One node of the target graph: the loader row plus the plan facts the backend could resolve.
 * @since 1.0.0
 * @category schemas
 */
export const GraphNodeSchema = z.object({
  /** Canonical label, `//pkg/path:name`. */
  label: z.string(),
  package: z.string(),
  name: z.string(),
  /** Rule name as the loader prints it: `Shell.Test`, `Agent.Lint`, `Go.Binary`, ... */
  rule: z.string(),
  /** Flavor kinds (`build`, `test`, `lint`, `run`, `docs`); empty for pure data. */
  kinds: z.array(z.string()),
  /** Private (unlabeled) helper node reachable through an edge, e.g. `//src:__private_Overlay_4`. */
  private: z.boolean().default(false),
  /** Present when the backend planned the node (`--plan`). */
  plan: z
    .object({
      mode: z.enum(["execute", "check", "write"]).optional(),
      cacheable: z.boolean().optional(),
      /** The node's cache key as the planner prints it (64 hex chars, or a shorter preview); never a secret. */
      key: z.string().optional(),
      /** Typed refusal at plan time (host bin absent, approval required, missing input, NotImplemented). */
      refusal: z.string().optional(),
      argv: z.array(z.string()).optional(),
      sandbox: z.string().optional(),
      outDirs: z.array(z.string()).optional(),
      outFiles: z.array(z.string()).optional(),
      /** Input paths/globs when the CLI exposes them; used by affected analysis. */
      inputs: z.array(z.string()).optional()
    })
    .optional(),
  /** Declaration site for "open in editor". */
  source: z.object({ file: z.string(), line: z.number().optional() }).optional()
})
/**
 * The decoded value accepted by {@link GraphNodeSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type GraphNode = z.infer<typeof GraphNodeSchema>
