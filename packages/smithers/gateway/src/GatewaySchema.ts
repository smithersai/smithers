/**
 * Wire schemas shared by the gateway read path, subscriptions, and singleton
 * lifecycle.
 *
 * @since 0.1.0
 */
import { ControlSchema } from "@smthrs/control"
import { Schema } from "effect"
import * as GatewayProjection from "./GatewayProjection.ts"

/**
 * Workspace identity served by a gateway.
 *
 * @since 0.1.0
 * @category models
 */
export const Workspace = Schema.Struct({
  workspaceHash: Schema.String,
  workspacePath: Schema.String
})

/**
 * A workspace identity.
 *
 * @since 0.1.0
 * @category models
 */
export type Workspace = typeof Workspace.Type

/**
 * Gateway process configuration.
 *
 * @since 0.1.0
 * @category models
 */
export const GatewayConfig = Schema.Struct({
  workspace: Workspace,
  host: Schema.String,
  port: Schema.Number,
  protocolVersion: Schema.String,
  capabilities: Schema.optionalKey(Schema.Array(Schema.String))
})

/**
 * Gateway process configuration.
 *
 * @since 0.1.0
 * @category models
 */
export type GatewayConfig = typeof GatewayConfig.Type

/**
 * Runtime status of a gateway process.
 *
 * @since 0.1.0
 * @category models
 */
export const GatewayStatus = Schema.Struct({
  running: Schema.Boolean,
  url: Schema.NullOr(Schema.String),
  gatewayId: Schema.NullOr(Schema.String),
  startedAtMs: Schema.NullOr(Schema.Number)
})

/**
 * Runtime status of a gateway process.
 *
 * @since 0.1.0
 * @category models
 */
export type GatewayStatus = typeof GatewayStatus.Type

/**
 * Health response used to prove a singleton belongs to this workspace.
 *
 * @since 0.1.0
 * @category models
 */
export const GatewayHealth = Schema.Struct({
  workspaceHash: Schema.String,
  gatewayId: Schema.String,
  protocolVersion: Schema.String,
  capabilities: Schema.optionalKey(Schema.Array(Schema.String))
})

/**
 * Health response used for singleton identity probes.
 *
 * @since 0.1.0
 * @category models
 */
export type GatewayHealth = typeof GatewayHealth.Type

/**
 * Projection names served by the gateway read path.
 *
 * @since 0.1.0
 * @category models
 */
export const ProjectionName = Schema.Literals([
  "workspace-runs",
  "run-summary",
  "run-events",
  "transcript",
  "run-tree",
  "approvals",
  "node-output"
])

/**
 * A gateway projection name.
 *
 * @since 0.1.0
 * @category models
 */
export type ProjectionName = typeof ProjectionName.Type

/**
 * A selector for a workspace-wide run list.
 *
 * @since 0.1.0
 * @category models
 */
export const WorkspaceRunsSelector = Schema.TaggedStruct("workspace-runs", {})

/**
 * A selector for a workspace-wide run list.
 *
 * @since 0.1.0
 * @category models
 */
export type WorkspaceRunsSelector = typeof WorkspaceRunsSelector.Type

/**
 * A selector for one run's summary.
 *
 * @since 0.1.0
 * @category models
 */
export const RunSummarySelector = Schema.TaggedStruct("run-summary", { runId: Schema.String })

/**
 * A selector for one run's summary.
 *
 * @since 0.1.0
 * @category models
 */
export type RunSummarySelector = typeof RunSummarySelector.Type

/**
 * A selector for one run's ordered lifecycle events.
 *
 * @since 0.1.0
 * @category models
 */
export const RunEventsSelector = Schema.TaggedStruct("run-events", { runId: Schema.String })

/**
 * A selector for one run's ordered lifecycle events.
 *
 * @since 0.1.0
 * @category models
 */
export type RunEventsSelector = typeof RunEventsSelector.Type

/**
 * A selector for one run's transcript projection.
 *
 * @since 0.1.0
 * @category models
 */
