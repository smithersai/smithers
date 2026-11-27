import { CauseReceipt } from "@smthrs/app-core"
import {
  emptyPlanTree,
  evolvePlan,
  type PlanCommand,
  PlanEvent,
  PlanTree,
} from "@smthrs/app-state"
import { type ShardClient, ShardProtocol } from "@smthrs/sync"
import { Effect, Schema } from "effect"

// Shared wire schemas and pure reducers for a repository's durable Plan Tree shard
// (`worker/plan/PlanTreeShard.vibe`, `worker/plan/PlanTreeRoutes.vibe`, `worker/mcp/PlanTreeTools.vibe`,
// and `src/features/workbench/store.vibe`).

/** Durable app-core operation/query tags registered on every Plan Tree shard. */
export const PLAN_UPDATE_TAG = "plan/update"
export const PLAN_REVIEW_TAG = "plan/review"
export const PLAN_READ_TAG = "plan/tree"

/** One sequenced Plan Tree event with its causal receipt in the shard journal. */
export const PlanTreeRecordedEvent = Schema.Struct({
  event: PlanEvent,
  cause: CauseReceipt.CauseReceipt,
})
export type PlanTreeRecordedEvent = typeof PlanTreeRecordedEvent.Type

/** The compacted snapshot state stored in `DoSqliteShard` for a Plan Tree shard. */
export const PlanTreeSnapshotState = Schema.Struct({
  tree: PlanTree,
  receipts: Schema.Array(CauseReceipt.CauseReceipt),
})
export type PlanTreeSnapshotState = typeof PlanTreeSnapshotState.Type

/**
 * The wire response of `GET /api/repos/:owner/:repo/plan/snapshot`: protocol v2 `ShardPosition`
 * (`shard`, `epoch`, `seq`) plus `state`, which is `null` before the first compaction.
 */
export const PlanTreeSnapshotResponse = Schema.Struct({
  position: ShardProtocol.ShardPosition,
  state: Schema.NullOr(PlanTreeSnapshotState),
})
export type PlanTreeSnapshotResponse = typeof PlanTreeSnapshotResponse.Type

/** Caller-supplied idempotency key accepted on Plan Tree update commands. */
export const PlanIdempotencyKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
)
export type PlanIdempotencyKey = typeof PlanIdempotencyKey.Type

/** Structured output of the shard's `plan/tree` MCP query (`plan__tree`). */
export const PlanTreeReadMcpResult = Schema.Struct({
  rows: Schema.Array(PlanTree),
  cursor: Schema.String,
})
export type PlanTreeReadMcpResult = typeof PlanTreeReadMcpResult.Type

/** Structured output of the shard's `plan/update` MCP flow (`plan__update`). */
export const PlanTreeUpdateMcpResult = Schema.Struct({
  runId: Schema.String,
  outputRef: Schema.String,
  journalSeq: ShardProtocol.Seq,
  output: PlanEvent,
  cause: CauseReceipt.CauseReceipt,
})
export type PlanTreeUpdateMcpResult = typeof PlanTreeUpdateMcpResult.Type

/** Structured refusal content emitted by `@smthrs/app-core` `McpAdapter`. */
export const PlanTreeMcpErrorContent = Schema.Struct({
  code: Schema.String,
  target: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.String),
})
export type PlanTreeMcpErrorContent = typeof PlanTreeMcpErrorContent.Type

/** JSON-RPC 2.0 tool call envelope returned by `PlanTreeRoutes.handle` on `/api/plan/mcp`. */
export const PlanTreeMcpRpcEnvelope = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      isError: Schema.optional(Schema.Boolean),
      structuredContent: Schema.optional(Schema.Unknown),
    }),
  ),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.Number,
      message: Schema.String,
    }),
  ),
})
export type PlanTreeMcpRpcEnvelope = typeof PlanTreeMcpRpcEnvelope.Type

