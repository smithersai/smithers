/**
 * HTTP contracts for the live tutorial: the agent runs the onboarding tutorial
 * starts against its practice repository.
 *
 * The app never reaches the tutorial coordinator directly. It posts an
 * operation to {@link LIVE_TUTORIAL_API} on the product origin; the Worker
 * holds the anonymous tutorial session and the service token, and forwards
 * the request to the coordinator. The coordinator records a
 * {@link LiveTutorialRun} before it does any work and answers that record, so
 * the app polls the run by id until it leaves `queued` or `running`. A reload
 * re-posts the same {@link LiveTutorialStart} and gets the same run back
 * instead of starting the agent again.
 *
 * @since 1.0.0
 */
import { z } from "zod"
import { DiffFileSchema } from "./Changes.ts"

/**
 * The actions a live tutorial run performs. Within one playthrough the
 * coordinator enforces their order: a completed `research` before `plan`, the
 * latest completed `plan` before `implement`, and a completed `implement`
 * before `change`. `poc` prototypes the fix in its own disposable repository
 * and waits on nothing. Only one run per playthrough may be queued or running.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LiveTutorialOperationSchema = z.enum(["research", "plan", "implement", "change", "poc"])
/**
 * The decoded value accepted by {@link LiveTutorialOperationSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LiveTutorialOperation = z.infer<typeof LiveTutorialOperationSchema>
/**
 * The plan a `plan` run produces: its ordered steps and the practice files it
 * intends to edit, read at `baseCommitId`. `id` is the planning run's id. An
 * `implement` run must quote it back as `planId`, and refuses when the
 * repository head is no longer `baseCommitId`.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LiveTutorialPlanSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  baseCommitId: z.string(),
  steps: z.array(z.string()),
  files: z.array(z.string())
})
/**
 * The decoded value accepted by {@link LiveTutorialPlanSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LiveTutorialPlan = z.infer<typeof LiveTutorialPlanSchema>
/**
 * One commit an `implement` run made after its tests passed, with the files it
 * touched and the line counts the commit picker shows. A `change` run carries
 * a subset of these, named by `commitId`.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LiveTutorialCommitSchema = z.object({
  commitId: z.string(),
  parentCommitId: z.string(),
  message: z.string(),
  files: z.array(z.string()),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative()
})
/**
 * One step of a run's trace, such as reading the repository or running the
 * tests. `label` is the line the run card shows. `detail` is the step's
 * output, cut to at most 24,000 characters, so it is an excerpt and never a
 * full log.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LiveTutorialEventSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  detail: z.string().optional()
})
/**
 * The durable record of one live tutorial run, and the body of every
 * successful answer from {@link LIVE_TUTORIAL_API}. `phase` moves from `queued` through
 * `running` to `completed` or `failed`; `error` is set only on `failed`. The
 * optional fields fill in as the run reaches them, so a reader checks the
 * field it needs. `plan` comes from `plan` and `implement` runs, `commits`
 * from `implement` and `change` runs, and `change` from a `change` run alone.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LiveTutorialRunSchema = z.object({
  sessionId: z.string(),
  runId: z.string(),
  operation: LiveTutorialOperationSchema,
  phase: z.enum(["queued", "running", "completed", "failed"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  events: z.array(LiveTutorialEventSchema),
  error: z.string().optional(),
  result: z.string().optional(),
  plan: LiveTutorialPlanSchema.optional(),
  commits: z.array(LiveTutorialCommitSchema).optional(),
  diff: z.array(DiffFileSchema).optional(),
  files: z.record(z.string(), z.string()).optional(),
  branch: z.string().optional(),
  baseCommitId: z.string().optional(),
  tests: z.object({ command: z.string(), exitCode: z.number(), output: z.string() }).optional(),
  change: z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    commitIds: z.array(z.string()),
    baseCommitId: z.string()
  }).optional()
})
/**
 * The decoded value accepted by {@link LiveTutorialRunSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LiveTutorialRun = z.infer<typeof LiveTutorialRunSchema>
/**
 * The body that starts one operation. The coordinator keeps one run per
 * session, `playthrough`, and `idempotencyKey`, so a repeated post answers the
 * existing run, and a replayed tutorial, with its higher `playthrough`, starts
 * the ordering over. `planId` names the plan an `implement` run builds;
 * `commitIds` names the commits a `change` run carries, all of them when
 * absent.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LiveTutorialStartSchema = z.object({
  idempotencyKey: z.string().min(1).max(128),
  playthrough: z.number().int().nonnegative(),
  planId: z.string().optional(),
  commitIds: z.array(z.string()).max(20).optional()
})
/**
 * The decoded value accepted by {@link LiveTutorialStartSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LiveTutorialStart = z.infer<typeof LiveTutorialStartSchema>
/**
 * The live tutorial route family on the product origin.
 * `POST {LIVE_TUTORIAL_API}/{operation}` takes a {@link LiveTutorialStart} and
 * answers the run it recorded; `GET {LIVE_TUTORIAL_API}/run/{runId}` answers
 * that run's current state.
 *
 * @since 1.0.0
 * @category constants
 */
export const LIVE_TUTORIAL_API = "/api/tutorial/live"