export const TranscriptSelector = Schema.TaggedStruct("transcript", { runId: Schema.String })

/**
 * A selector for one run's transcript projection.
 *
 * @since 0.1.0
 * @category models
 */
export type TranscriptSelector = typeof TranscriptSelector.Type

/**
 * A selector for one run's flattened tree nodes.
 *
 * @since 0.1.0
 * @category models
 */
export const RunTreeSelector = Schema.TaggedStruct("run-tree", { runId: Schema.String })

/**
 * A selector for one run's flattened tree nodes.
 *
 * @since 0.1.0
 * @category models
 */
export type RunTreeSelector = typeof RunTreeSelector.Type

/**
 * A selector for approvals.
 *
 * Without `runId` it lists the workspace's pending gates, which is the
 * approvals inbox. With one it lists that run's gates including the decided
 * ones, which is what a run card renders: a gate a human already answered
 * still belongs on the card that asked.
 *
 * @since 0.1.0
 * @category models
 */
export const ApprovalsSelector = Schema.TaggedStruct("approvals", {
  runId: Schema.optional(Schema.String)
})

/**
 * A selector for approvals.
 *
 * @since 0.1.0
 * @category models
 */
export type ApprovalsSelector = typeof ApprovalsSelector.Type

/**
 * A selector for one node's output projection.
 *
 * @since 0.1.0
 * @category models
 */
export const NodeOutputSelector = Schema.TaggedStruct("node-output", {
  runId: Schema.String,
  nodeId: Schema.String
})

/**
 * A selector for one node's output projection.
 *
 * @since 0.1.0
 * @category models
 */
export type NodeOutputSelector = typeof NodeOutputSelector.Type

/**
 * A projection selected for a snapshot or watch subscription.
 *
 * @since 0.1.0
 * @category models
 */
export const ProjectionSelector = Schema.Union([
  WorkspaceRunsSelector,
  RunSummarySelector,
  RunEventsSelector,
  TranscriptSelector,
  RunTreeSelector,
  ApprovalsSelector,
  NodeOutputSelector
])

/**
 * A projection selected for a snapshot or watch subscription.
 *
 * @since 0.1.0
 * @category models
 */
export type ProjectionSelector = typeof ProjectionSelector.Type

/**
 * The row schema each selector answers with, so a client decodes a snapshot
 * instead of casting it.
 *
 * @param selector the selector whose row schema the client needs
 * @since 1.0.0
 * @category schemas
 */
export const rowSchemaFor = (selector: ProjectionSelector) => {
  switch (selector._tag) {
    case "workspace-runs":
    case "run-summary":
      return GatewayProjection.RunSummaryRow
    case "run-events":
      return ControlSchema.ControlEvent
    case "transcript":
      return GatewayProjection.TranscriptRow
    case "run-tree":
      return GatewayProjection.RunTreeRow
    case "approvals":
      return GatewayProjection.ApprovalRow
    case "node-output":
      return GatewayProjection.NodeOutputRow
  }
}

/**
 * A monotonic cursor for one projection and optional run scope.
 *
 * `runId` is null for workspace projections and records the source run for
 * per-run projections, even when a selector later gains more fields. Control
 * journal sequences belong to per-run partitions, so no workspace-wide
 * sequence exists. A workspace cursor therefore has value `0` and a null run,
 * and a workspace projection cannot resume from a cursor.
 *
 * @since 0.1.0
 * @category models
 */
export const ProjectionCursor = Schema.Struct({
  selector: ProjectionSelector,
  projection: ProjectionName,
  runId: Schema.NullOr(Schema.String),
  value: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
  ),
  offset: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
  )
})

/**
 * A monotonic projection cursor.
 *
 * @since 0.1.0
 * @category models
 */
export type ProjectionCursor = typeof ProjectionCursor.Type

/**
 * Every row one selector currently projects, and the cursor they were read
 * at. A client that follows the same selector from this cursor sees each
 * later change exactly once.
 *
 * @since 1.0.0
 * @category models
 */