export const decodePlanTreeSnapshotState = Schema.decodeUnknownSync(PlanTreeSnapshotState)
export const decodePlanTreeRecordedEvent = Schema.decodeUnknownSync(PlanTreeRecordedEvent)
export const decodePlanEventJson = Schema.decodeUnknownSync(Schema.fromJsonString(PlanEvent))
export const decodeCauseReceiptJson = Schema.decodeUnknownSync(Schema.fromJsonString(CauseReceipt.CauseReceipt))
export const decodePlanTreeSnapshotResponse = Schema.decodeUnknownEffect(PlanTreeSnapshotResponse)
export const decodePlanTreePullResponse = Schema.decodeUnknownEffect(ShardProtocol.PullResponse)
export const decodePlanTreeMcpEnvelopeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PlanTreeMcpRpcEnvelope))
export const decodePlanTreeReadMcpResult = Schema.decodeUnknownEffect(PlanTreeReadMcpResult)
export const decodePlanTreeUpdateMcpResult = Schema.decodeUnknownEffect(PlanTreeUpdateMcpResult)
export const decodePlanTreeMcpErrorContent = Schema.decodeUnknownEffect(PlanTreeMcpErrorContent)

const decodeSnapshotStateEffect = Schema.decodeUnknownEffect(PlanTreeSnapshotState)
const decodeRecordedEventEffect = Schema.decodeUnknownEffect(PlanTreeRecordedEvent)

/** Canonical Plan Tree shard identifier (`repo:<owner>/<name>` lowercase), matching `PlanTreeRoutes.dispatch`. */
export const planShardId = (owner: string, repo: string): ShardProtocol.ShardId =>
  Schema.decodeUnknownSync(ShardProtocol.ShardId)(`repo:${owner.toLowerCase()}/${repo.toLowerCase()}`)

/** Builds the canonical repository Plan Tree snapshot URL (`GET /api/repos/:owner/:repo/plan/snapshot`). */
export const planSnapshotRoute = (origin: string, owner: string, repo: string): string => {
  const shard = planShardId(owner, repo)
  return `${origin}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/plan/snapshot?shard=${encodeURIComponent(shard)}`
}

/** Builds the canonical repository Plan Tree journal pull URL (`GET /api/repos/:owner/:repo/plan/pull`). */
export const planPullRoute = (
  origin: string,
  owner: string,
  repo: string,
  request: ShardProtocol.PullRequest,
): string =>
  `${origin}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/plan/pull?${ShardProtocol.pullQuery(request)}`

/** Person-only approval rule: finishing a plan node (`status: "done"`) is reserved for a person via `plan/review`. */
export const isPersonOnlyPlanCommand = (command: PlanCommand): boolean =>
  command._tag === "SetNodeStatus" && command.status === "done"

/** Folds one `ShardClient.Delivery` onto `tree` synchronously (used by the shard authority). */
export const applyPlanDelivery = (tree: PlanTree, delivery: ShardClient.Delivery): PlanTree => {
  if (delivery._tag === "Reset") {
    return delivery.snapshot.state === null ? emptyPlanTree : decodePlanTreeSnapshotState(delivery.snapshot.state).tree
  }
  return delivery.entries.reduce<PlanTree>(
    (state, entry) =>
      entry.events.reduce<PlanTree>(
        (current, event) => evolvePlan(current, decodePlanTreeRecordedEvent(event).event),
        state,
      ),
    tree,
  )
}

/** Folds one `ShardClient.Delivery` onto `tree` with typed schema decoding (used by untrusted HTTP clients). */
export const applyPlanDeliveryEffect = (
  tree: PlanTree,
  delivery: ShardClient.Delivery,
): Effect.Effect<PlanTree, Schema.SchemaError> => {
  if (delivery._tag === "Reset") {
    if (delivery.snapshot.state === null) return Effect.succeed(emptyPlanTree)
    return Effect.map(decodeSnapshotStateEffect(delivery.snapshot.state), (snapshot) => snapshot.tree)
  }
  const events = delivery.entries.flatMap((entry) => entry.events)
  return Effect.forEach(events, (raw) => decodeRecordedEventEffect(raw)).pipe(
    Effect.map((decoded) => decoded.reduce<PlanTree>((current, item) => evolvePlan(current, item.event), tree)),
  )
}
