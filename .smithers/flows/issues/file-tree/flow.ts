/**
 * `issues/file-tree`: files an issue import plan (`apps/mvp/ops/issues/import.mjs`) on smithers.sh as a tree of
 * sub-issues, durably, with machine tokens, so the App's bot is every issue's author (docs/features/machine-tokens.md).
 * The plan's order holds: the tree's nodes, then the agents' drafts, then the findings, then the `queue` work links of
 * the open merge-queue entries that name an issue. A queue entry is work, so it never files an issue.
 *
 * `verify` refuses a plan with unacknowledged dropped rows, a depth past 8, a node past 100 children, another owner or
 * an unknown parent, and a token that is not live. Then each round is one recorded attempt at one stage of one row:
 * submit `issue/create` and watch it settle, submit `issue/relate` under its parent and watch it, post its work links.
 * Nothing waits or retries inside an action; the round sleeps on the engine's durable timer between attempts. GitHub's
 * pace is the server's (`github/MachineDispatch`). A stopped run resumes at its last settled action, and an action cut off
 * mid-attempt runs again: its write id comes from the row's key, so it is the same write, found by its marker, closed
 * issues included, and never by title.
 *
 * ```sh
 * SMITHERS_ISSUE_TOKENS=<tokens.json> smthrs flow start issues/file-tree \
 *   --data '{"plan":"<plan.jsonl>","acceptDropped":1}' --wait
 * smthrs flow start issues/file-tree --data '{"plan":"<plan.jsonl>","acceptDropped":1,"dryRun":true}' --wait
 * smthrs runs resume <run>
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow, Sleep } from "@smthrs/flow"
import * as Fault from "@smthrs/flow/Fault"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { STAGES, step, verify } from "./steps.mjs"

/**
 * The plan, the identity or GitHub refused the run; the message names why, never a secret.
 *
 * @since 1.0.0
 * @category errors
 */
export class FileRefused extends Schema.TaggedError<FileRefused>()("issues/file-tree/Refused", {
  code: Schema.String,
  message: Schema.String
}) {}
Fault.register("issues/file-tree/Refused", "user")

const FileError = Schema.Union([FileRefused, Sleep.SleepRequestInvalid])




const Counts = Schema.Struct({ created: Schema.Number, linked: Schema.Number, queueLinks: Schema.Number, exceptions: Schema.Number })

/**
 * Where a round files from. Secrets never ride in it: the identity is read from the environment.
 *
 * @since 1.0.0
 * @category models
 */
export const Cursor = Schema.Struct({
  plan: Schema.String,
  sha: Schema.String,
  total: Schema.Number,
  index: Schema.Number,
  stage: Schema.Literals(["create", "link", "work"]),
  submitted: Schema.Boolean,
  attempt: Schema.Number,
  number: Schema.NullOr(Schema.Number),
  /** How long this round sleeps before its attempt. */
  waitMs: Schema.Number,
  /** Only nodes still referenced by an unprocessed row; settled mappings stay in the journal. */
  nodes: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)),
  dryRun: Schema.Boolean,
  origin: Schema.String,
  counts: Counts,
  exceptions: Schema.Array(Schema.String)
})

/**
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  plan: Schema.String,
  acceptDropped: Schema.optionalKey(Schema.Number),
  dryRun: Schema.optionalKey(Schema.Boolean),
  origin: Schema.optionalKey(Schema.String)
})

/**
 * What a run filed: counts per outcome and each exception, as `<row>:<stage>: <why>`.
 *
 * @since 1.0.0
 * @category models
 */
export const Report = Schema.Struct({
  filed: Schema.Number,
  counts: Counts,
  exceptions: Schema.Array(Schema.String),
  dryRun: Schema.Boolean
})

/**
 * One attempt's outcome.
 *
 * @since 1.0.0
 * @category models
 */
export const Outcome = Schema.Struct({
  number: Schema.NullOr(Schema.Number),
  submitted: Schema.Boolean,
  kind: Schema.String,
  /** How long the round sleeps before this stage's next attempt. */
  waitMs: Schema.Number,
  done: Schema.Boolean,
  exception: Schema.NullOr(Schema.String),
  /** The row's key when the row is a tree node others hang under; its number goes in the cursor's `nodes`. */
  nodeKey: Schema.NullOr(Schema.String),
  /** Completed mappings no remaining row needs. Absent in previously recorded outcomes. */
  forgetNodes: Schema.optionalKey(Schema.Array(Schema.String))
})

const implementationVersion = "issues/file-tree/v3"

/**
 * Maps what a step threw onto the flow's error, which the run keeps. A thrown step is a refusal: rate limits come back
 * as outcomes. Only a `Refused` names why, in words the steps chose; anything else keeps a fixed message, since its text
 * could quote the plan, a header or a file.
 */
const failure = (error: unknown): FileRefused =>
  error instanceof Error && error.name === "Refused" && "code" in error
    ? new FileRefused({ code: String((error as { code: unknown }).code), message: error.message })
    : new FileRefused({ code: "failed", message: "the step failed: an error the flow does not name" })

/**
 * @since 1.0.0
 * @category actions
 */
export const Verify = Action.make("issues/file-tree/verify", {
  implementationVersion,
  tier: "sealed",
  payload: Request,
  success: Schema.Struct({ sha: Schema.String, total: Schema.Number }),
  error: FileRefused,
  nondeterministic: true
})

/**
 * One attempt at one stage of one row, keyed by the plan, the row, the stage and the attempt: a resumed run that
 * finds it settled replays its outcome, and one cut off mid-attempt runs it again, finding its own write first.
 *
 * @since 1.0.0
 * @category actions
 */