export const ProjectionSnapshot = Schema.Union([
  Schema.Struct({
    selector: WorkspaceRunsSelector,
    cursor: ProjectionCursor,
    rows: Schema.Array(GatewayProjection.RunSummaryRow)
  }),
  Schema.Struct({
    selector: RunSummarySelector,
    cursor: ProjectionCursor,
    rows: Schema.Array(GatewayProjection.RunSummaryRow)
  }),
  Schema.Struct({
    selector: RunEventsSelector,
    cursor: ProjectionCursor,
    rows: Schema.Array(ControlSchema.ControlEvent)
  }),
  Schema.Struct({
    selector: TranscriptSelector,
    cursor: ProjectionCursor,
    rows: Schema.Array(GatewayProjection.TranscriptRow)
  }),
  Schema.Struct({
    selector: RunTreeSelector,
    cursor: ProjectionCursor,
    rows: Schema.Array(GatewayProjection.RunTreeRow)
  }),
  Schema.Struct({
    selector: ApprovalsSelector,
    cursor: ProjectionCursor,
    rows: Schema.Array(GatewayProjection.ApprovalRow)
  }),
  Schema.Struct({
    selector: NodeOutputSelector,
    cursor: ProjectionCursor,
    rows: Schema.Array(GatewayProjection.NodeOutputRow)
  })
])

/**
 * A projection snapshot and the cursor it was read at.
 *
 * @since 1.0.0
 * @category models
 */
export type ProjectionSnapshot = typeof ProjectionSnapshot.Type

/**
 * The start of a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export const SnapshotStartFrame = Schema.TaggedStruct("snapshot-start", {
  selector: ProjectionSelector,
  cursor: ProjectionCursor
})

/**
 * The start of a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export type SnapshotStartFrame = typeof SnapshotStartFrame.Type

/**
 * A row emitted during a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export const RowFrame = Schema.Union([
  Schema.TaggedStruct("row", {
    selector: WorkspaceRunsSelector,
    cursor: ProjectionCursor,
    row: GatewayProjection.RunSummaryRow
  }),
  Schema.TaggedStruct("row", {
    selector: RunSummarySelector,
    cursor: ProjectionCursor,
    row: GatewayProjection.RunSummaryRow
  }),
  Schema.TaggedStruct("row", {
    selector: RunEventsSelector,
    cursor: ProjectionCursor,
    row: ControlSchema.ControlEvent
  }),
  Schema.TaggedStruct("row", {
    selector: TranscriptSelector,
    cursor: ProjectionCursor,
    row: GatewayProjection.TranscriptRow
  }),
  Schema.TaggedStruct("row", {
    selector: RunTreeSelector,
    cursor: ProjectionCursor,
    row: GatewayProjection.RunTreeRow
  }),
  Schema.TaggedStruct("row", {
    selector: ApprovalsSelector,
    cursor: ProjectionCursor,
    row: GatewayProjection.ApprovalRow
  }),
  Schema.TaggedStruct("row", {
    selector: NodeOutputSelector,
    cursor: ProjectionCursor,
    row: GatewayProjection.NodeOutputRow
  })
])

/**
 * A row emitted during a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export type RowFrame = typeof RowFrame.Type

/**
 * The end of a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export const SnapshotEndFrame = Schema.TaggedStruct("snapshot-end", {
  selector: ProjectionSelector,
  cursor: ProjectionCursor
})

/**
 * The end of a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export type SnapshotEndFrame = typeof SnapshotEndFrame.Type

/**
 * A projection mutation after snapshot completion.
 *
 * `delta` replaces the selector's rows, except for the two append-only
 * projections: a `run-events` delta carries the one event that arrived and a
 * `transcript` delta carries the rows that event contributed, and a client
 * appends those to the rows it already holds.
 *
 * @since 0.1.0
 * @category models
 */
export const DeltaFrame = Schema.Union([
  Schema.TaggedStruct("delta", {
    selector: WorkspaceRunsSelector,
    cursor: ProjectionCursor,
    delta: Schema.Array(GatewayProjection.RunSummaryRow)
  }),
  Schema.TaggedStruct("delta", {
    selector: RunSummarySelector,
    cursor: ProjectionCursor,
    delta: Schema.Array(GatewayProjection.RunSummaryRow)
  }),
  Schema.TaggedStruct("delta", {
    selector: RunEventsSelector,
    cursor: ProjectionCursor,
    delta: Schema.Array(ControlSchema.ControlEvent)
  }),
  Schema.TaggedStruct("delta", {
    selector: TranscriptSelector,
    cursor: ProjectionCursor,
    delta: Schema.Array(GatewayProjection.TranscriptRow)
  }),
  Schema.TaggedStruct("delta", {
    selector: RunTreeSelector,
    cursor: ProjectionCursor,
    delta: Schema.Array(GatewayProjection.RunTreeRow)
  }),
  Schema.TaggedStruct("delta", {
    selector: ApprovalsSelector,
    cursor: ProjectionCursor,
    delta: Schema.Array(GatewayProjection.ApprovalRow)
  }),
  Schema.TaggedStruct("delta", {
    selector: NodeOutputSelector,
    cursor: ProjectionCursor,
    delta: Schema.Array(GatewayProjection.NodeOutputRow)
  })
])

/**
 * A projection mutation after snapshot completion.
 *
 * @since 0.1.0
 * @category models
 */
export type DeltaFrame = typeof DeltaFrame.Type

/**
 * A keepalive frame for an active subscription.
 *
 * @since 0.1.0
 * @category models
 */
export const HeartbeatFrame = Schema.TaggedStruct("heartbeat", { atMs: Schema.Number })

/**
 * A keepalive frame for an active subscription.
 *
 * @since 0.1.0
 * @category models
 */
export type HeartbeatFrame = typeof HeartbeatFrame.Type

/**
 * A frame sent by the gateway subscription protocol.
 *
 * @since 0.1.0
 * @category models
 */
export const GatewayFrame = Schema.Union([
  SnapshotStartFrame,
  ...RowFrame.members,
  SnapshotEndFrame,
  ...DeltaFrame.members,
  HeartbeatFrame
])

/**
 * A frame sent by the gateway subscription protocol.
 *
 * @since 0.1.0
 * @category models
 */
export type GatewayFrame = typeof GatewayFrame.Type

/**
 * On-disk state proving which gateway owns a workspace singleton.
 *
 * The session token is process-local capability material; it is never part of
 * a health response or token listing.
 *
 * @since 0.1.0
 * @category models
 */
export const SingletonRecord = Schema.Struct({
  gatewayId: Schema.String,
  workspaceHash: Schema.String,
  hostId: Schema.String,
  pid: Schema.Number,
  url: Schema.String,
  protocolVersion: Schema.String,
  startedAtMs: Schema.Number,
  sessionToken: Schema.String
})

/**
 * On-disk workspace gateway singleton state.
 *
 * @since 0.1.0
 * @category models
 */
export type SingletonRecord = typeof SingletonRecord.Type

/**
 * Gateway token permissions.
 *
 * @since 0.1.0
 * @category models
 */
export const TokenScope = Schema.Literals(["sync", "control", "tokens", "admin"])

/**
 * A gateway token permission.
 *
 * @since 0.1.0
 * @category models
 */
export type TokenScope = typeof TokenScope.Type

/**
 * An at-rest gateway token grant.
 *
 * `digest` is the one-way digest of the raw token. Raw bearer tokens must
 * never be persisted or returned after issuance.
 *
 * @since 0.1.0
 * @category models
 */
export const TokenRecord = Schema.Struct({
  id: Schema.String,
  workspaceHash: Schema.String,
  label: Schema.String,
  scopes: Schema.Array(TokenScope),
  digest: Schema.String,
  createdAtMs: Schema.Number,
  expiresAtMs: Schema.Number,
  revokedAtMs: Schema.optional(Schema.Number)
})

/**
 * An at-rest gateway token grant containing only a digest.
 *
 * @since 0.1.0
 * @category models
 */
export type TokenRecord = typeof TokenRecord.Type