export const Step = Action.make("issues/file-tree/step", {
  implementationVersion,
  tier: "irreversible",
  idempotencyKey: (cursor: typeof Cursor.Type) => `${cursor.sha}:${cursor.dryRun}:${cursor.index}:${cursor.stage}:${cursor.attempt}`,
  payload: Cursor,
  success: Outcome,
  error: FileRefused,
  nondeterministic: true
})

const run = <A>(thunk: () => Promise<A>) => Effect.tryPromise({ try: thunk, catch: failure })

/**
 * The actions' implementations, and the engine's durable sleep.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer = Layer.mergeAll(
  Verify.toLayer(
    (request) => run(() => verify({ plan: request.plan, acceptDropped: request.acceptDropped ?? 0, dryRun: request.dryRun === true, origin: request.origin ?? "https://smithers.sh" })),
    { implementationVersion }
  ),
  Step.toLayer((cursor) => run(() => step(cursor)), { implementationVersion }),
  Sleep.layer
)

/**
 * The cursor after one attempt: the same stage again, watching or after the server's wait, or the row's next stage, or
 * the next row.
 *
 * @since 1.0.0
 * @category utils
 */
export const advance = (cursor: typeof Cursor.Type, outcome: typeof Outcome.Type): typeof Cursor.Type => {
  const forgotten = new Set(outcome.forgetNodes ?? [])
  const nodes = Object.fromEntries(Object.entries(cursor.nodes).filter(([key]) => !forgotten.has(key)))
  if (!outcome.done) return { ...cursor, nodes, submitted: outcome.submitted, attempt: cursor.attempt + 1, waitMs: outcome.waitMs }
  const exception = outcome.exception === null ? [] : [`${cursor.index}:${cursor.stage}: ${outcome.exception}`]
  const number = cursor.stage === "create" ? outcome.number : cursor.number
  const nodeKey = cursor.stage === "create" ? outcome.nodeKey : null
  const counts = {
    created: cursor.counts.created + (cursor.stage === "create" && outcome.number !== null ? 1 : 0),
    linked: cursor.counts.linked + (cursor.stage === "link" && outcome.exception === null ? 1 : 0),
    queueLinks: cursor.counts.queueLinks + (outcome.kind === "queue-linked" ? 1 : 0),
    exceptions: cursor.counts.exceptions + exception.length
  }
  const base = {
    ...cursor,
    attempt: 0,
    submitted: false,
    waitMs: 0,
    counts,
    exceptions: [...cursor.exceptions, ...exception].slice(-500),
    nodes: nodeKey === null || forgotten.has(nodeKey) ? nodes : { ...nodes, [nodeKey]: number }
  }
  const nextStage = STAGES[STAGES.indexOf(cursor.stage) + 1] as typeof Cursor.Type["stage"] | undefined
  // A row with no issue has nothing to label, link or post.
  return nextStage === undefined || number === null
    ? { ...base, index: cursor.index + 1, stage: "create", number: null }
    : { ...base, stage: nextStage, number }
}

/** The first round's cursor. */
const start = (request: typeof Request.Type, verified: typeof Verify.successSchema.Type): typeof Cursor.Type => ({
  plan: request.plan,
  sha: verified.sha,
  total: verified.total,
  index: 0,
  stage: "create",
  submitted: false,
  attempt: 0,
  number: null,
  waitMs: 0,
  nodes: {},
  dryRun: request.dryRun === true,
  origin: request.origin ?? "https://smithers.sh",
  counts: { created: 0, linked: 0, queueLinks: 0, exceptions: 0 },
  exceptions: []
})

type RoundFlow = Flow.Flow<
  "issues/file-tree/round",
  typeof Cursor,
  typeof Report,
  typeof FileError,
  Action.Requirement<(typeof Step)["name"]>
>

/** One attempt: its durable sleep, the attempt, then the next round, or the report after the last. */
export const Round: RoundFlow = Flow.make("issues/file-tree/round", {
  payload: Cursor,
  success: Report,
  error: FileError,
  maxRounds: 1_000_000,
  body: Node.capture({ implementationVersion }, (cursor: typeof Cursor.Type) =>
    Sleep.action.call({ millis: cursor.waitMs }).pipe(
      Node.andThen(Step.call(cursor)),
      Node.map(Node.capture({ implementationVersion }, (outcome: typeof Outcome.Type) => advance(cursor, outcome))),
      Node.branch({
        if: Node.capture({ implementationVersion }, (next: typeof Cursor.Type) => next.index >= cursor.total),
        then: Node.capture({ implementationVersion }, (next) =>
          Flow.done({ filed: cursor.total, counts: next.counts, exceptions: next.exceptions, dryRun: cursor.dryRun })),
        else: Node.capture({ implementationVersion }, (next) => Round.to(next))
      })
    ))
})

export default Flow.make("issues/file-tree", {
  description: "File an issue import plan on smithers.sh as a tree of sub-issues, with machine tokens, resumable.",
  capabilities: ["fs:read:**", "net:get:**", "net:post:**"],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Report,
  error: FileError,
  body: Node.capture({ implementationVersion }, (request: typeof Request.Type) =>
    Verify.call(request).pipe(
      Node.map(Node.capture({ implementationVersion }, (verified: typeof Verify.successSchema.Type) => start(request, verified))),
      Node.bindPlanned(Node.capture({ implementationVersion }, (cursor) => Round.child(cursor)))
    ))
})
