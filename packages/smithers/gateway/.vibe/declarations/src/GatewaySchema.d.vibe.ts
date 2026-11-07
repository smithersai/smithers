/**
 * Wire schemas shared by the gateway read path, subscriptions, and singleton
 * lifecycle.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
/**
 * Health response used to prove a singleton belongs to this workspace.
 *
 * @since 0.1.0
 * @category models
 */
export declare const GatewayHealth: Schema.Struct<{
    readonly workspaceHash: Schema.String;
    readonly gatewayId: Schema.String;
    readonly protocolVersion: Schema.String;
    readonly capabilities: Schema.optionalKey<Schema.$Array<Schema.String>>;
}>;
/**
 * Health response used for singleton identity probes.
 *
 * @since 0.1.0
 * @category models
 */
export type GatewayHealth = typeof GatewayHealth.Type;
/**
 * A selector for a workspace-wide run list.
 *
 * @since 0.1.0
 * @category models
 */
export declare const WorkspaceRunsSelector: Schema.TaggedStruct<"workspace-runs", {
    readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
}>;
/**
 * A selector for a workspace-wide run list.
 *
 * @since 0.1.0
 * @category models
 */
export type WorkspaceRunsSelector = typeof WorkspaceRunsSelector.Type;
/**
 * A selector for one run's summary.
 *
 * @since 0.1.0
 * @category models
 */
export declare const RunSummarySelector: Schema.TaggedStruct<"run-summary", {
    readonly runId: Schema.String;
}>;
/**
 * A selector for one run's summary.
 *
 * @since 0.1.0
 * @category models
 */
export type RunSummarySelector = typeof RunSummarySelector.Type;
/**
 * A selector for one run's ordered lifecycle events.
 *
 * @since 0.1.0
 * @category models
 */
export declare const RunEventsSelector: Schema.TaggedStruct<"run-events", {
    readonly runId: Schema.String;
}>;
/**
 * A selector for one run's ordered lifecycle events.
 *
 * @since 0.1.0
 * @category models
 */
export type RunEventsSelector = typeof RunEventsSelector.Type;
/**
 * A selector for one run's transcript projection.
 *
 * @since 0.1.0
 * @category models
 */
export declare const TranscriptSelector: Schema.TaggedStruct<"transcript", {
    readonly runId: Schema.String;
}>;
/**
 * A selector for one run's transcript projection.
 *
 * @since 0.1.0
 * @category models
 */
export type TranscriptSelector = typeof TranscriptSelector.Type;
/**
 * A selector for one run's flattened tree nodes.
 *
 * @since 0.1.0
 * @category models
 */
export declare const RunTreeSelector: Schema.TaggedStruct<"run-tree", {
    readonly runId: Schema.String;
}>;
/**
 * A selector for one run's flattened tree nodes.
 *
 * @since 0.1.0
 * @category models
 */
export type RunTreeSelector = typeof RunTreeSelector.Type;
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
export declare const ApprovalsSelector: Schema.TaggedStruct<"approvals", {
    readonly runId: Schema.optional<Schema.String>;
}>;
/**
 * A selector for approvals.
 *
 * @since 0.1.0
 * @category models
 */
export type ApprovalsSelector = typeof ApprovalsSelector.Type;
/**
 * A selector for one node's output projection.
 *
 * @since 0.1.0
 * @category models
 */
export declare const NodeOutputSelector: Schema.TaggedStruct<"node-output", {
    readonly runId: Schema.String;
    readonly nodeId: Schema.String;
}>;
/**
 * A selector for one node's output projection.
 *
 * @since 0.1.0
 * @category models
 */
export type NodeOutputSelector = typeof NodeOutputSelector.Type;
/**
 * A selector for one flow's measured node durations.
 *
 * This is the one projection that is neither a workspace listing nor scoped
 * to a run: it folds the history of one flow across the runs that executed
 * it, which is what makes it a prediction rather than a report.
 *
 * @since 0.1.0
 * @category models
 */
export declare const FlowDurationsSelector: Schema.TaggedStruct<"flow-durations", {
    readonly flowId: Schema.String;
}>;
/**
 * A selector for one flow's measured node durations.
 *
 * @since 0.1.0
 * @category models
 */
export type FlowDurationsSelector = typeof FlowDurationsSelector.Type;
/**
 * The row schema each served selector answers with.
 *
 * This table is the selector-to-row pairing, and it exists once. The selector
 * union, the projection names, `rowSchemaFor`, `ProjectionSnapshot`,
 * `RowFrame`, and `DeltaFrame` all derive from it, so serving one more
 * projection is one more entry here rather than five mirrored lists that can
 * disagree with each other.
 */
declare const served: readonly [readonly [Schema.TaggedStruct<"workspace-runs", {
    readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
}>, Schema.Struct<{
    readonly runId: Schema.String;
    readonly flowId: Schema.String;
    readonly statusRollup: Schema.optional<Schema.Struct<{
        readonly subjectId: Schema.String;
        readonly state: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
        readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
        readonly health: Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
        readonly attention: Schema.Literals<readonly ["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"]>;
        readonly freshness: Schema.Literals<readonly ["fresh", "stale", "unobserved"]>;
        readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
        readonly provenance: Schema.optional<Schema.Struct<{
            readonly checkerId: Schema.String;
            readonly monitorId: Schema.String;
            readonly observedAt: Schema.Int;
            readonly expiresAt: Schema.Int;
            readonly evidenceSeq: Schema.Int;
            readonly incarnation: Schema.String;
            readonly version: Schema.Int;
        }>>;
        readonly updatedAt: Schema.Int;
    }>>;
    readonly status: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>;
    readonly lifecycleProvenance: Schema.optional<Schema.Struct<{
        readonly control: Schema.Literals<readonly ["events", "legacy-snapshot", "unverified-snapshot"]>;
        readonly execution: Schema.Literals<readonly ["control", "engine-observed", "engine-missing"]>;
        readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
        readonly fromSequence: Schema.optional<Schema.Number>;
        readonly throughSequence: Schema.optional<Schema.Number>;
    }>>;
    readonly executionProvenance: Schema.optional<Schema.Struct<{
        readonly source: Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>;
        readonly rootExecutionId: Schema.String;
        readonly humanWaits: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
        readonly humanWaitSources: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly executionId: Schema.String;
            readonly generation: Schema.Number;
            readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
            readonly fromSequence: Schema.Number;
            readonly throughSequence: Schema.Number;
        }>>>;
        readonly currentExecutionId: Schema.optional<Schema.String>;
        readonly generation: Schema.optional<Schema.Number>;
        readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
        readonly fromSequence: Schema.optional<Schema.Number>;
        readonly throughSequence: Schema.optional<Schema.Number>;
    }>>;
    readonly createdAt: Schema.Number;
    readonly updatedAt: Schema.Number;
    readonly planId: Schema.optional<Schema.String>;
    readonly planDigest: Schema.optional<Schema.String>;
    readonly parentRunId: Schema.optional<Schema.String>;
    readonly lineageId: Schema.optional<Schema.String>;
    readonly roundOrdinal: Schema.optional<Schema.Number>;
    readonly waitingReason: Schema.optional<Schema.String>;
    readonly steeringPending: Schema.optional<Schema.Number>;
    readonly cancellation: Schema.optional<Schema.Struct<{
        readonly requestedAt: Schema.Number;
        readonly source: Schema.Literals<readonly ["control", "engine", "cascade"]>;
        readonly principal: Schema.optional<Schema.Struct<{
            readonly id: Schema.String;
            readonly kind: Schema.String;
            readonly stampedAt: Schema.Number;
        }>>;
        readonly reason: Schema.optional<Schema.String>;
        readonly cascadedFrom: Schema.optional<Schema.String>;
    }>>;
    readonly deadlineAt: Schema.optional<Schema.Number>;
    readonly seat: Schema.optional<Schema.String>;
    readonly turns: Schema.Number;
    readonly calls: Schema.Number;
    readonly callsFailed: Schema.Number;
    readonly editsAttempted: Schema.Number;
    readonly editsSucceeded: Schema.Number;
    readonly inputTokens: Schema.Number;
    readonly outputTokens: Schema.Number;
    readonly verdict: Schema.String;
    readonly diagnosis: Schema.String;
    readonly finalOutput: Schema.optional<Schema.String>;
    readonly failureFault: Schema.optional<Schema.Literals<readonly ["user", "wait", "infra", "dependency", "bug", "factory", "policy"]>>;
    readonly failureMessage: Schema.optional<Schema.String>;
    readonly failureTag: Schema.optional<Schema.String>;
}>], readonly [Schema.TaggedStruct<"run-summary", {
    readonly runId: Schema.String;
}>, Schema.Struct<{
    readonly runId: Schema.String;
    readonly flowId: Schema.String;
    readonly statusRollup: Schema.optional<Schema.Struct<{
        readonly subjectId: Schema.String;
        readonly state: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
        readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
        readonly health: Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
        readonly attention: Schema.Literals<readonly ["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"]>;
        readonly freshness: Schema.Literals<readonly ["fresh", "stale", "unobserved"]>;
        readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
        readonly provenance: Schema.optional<Schema.Struct<{
            readonly checkerId: Schema.String;
            readonly monitorId: Schema.String;
            readonly observedAt: Schema.Int;
            readonly expiresAt: Schema.Int;
            readonly evidenceSeq: Schema.Int;
            readonly incarnation: Schema.String;
            readonly version: Schema.Int;
        }>>;
        readonly updatedAt: Schema.Int;
    }>>;
    readonly status: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>;
    readonly lifecycleProvenance: Schema.optional<Schema.Struct<{
        readonly control: Schema.Literals<readonly ["events", "legacy-snapshot", "unverified-snapshot"]>;
        readonly execution: Schema.Literals<readonly ["control", "engine-observed", "engine-missing"]>;
        readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
        readonly fromSequence: Schema.optional<Schema.Number>;
        readonly throughSequence: Schema.optional<Schema.Number>;
    }>>;
    readonly executionProvenance: Schema.optional<Schema.Struct<{
        readonly source: Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>;
        readonly rootExecutionId: Schema.String;
        readonly humanWaits: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
        readonly humanWaitSources: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly executionId: Schema.String;
            readonly generation: Schema.Number;
            readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
            readonly fromSequence: Schema.Number;
            readonly throughSequence: Schema.Number;
        }>>>;
        readonly currentExecutionId: Schema.optional<Schema.String>;
        readonly generation: Schema.optional<Schema.Number>;
        readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
        readonly fromSequence: Schema.optional<Schema.Number>;
        readonly throughSequence: Schema.optional<Schema.Number>;
    }>>;
    readonly createdAt: Schema.Number;
    readonly updatedAt: Schema.Number;
    readonly planId: Schema.optional<Schema.String>;
    readonly planDigest: Schema.optional<Schema.String>;
    readonly parentRunId: Schema.optional<Schema.String>;
    readonly lineageId: Schema.optional<Schema.String>;
    readonly roundOrdinal: Schema.optional<Schema.Number>;
    readonly waitingReason: Schema.optional<Schema.String>;
    readonly steeringPending: Schema.optional<Schema.Number>;
    readonly cancellation: Schema.optional<Schema.Struct<{
        readonly requestedAt: Schema.Number;
        readonly source: Schema.Literals<readonly ["control", "engine", "cascade"]>;
        readonly principal: Schema.optional<Schema.Struct<{
            readonly id: Schema.String;
            readonly kind: Schema.String;
            readonly stampedAt: Schema.Number;
        }>>;
        readonly reason: Schema.optional<Schema.String>;
        readonly cascadedFrom: Schema.optional<Schema.String>;
    }>>;
    readonly deadlineAt: Schema.optional<Schema.Number>;
    readonly seat: Schema.optional<Schema.String>;
    readonly turns: Schema.Number;
    readonly calls: Schema.Number;
    readonly callsFailed: Schema.Number;
    readonly editsAttempted: Schema.Number;
    readonly editsSucceeded: Schema.Number;
    readonly inputTokens: Schema.Number;
    readonly outputTokens: Schema.Number;
    readonly verdict: Schema.String;
    readonly diagnosis: Schema.String;
    readonly finalOutput: Schema.optional<Schema.String>;
    readonly failureFault: Schema.optional<Schema.Literals<readonly ["user", "wait", "infra", "dependency", "bug", "factory", "policy"]>>;
    readonly failureMessage: Schema.optional<Schema.String>;
    readonly failureTag: Schema.optional<Schema.String>;
}>], readonly [Schema.TaggedStruct<"run-events", {
    readonly runId: Schema.String;
}>, Schema.Struct<{
    readonly cursor: Schema.optional<Schema.Struct<{
        readonly sequence: Schema.Int;
        readonly offset: Schema.optional<Schema.Int>;
    }>>;
    readonly sequence: Schema.Number;
    readonly kind: Schema.String;
    readonly runId: Schema.optional<Schema.String>;
    readonly occurredAt: Schema.Number;
    readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>], readonly [Schema.TaggedStruct<"transcript", {
    readonly runId: Schema.String;
}>, Schema.Struct<{
    readonly runId: Schema.String;
    readonly sequence: Schema.Number;
    readonly turn: Schema.Number;
    readonly at: Schema.Number;
    readonly kind: Schema.String;
    readonly callId: Schema.optional<Schema.String>;
    readonly text: Schema.String;
}>], readonly [Schema.TaggedStruct<"run-tree", {
    readonly runId: Schema.String;
}>, Schema.Struct<{
    readonly runId: Schema.String;
    readonly nodeId: Schema.String;
    readonly label: Schema.String;
    readonly status: Schema.Literals<readonly ["running", "completed", "failed"]>;
    readonly seat: Schema.optional<Schema.String>;
    readonly startedAt: Schema.Number;
    readonly endedAt: Schema.optional<Schema.Number>;
    readonly parentRunId: Schema.optional<Schema.String>;
}>], readonly [Schema.TaggedStruct<"approvals", {
    readonly runId: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly runId: Schema.String;
    readonly waitRunId: Schema.optional<Schema.String>;
    readonly questionProvenance: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
    readonly requestId: Schema.String;
    readonly title: Schema.String;
    readonly request: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly payload: Schema.Struct<{
        readonly target: Schema.Union<readonly [Schema.TaggedStruct<"Plan", {
            readonly planId: Schema.String;
            readonly digest: Schema.String;
            readonly envelope: Schema.Struct<{
                readonly capabilities: Schema.$Array<Schema.String>;
                readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
                readonly flows: Schema.$Array<Schema.String>;
                readonly budget: Schema.Struct<{
                    readonly tokens: Schema.optional<Schema.Number>;
                    readonly milliseconds: Schema.optional<Schema.Number>;
                    readonly usd: Schema.optional<Schema.Number>;
                    readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                    readonly deadline: Schema.optional<Schema.Int>;
                }>;
                readonly host: Schema.optional<Schema.String>;
            }>;
        }>, Schema.TaggedStruct<"Node", {
            readonly runId: Schema.String;
            readonly requestId: Schema.String;
            readonly digest: Schema.String;
            readonly envelope: Schema.Struct<{
                readonly capabilities: Schema.$Array<Schema.String>;
                readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
                readonly flows: Schema.$Array<Schema.String>;
                readonly budget: Schema.Struct<{
                    readonly tokens: Schema.optional<Schema.Number>;
                    readonly milliseconds: Schema.optional<Schema.Number>;
                    readonly usd: Schema.optional<Schema.Number>;
                    readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                    readonly deadline: Schema.optional<Schema.Int>;
                }>;
                readonly host: Schema.optional<Schema.String>;
            }>;
        }>]>;
        readonly scope: Schema.Literals<readonly ["once", "run", "remembered"]>;
        readonly idempotencyKey: Schema.String;
    }>;
    readonly requestedAt: Schema.Number;
    readonly status: Schema.Literals<readonly ["pending", "approved", "denied"]>;
}>], readonly [Schema.TaggedStruct<"node-output", {
    readonly runId: Schema.String;
    readonly nodeId: Schema.String;
}>, Schema.Struct<{
    readonly runId: Schema.String;
    readonly nodeId: Schema.String;
    readonly outcome: Schema.Literals<readonly ["success", "failure"]>;
    readonly output: Schema.String;
    readonly settledAt: Schema.Number;
}>], readonly [Schema.TaggedStruct<"flow-durations", {
    readonly flowId: Schema.String;
}>, Schema.Struct<{
    readonly flowId: Schema.String;
    readonly actionTag: Schema.String;
    readonly samples: Schema.Number;
    readonly p50Ms: Schema.Number;
    readonly p90Ms: Schema.Number;
}>]];
/** The served table as the type every derivation below maps over. */
type Served = typeof served;
/**
 * A projection selected for a snapshot or watch subscription.
 *
 * @since 0.1.0
 * @category models
 */
export declare const ProjectionSelector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
    readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
}>, Schema.TaggedStruct<"run-summary", {
    readonly runId: Schema.String;
}>, Schema.TaggedStruct<"run-events", {
    readonly runId: Schema.String;
}>, Schema.TaggedStruct<"transcript", {
    readonly runId: Schema.String;
}>, Schema.TaggedStruct<"run-tree", {
    readonly runId: Schema.String;
}>, Schema.TaggedStruct<"approvals", {
    readonly runId: Schema.optional<Schema.String>;
}>, Schema.TaggedStruct<"node-output", {
    readonly runId: Schema.String;
    readonly nodeId: Schema.String;
}>, Schema.TaggedStruct<"flow-durations", {
    readonly flowId: Schema.String;
}>]>;
/**
 * A projection selected for a snapshot or watch subscription.
 *
 * @since 0.1.0
 * @category models
 */
export type ProjectionSelector = typeof ProjectionSelector.Type;
/**
 * Projection names served by the gateway read path.
 *
 * @since 0.1.0
 * @category models
 */
export declare const ProjectionName: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
/**
 * A gateway projection name.
 *
 * @since 0.1.0
 * @category models
 */
export type ProjectionName = typeof ProjectionName.Type;
/** Each served row schema, keyed by the name of the selector it answers. */
type RowSchemas = {
    readonly [P in Served[number] as P[0]["Type"]["_tag"]]: P[1];
};
/**
 * The row schema one selector answers with, so a client decodes a snapshot
 * instead of casting it.
 *
 * A literal selector keeps its own row schema: `rowSchemaFor({ _tag:
 * "approvals" })` decodes to `ApprovalRow`, not to the union of every row.
 *
 * @param selector the selector whose row schema the client needs
 * @since 1.0.0
 * @category schemas
 */
export declare const rowSchemaFor: <S extends ProjectionSelector>(selector: S) => RowSchemas[S["_tag"]];
/**
 * The row type one selector's projection is made of.
 *
 * @since 1.0.0
 * @category models
 */
export type RowOf<S extends ProjectionSelector> = RowSchemas[S["_tag"]]["Type"];
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
export declare const ProjectionCursor: Schema.Struct<{
    readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
        readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
    }>, Schema.TaggedStruct<"run-summary", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"run-events", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"transcript", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"run-tree", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"approvals", {
        readonly runId: Schema.optional<Schema.String>;
    }>, Schema.TaggedStruct<"node-output", {
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
    }>, Schema.TaggedStruct<"flow-durations", {
        readonly flowId: Schema.String;
    }>]>;
    readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
    readonly runId: Schema.NullOr<Schema.String>;
    readonly value: Schema.Int;
    readonly offset: Schema.Int;
}>;
/**
 * A monotonic projection cursor.
 *
 * @since 0.1.0
 * @category models
 */
export type ProjectionCursor = typeof ProjectionCursor.Type;
/**
 * Every row one selector currently projects, and the cursor they were read
 * at. A client that follows the same selector from this cursor sees each
 * later change exactly once.
 *
 * @since 1.0.0
 * @category models
 */
export declare const ProjectionSnapshot: Schema.Union<readonly [Schema.Struct<{
    readonly selector: Schema.TaggedStruct<"workspace-runs", {
        readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly rows: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly flowId: Schema.String;
        readonly statusRollup: Schema.optional<Schema.Struct<{
            readonly subjectId: Schema.String;
            readonly state: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
            readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
            readonly health: Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
            readonly attention: Schema.Literals<readonly ["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"]>;
            readonly freshness: Schema.Literals<readonly ["fresh", "stale", "unobserved"]>;
            readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
            readonly provenance: Schema.optional<Schema.Struct<{
                readonly checkerId: Schema.String;
                readonly monitorId: Schema.String;
                readonly observedAt: Schema.Int;
                readonly expiresAt: Schema.Int;
                readonly evidenceSeq: Schema.Int;
                readonly incarnation: Schema.String;
                readonly version: Schema.Int;
            }>>;
            readonly updatedAt: Schema.Int;
        }>>;
        readonly status: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>;
        readonly lifecycleProvenance: Schema.optional<Schema.Struct<{
            readonly control: Schema.Literals<readonly ["events", "legacy-snapshot", "unverified-snapshot"]>;
            readonly execution: Schema.Literals<readonly ["control", "engine-observed", "engine-missing"]>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly executionProvenance: Schema.optional<Schema.Struct<{
            readonly source: Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>;
            readonly rootExecutionId: Schema.String;
            readonly humanWaits: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
            readonly humanWaitSources: Schema.optional<Schema.$Array<Schema.Struct<{
                readonly executionId: Schema.String;
                readonly generation: Schema.Number;
                readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
                readonly fromSequence: Schema.Number;
                readonly throughSequence: Schema.Number;
            }>>>;
            readonly currentExecutionId: Schema.optional<Schema.String>;
            readonly generation: Schema.optional<Schema.Number>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly createdAt: Schema.Number;
        readonly updatedAt: Schema.Number;
        readonly planId: Schema.optional<Schema.String>;
        readonly planDigest: Schema.optional<Schema.String>;
        readonly parentRunId: Schema.optional<Schema.String>;
        readonly lineageId: Schema.optional<Schema.String>;
        readonly roundOrdinal: Schema.optional<Schema.Number>;
        readonly waitingReason: Schema.optional<Schema.String>;
        readonly steeringPending: Schema.optional<Schema.Number>;
        readonly cancellation: Schema.optional<Schema.Struct<{
            readonly requestedAt: Schema.Number;
            readonly source: Schema.Literals<readonly ["control", "engine", "cascade"]>;
            readonly principal: Schema.optional<Schema.Struct<{
                readonly id: Schema.String;
                readonly kind: Schema.String;
                readonly stampedAt: Schema.Number;
            }>>;
            readonly reason: Schema.optional<Schema.String>;
            readonly cascadedFrom: Schema.optional<Schema.String>;
        }>>;
        readonly deadlineAt: Schema.optional<Schema.Number>;
        readonly seat: Schema.optional<Schema.String>;
        readonly turns: Schema.Number;
        readonly calls: Schema.Number;
        readonly callsFailed: Schema.Number;
        readonly editsAttempted: Schema.Number;
        readonly editsSucceeded: Schema.Number;
        readonly inputTokens: Schema.Number;
        readonly outputTokens: Schema.Number;
        readonly verdict: Schema.String;
        readonly diagnosis: Schema.String;
        readonly finalOutput: Schema.optional<Schema.String>;
        readonly failureFault: Schema.optional<Schema.Literals<readonly ["user", "wait", "infra", "dependency", "bug", "factory", "policy"]>>;
        readonly failureMessage: Schema.optional<Schema.String>;
        readonly failureTag: Schema.optional<Schema.String>;
    }>>;
}>, Schema.Struct<{
    readonly selector: Schema.TaggedStruct<"run-summary", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly rows: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly flowId: Schema.String;
        readonly statusRollup: Schema.optional<Schema.Struct<{
            readonly subjectId: Schema.String;
            readonly state: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
            readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
            readonly health: Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
            readonly attention: Schema.Literals<readonly ["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"]>;
            readonly freshness: Schema.Literals<readonly ["fresh", "stale", "unobserved"]>;
            readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
            readonly provenance: Schema.optional<Schema.Struct<{
                readonly checkerId: Schema.String;
                readonly monitorId: Schema.String;
                readonly observedAt: Schema.Int;
                readonly expiresAt: Schema.Int;
                readonly evidenceSeq: Schema.Int;
                readonly incarnation: Schema.String;
                readonly version: Schema.Int;
            }>>;
            readonly updatedAt: Schema.Int;
        }>>;
        readonly status: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>;
        readonly lifecycleProvenance: Schema.optional<Schema.Struct<{
            readonly control: Schema.Literals<readonly ["events", "legacy-snapshot", "unverified-snapshot"]>;
            readonly execution: Schema.Literals<readonly ["control", "engine-observed", "engine-missing"]>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly executionProvenance: Schema.optional<Schema.Struct<{
            readonly source: Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>;
            readonly rootExecutionId: Schema.String;
            readonly humanWaits: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
            readonly humanWaitSources: Schema.optional<Schema.$Array<Schema.Struct<{
                readonly executionId: Schema.String;
                readonly generation: Schema.Number;
                readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
                readonly fromSequence: Schema.Number;
                readonly throughSequence: Schema.Number;
            }>>>;
            readonly currentExecutionId: Schema.optional<Schema.String>;
            readonly generation: Schema.optional<Schema.Number>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly createdAt: Schema.Number;
        readonly updatedAt: Schema.Number;
        readonly planId: Schema.optional<Schema.String>;
        readonly planDigest: Schema.optional<Schema.String>;
        readonly parentRunId: Schema.optional<Schema.String>;
        readonly lineageId: Schema.optional<Schema.String>;
        readonly roundOrdinal: Schema.optional<Schema.Number>;
        readonly waitingReason: Schema.optional<Schema.String>;
        readonly steeringPending: Schema.optional<Schema.Number>;
        readonly cancellation: Schema.optional<Schema.Struct<{
            readonly requestedAt: Schema.Number;
            readonly source: Schema.Literals<readonly ["control", "engine", "cascade"]>;
            readonly principal: Schema.optional<Schema.Struct<{
                readonly id: Schema.String;
                readonly kind: Schema.String;
                readonly stampedAt: Schema.Number;
            }>>;
            readonly reason: Schema.optional<Schema.String>;
            readonly cascadedFrom: Schema.optional<Schema.String>;
        }>>;
        readonly deadlineAt: Schema.optional<Schema.Number>;
        readonly seat: Schema.optional<Schema.String>;
        readonly turns: Schema.Number;
        readonly calls: Schema.Number;
        readonly callsFailed: Schema.Number;
        readonly editsAttempted: Schema.Number;
        readonly editsSucceeded: Schema.Number;
        readonly inputTokens: Schema.Number;
        readonly outputTokens: Schema.Number;
        readonly verdict: Schema.String;
        readonly diagnosis: Schema.String;
        readonly finalOutput: Schema.optional<Schema.String>;
        readonly failureFault: Schema.optional<Schema.Literals<readonly ["user", "wait", "infra", "dependency", "bug", "factory", "policy"]>>;
        readonly failureMessage: Schema.optional<Schema.String>;
        readonly failureTag: Schema.optional<Schema.String>;
    }>>;
}>, Schema.Struct<{
    readonly selector: Schema.TaggedStruct<"run-events", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly rows: Schema.$Array<Schema.Struct<{
        readonly cursor: Schema.optional<Schema.Struct<{
            readonly sequence: Schema.Int;
            readonly offset: Schema.optional<Schema.Int>;
        }>>;
        readonly sequence: Schema.Number;
        readonly kind: Schema.String;
        readonly runId: Schema.optional<Schema.String>;
        readonly occurredAt: Schema.Number;
        readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    }>>;
}>, Schema.Struct<{
    readonly selector: Schema.TaggedStruct<"transcript", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly rows: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly sequence: Schema.Number;
        readonly turn: Schema.Number;
        readonly at: Schema.Number;
        readonly kind: Schema.String;
        readonly callId: Schema.optional<Schema.String>;
        readonly text: Schema.String;
    }>>;
}>, Schema.Struct<{
    readonly selector: Schema.TaggedStruct<"run-tree", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly rows: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
        readonly label: Schema.String;
        readonly status: Schema.Literals<readonly ["running", "completed", "failed"]>;
        readonly seat: Schema.optional<Schema.String>;
        readonly startedAt: Schema.Number;
        readonly endedAt: Schema.optional<Schema.Number>;
        readonly parentRunId: Schema.optional<Schema.String>;
    }>>;
}>, Schema.Struct<{
    readonly selector: Schema.TaggedStruct<"approvals", {
        readonly runId: Schema.optional<Schema.String>;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly rows: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly waitRunId: Schema.optional<Schema.String>;
        readonly questionProvenance: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
        readonly requestId: Schema.String;
        readonly title: Schema.String;
        readonly request: Schema.Codec<Schema.Json, Schema.Json, never, never>;
        readonly payload: Schema.Struct<{
            readonly target: Schema.Union<readonly [Schema.TaggedStruct<"Plan", {
                readonly planId: Schema.String;
                readonly digest: Schema.String;
                readonly envelope: Schema.Struct<{
                    readonly capabilities: Schema.$Array<Schema.String>;
                    readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
                    readonly flows: Schema.$Array<Schema.String>;
                    readonly budget: Schema.Struct<{
                        readonly tokens: Schema.optional<Schema.Number>;
                        readonly milliseconds: Schema.optional<Schema.Number>;
                        readonly usd: Schema.optional<Schema.Number>;
                        readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                        readonly deadline: Schema.optional<Schema.Int>;
                    }>;
                    readonly host: Schema.optional<Schema.String>;
                }>;
            }>, Schema.TaggedStruct<"Node", {
                readonly runId: Schema.String;
                readonly requestId: Schema.String;
                readonly digest: Schema.String;
                readonly envelope: Schema.Struct<{
                    readonly capabilities: Schema.$Array<Schema.String>;
                    readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
                    readonly flows: Schema.$Array<Schema.String>;
                    readonly budget: Schema.Struct<{
                        readonly tokens: Schema.optional<Schema.Number>;
                        readonly milliseconds: Schema.optional<Schema.Number>;
                        readonly usd: Schema.optional<Schema.Number>;
                        readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                        readonly deadline: Schema.optional<Schema.Int>;
                    }>;
                    readonly host: Schema.optional<Schema.String>;
                }>;
            }>]>;
            readonly scope: Schema.Literals<readonly ["once", "run", "remembered"]>;
            readonly idempotencyKey: Schema.String;
        }>;
        readonly requestedAt: Schema.Number;
        readonly status: Schema.Literals<readonly ["pending", "approved", "denied"]>;
    }>>;
}>, Schema.Struct<{
    readonly selector: Schema.TaggedStruct<"node-output", {
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly rows: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
        readonly outcome: Schema.Literals<readonly ["success", "failure"]>;
        readonly output: Schema.String;
        readonly settledAt: Schema.Number;
    }>>;
}>, Schema.Struct<{
    readonly selector: Schema.TaggedStruct<"flow-durations", {
        readonly flowId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly rows: Schema.$Array<Schema.Struct<{
        readonly flowId: Schema.String;
        readonly actionTag: Schema.String;
        readonly samples: Schema.Number;
        readonly p50Ms: Schema.Number;
        readonly p90Ms: Schema.Number;
    }>>;
}>]>;
/**
 * A projection snapshot and the cursor it was read at.
 *
 * @since 1.0.0
 * @category models
 */
export type ProjectionSnapshot = typeof ProjectionSnapshot.Type;
/**
 * The start of a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export declare const SnapshotStartFrame: Schema.TaggedStruct<"snapshot-start", {
    readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
        readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
    }>, Schema.TaggedStruct<"run-summary", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"run-events", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"transcript", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"run-tree", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"approvals", {
        readonly runId: Schema.optional<Schema.String>;
    }>, Schema.TaggedStruct<"node-output", {
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
    }>, Schema.TaggedStruct<"flow-durations", {
        readonly flowId: Schema.String;
    }>]>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
}>;
/**
 * The start of a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export type SnapshotStartFrame = typeof SnapshotStartFrame.Type;
/**
 * A row emitted during a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export declare const RowFrame: Schema.Union<readonly [Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"workspace-runs", {
        readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly runId: Schema.String;
        readonly flowId: Schema.String;
        readonly statusRollup: Schema.optional<Schema.Struct<{
            readonly subjectId: Schema.String;
            readonly state: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
            readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
            readonly health: Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
            readonly attention: Schema.Literals<readonly ["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"]>;
            readonly freshness: Schema.Literals<readonly ["fresh", "stale", "unobserved"]>;
            readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
            readonly provenance: Schema.optional<Schema.Struct<{
                readonly checkerId: Schema.String;
                readonly monitorId: Schema.String;
                readonly observedAt: Schema.Int;
                readonly expiresAt: Schema.Int;
                readonly evidenceSeq: Schema.Int;
                readonly incarnation: Schema.String;
                readonly version: Schema.Int;
            }>>;
            readonly updatedAt: Schema.Int;
        }>>;
        readonly status: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>;
        readonly lifecycleProvenance: Schema.optional<Schema.Struct<{
            readonly control: Schema.Literals<readonly ["events", "legacy-snapshot", "unverified-snapshot"]>;
            readonly execution: Schema.Literals<readonly ["control", "engine-observed", "engine-missing"]>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly executionProvenance: Schema.optional<Schema.Struct<{
            readonly source: Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>;
            readonly rootExecutionId: Schema.String;
            readonly humanWaits: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
            readonly humanWaitSources: Schema.optional<Schema.$Array<Schema.Struct<{
                readonly executionId: Schema.String;
                readonly generation: Schema.Number;
                readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
                readonly fromSequence: Schema.Number;
                readonly throughSequence: Schema.Number;
            }>>>;
            readonly currentExecutionId: Schema.optional<Schema.String>;
            readonly generation: Schema.optional<Schema.Number>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly createdAt: Schema.Number;
        readonly updatedAt: Schema.Number;
        readonly planId: Schema.optional<Schema.String>;
        readonly planDigest: Schema.optional<Schema.String>;
        readonly parentRunId: Schema.optional<Schema.String>;
        readonly lineageId: Schema.optional<Schema.String>;
        readonly roundOrdinal: Schema.optional<Schema.Number>;
        readonly waitingReason: Schema.optional<Schema.String>;
        readonly steeringPending: Schema.optional<Schema.Number>;
        readonly cancellation: Schema.optional<Schema.Struct<{
            readonly requestedAt: Schema.Number;
            readonly source: Schema.Literals<readonly ["control", "engine", "cascade"]>;
            readonly principal: Schema.optional<Schema.Struct<{
                readonly id: Schema.String;
                readonly kind: Schema.String;
                readonly stampedAt: Schema.Number;
            }>>;
            readonly reason: Schema.optional<Schema.String>;
            readonly cascadedFrom: Schema.optional<Schema.String>;
        }>>;
        readonly deadlineAt: Schema.optional<Schema.Number>;
        readonly seat: Schema.optional<Schema.String>;
        readonly turns: Schema.Number;
        readonly calls: Schema.Number;
        readonly callsFailed: Schema.Number;
        readonly editsAttempted: Schema.Number;
        readonly editsSucceeded: Schema.Number;
        readonly inputTokens: Schema.Number;
        readonly outputTokens: Schema.Number;
        readonly verdict: Schema.String;
        readonly diagnosis: Schema.String;
        readonly finalOutput: Schema.optional<Schema.String>;
        readonly failureFault: Schema.optional<Schema.Literals<readonly ["user", "wait", "infra", "dependency", "bug", "factory", "policy"]>>;
        readonly failureMessage: Schema.optional<Schema.String>;
        readonly failureTag: Schema.optional<Schema.String>;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"run-summary", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly runId: Schema.String;
        readonly flowId: Schema.String;
        readonly statusRollup: Schema.optional<Schema.Struct<{
            readonly subjectId: Schema.String;
            readonly state: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
            readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
            readonly health: Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
            readonly attention: Schema.Literals<readonly ["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"]>;
            readonly freshness: Schema.Literals<readonly ["fresh", "stale", "unobserved"]>;
            readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
            readonly provenance: Schema.optional<Schema.Struct<{
                readonly checkerId: Schema.String;
                readonly monitorId: Schema.String;
                readonly observedAt: Schema.Int;
                readonly expiresAt: Schema.Int;
                readonly evidenceSeq: Schema.Int;
                readonly incarnation: Schema.String;
                readonly version: Schema.Int;
            }>>;
            readonly updatedAt: Schema.Int;
        }>>;
        readonly status: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>;
        readonly lifecycleProvenance: Schema.optional<Schema.Struct<{
            readonly control: Schema.Literals<readonly ["events", "legacy-snapshot", "unverified-snapshot"]>;
            readonly execution: Schema.Literals<readonly ["control", "engine-observed", "engine-missing"]>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly executionProvenance: Schema.optional<Schema.Struct<{
            readonly source: Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>;
            readonly rootExecutionId: Schema.String;
            readonly humanWaits: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
            readonly humanWaitSources: Schema.optional<Schema.$Array<Schema.Struct<{
                readonly executionId: Schema.String;
                readonly generation: Schema.Number;
                readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
                readonly fromSequence: Schema.Number;
                readonly throughSequence: Schema.Number;
            }>>>;
            readonly currentExecutionId: Schema.optional<Schema.String>;
            readonly generation: Schema.optional<Schema.Number>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly createdAt: Schema.Number;
        readonly updatedAt: Schema.Number;
        readonly planId: Schema.optional<Schema.String>;
        readonly planDigest: Schema.optional<Schema.String>;
        readonly parentRunId: Schema.optional<Schema.String>;
        readonly lineageId: Schema.optional<Schema.String>;
        readonly roundOrdinal: Schema.optional<Schema.Number>;
        readonly waitingReason: Schema.optional<Schema.String>;
        readonly steeringPending: Schema.optional<Schema.Number>;
        readonly cancellation: Schema.optional<Schema.Struct<{
            readonly requestedAt: Schema.Number;
            readonly source: Schema.Literals<readonly ["control", "engine", "cascade"]>;
            readonly principal: Schema.optional<Schema.Struct<{
                readonly id: Schema.String;
                readonly kind: Schema.String;
                readonly stampedAt: Schema.Number;
            }>>;
            readonly reason: Schema.optional<Schema.String>;
            readonly cascadedFrom: Schema.optional<Schema.String>;
        }>>;
        readonly deadlineAt: Schema.optional<Schema.Number>;
        readonly seat: Schema.optional<Schema.String>;
        readonly turns: Schema.Number;
        readonly calls: Schema.Number;
        readonly callsFailed: Schema.Number;
        readonly editsAttempted: Schema.Number;
        readonly editsSucceeded: Schema.Number;
        readonly inputTokens: Schema.Number;
        readonly outputTokens: Schema.Number;
        readonly verdict: Schema.String;
        readonly diagnosis: Schema.String;
        readonly finalOutput: Schema.optional<Schema.String>;
        readonly failureFault: Schema.optional<Schema.Literals<readonly ["user", "wait", "infra", "dependency", "bug", "factory", "policy"]>>;
        readonly failureMessage: Schema.optional<Schema.String>;
        readonly failureTag: Schema.optional<Schema.String>;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"run-events", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly cursor: Schema.optional<Schema.Struct<{
            readonly sequence: Schema.Int;
            readonly offset: Schema.optional<Schema.Int>;
        }>>;
        readonly sequence: Schema.Number;
        readonly kind: Schema.String;
        readonly runId: Schema.optional<Schema.String>;
        readonly occurredAt: Schema.Number;
        readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"transcript", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly runId: Schema.String;
        readonly sequence: Schema.Number;
        readonly turn: Schema.Number;
        readonly at: Schema.Number;
        readonly kind: Schema.String;
        readonly callId: Schema.optional<Schema.String>;
        readonly text: Schema.String;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"run-tree", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
        readonly label: Schema.String;
        readonly status: Schema.Literals<readonly ["running", "completed", "failed"]>;
        readonly seat: Schema.optional<Schema.String>;
        readonly startedAt: Schema.Number;
        readonly endedAt: Schema.optional<Schema.Number>;
        readonly parentRunId: Schema.optional<Schema.String>;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"approvals", {
        readonly runId: Schema.optional<Schema.String>;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly runId: Schema.String;
        readonly waitRunId: Schema.optional<Schema.String>;
        readonly questionProvenance: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
        readonly requestId: Schema.String;
        readonly title: Schema.String;
        readonly request: Schema.Codec<Schema.Json, Schema.Json, never, never>;
        readonly payload: Schema.Struct<{
            readonly target: Schema.Union<readonly [Schema.TaggedStruct<"Plan", {
                readonly planId: Schema.String;
                readonly digest: Schema.String;
                readonly envelope: Schema.Struct<{
                    readonly capabilities: Schema.$Array<Schema.String>;
                    readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
                    readonly flows: Schema.$Array<Schema.String>;
                    readonly budget: Schema.Struct<{
                        readonly tokens: Schema.optional<Schema.Number>;
                        readonly milliseconds: Schema.optional<Schema.Number>;
                        readonly usd: Schema.optional<Schema.Number>;
                        readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                        readonly deadline: Schema.optional<Schema.Int>;
                    }>;
                    readonly host: Schema.optional<Schema.String>;
                }>;
            }>, Schema.TaggedStruct<"Node", {
                readonly runId: Schema.String;
                readonly requestId: Schema.String;
                readonly digest: Schema.String;
                readonly envelope: Schema.Struct<{
                    readonly capabilities: Schema.$Array<Schema.String>;
                    readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
                    readonly flows: Schema.$Array<Schema.String>;
                    readonly budget: Schema.Struct<{
                        readonly tokens: Schema.optional<Schema.Number>;
                        readonly milliseconds: Schema.optional<Schema.Number>;
                        readonly usd: Schema.optional<Schema.Number>;
                        readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                        readonly deadline: Schema.optional<Schema.Int>;
                    }>;
                    readonly host: Schema.optional<Schema.String>;
                }>;
            }>]>;
            readonly scope: Schema.Literals<readonly ["once", "run", "remembered"]>;
            readonly idempotencyKey: Schema.String;
        }>;
        readonly requestedAt: Schema.Number;
        readonly status: Schema.Literals<readonly ["pending", "approved", "denied"]>;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"node-output", {
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
        readonly outcome: Schema.Literals<readonly ["success", "failure"]>;
        readonly output: Schema.String;
        readonly settledAt: Schema.Number;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"flow-durations", {
        readonly flowId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly flowId: Schema.String;
        readonly actionTag: Schema.String;
        readonly samples: Schema.Number;
        readonly p50Ms: Schema.Number;
        readonly p90Ms: Schema.Number;
    }>;
}>]>;
/**
 * A row emitted during a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export type RowFrame = typeof RowFrame.Type;
/**
 * The end of a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export declare const SnapshotEndFrame: Schema.TaggedStruct<"snapshot-end", {
    readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
        readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
    }>, Schema.TaggedStruct<"run-summary", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"run-events", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"transcript", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"run-tree", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"approvals", {
        readonly runId: Schema.optional<Schema.String>;
    }>, Schema.TaggedStruct<"node-output", {
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
    }>, Schema.TaggedStruct<"flow-durations", {
        readonly flowId: Schema.String;
    }>]>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
}>;
/**
 * The end of a selector snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export type SnapshotEndFrame = typeof SnapshotEndFrame.Type;
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
export declare const DeltaFrame: Schema.Union<readonly [Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"workspace-runs", {
        readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly flowId: Schema.String;
        readonly statusRollup: Schema.optional<Schema.Struct<{
            readonly subjectId: Schema.String;
            readonly state: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
            readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
            readonly health: Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
            readonly attention: Schema.Literals<readonly ["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"]>;
            readonly freshness: Schema.Literals<readonly ["fresh", "stale", "unobserved"]>;
            readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
            readonly provenance: Schema.optional<Schema.Struct<{
                readonly checkerId: Schema.String;
                readonly monitorId: Schema.String;
                readonly observedAt: Schema.Int;
                readonly expiresAt: Schema.Int;
                readonly evidenceSeq: Schema.Int;
                readonly incarnation: Schema.String;
                readonly version: Schema.Int;
            }>>;
            readonly updatedAt: Schema.Int;
        }>>;
        readonly status: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>;
        readonly lifecycleProvenance: Schema.optional<Schema.Struct<{
            readonly control: Schema.Literals<readonly ["events", "legacy-snapshot", "unverified-snapshot"]>;
            readonly execution: Schema.Literals<readonly ["control", "engine-observed", "engine-missing"]>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly executionProvenance: Schema.optional<Schema.Struct<{
            readonly source: Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>;
            readonly rootExecutionId: Schema.String;
            readonly humanWaits: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
            readonly humanWaitSources: Schema.optional<Schema.$Array<Schema.Struct<{
                readonly executionId: Schema.String;
                readonly generation: Schema.Number;
                readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
                readonly fromSequence: Schema.Number;
                readonly throughSequence: Schema.Number;
            }>>>;
            readonly currentExecutionId: Schema.optional<Schema.String>;
            readonly generation: Schema.optional<Schema.Number>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly createdAt: Schema.Number;
        readonly updatedAt: Schema.Number;
        readonly planId: Schema.optional<Schema.String>;
        readonly planDigest: Schema.optional<Schema.String>;
        readonly parentRunId: Schema.optional<Schema.String>;
        readonly lineageId: Schema.optional<Schema.String>;
        readonly roundOrdinal: Schema.optional<Schema.Number>;
        readonly waitingReason: Schema.optional<Schema.String>;
        readonly steeringPending: Schema.optional<Schema.Number>;
        readonly cancellation: Schema.optional<Schema.Struct<{
            readonly requestedAt: Schema.Number;
            readonly source: Schema.Literals<readonly ["control", "engine", "cascade"]>;
            readonly principal: Schema.optional<Schema.Struct<{
                readonly id: Schema.String;
                readonly kind: Schema.String;
                readonly stampedAt: Schema.Number;
            }>>;
            readonly reason: Schema.optional<Schema.String>;
            readonly cascadedFrom: Schema.optional<Schema.String>;
        }>>;
        readonly deadlineAt: Schema.optional<Schema.Number>;
        readonly seat: Schema.optional<Schema.String>;
        readonly turns: Schema.Number;
        readonly calls: Schema.Number;
        readonly callsFailed: Schema.Number;
        readonly editsAttempted: Schema.Number;
        readonly editsSucceeded: Schema.Number;
        readonly inputTokens: Schema.Number;
        readonly outputTokens: Schema.Number;
        readonly verdict: Schema.String;
        readonly diagnosis: Schema.String;
        readonly finalOutput: Schema.optional<Schema.String>;
        readonly failureFault: Schema.optional<Schema.Literals<readonly ["user", "wait", "infra", "dependency", "bug", "factory", "policy"]>>;
        readonly failureMessage: Schema.optional<Schema.String>;
        readonly failureTag: Schema.optional<Schema.String>;
    }>>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"run-summary", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly flowId: Schema.String;
        readonly statusRollup: Schema.optional<Schema.Struct<{
            readonly subjectId: Schema.String;
            readonly state: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
            readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
            readonly health: Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
            readonly attention: Schema.Literals<readonly ["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"]>;
            readonly freshness: Schema.Literals<readonly ["fresh", "stale", "unobserved"]>;
            readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
            readonly provenance: Schema.optional<Schema.Struct<{
                readonly checkerId: Schema.String;
                readonly monitorId: Schema.String;
                readonly observedAt: Schema.Int;
                readonly expiresAt: Schema.Int;
                readonly evidenceSeq: Schema.Int;
                readonly incarnation: Schema.String;
                readonly version: Schema.Int;
            }>>;
            readonly updatedAt: Schema.Int;
        }>>;
        readonly status: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>;
        readonly lifecycleProvenance: Schema.optional<Schema.Struct<{
            readonly control: Schema.Literals<readonly ["events", "legacy-snapshot", "unverified-snapshot"]>;
            readonly execution: Schema.Literals<readonly ["control", "engine-observed", "engine-missing"]>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly executionProvenance: Schema.optional<Schema.Struct<{
            readonly source: Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>;
            readonly rootExecutionId: Schema.String;
            readonly humanWaits: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
            readonly humanWaitSources: Schema.optional<Schema.$Array<Schema.Struct<{
                readonly executionId: Schema.String;
                readonly generation: Schema.Number;
                readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
                readonly fromSequence: Schema.Number;
                readonly throughSequence: Schema.Number;
            }>>>;
            readonly currentExecutionId: Schema.optional<Schema.String>;
            readonly generation: Schema.optional<Schema.Number>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly createdAt: Schema.Number;
        readonly updatedAt: Schema.Number;
        readonly planId: Schema.optional<Schema.String>;
        readonly planDigest: Schema.optional<Schema.String>;
        readonly parentRunId: Schema.optional<Schema.String>;
        readonly lineageId: Schema.optional<Schema.String>;
        readonly roundOrdinal: Schema.optional<Schema.Number>;
        readonly waitingReason: Schema.optional<Schema.String>;
        readonly steeringPending: Schema.optional<Schema.Number>;
        readonly cancellation: Schema.optional<Schema.Struct<{
            readonly requestedAt: Schema.Number;
            readonly source: Schema.Literals<readonly ["control", "engine", "cascade"]>;
            readonly principal: Schema.optional<Schema.Struct<{
                readonly id: Schema.String;
                readonly kind: Schema.String;
                readonly stampedAt: Schema.Number;
            }>>;
            readonly reason: Schema.optional<Schema.String>;
            readonly cascadedFrom: Schema.optional<Schema.String>;
        }>>;
        readonly deadlineAt: Schema.optional<Schema.Number>;
        readonly seat: Schema.optional<Schema.String>;
        readonly turns: Schema.Number;
        readonly calls: Schema.Number;
        readonly callsFailed: Schema.Number;
        readonly editsAttempted: Schema.Number;
        readonly editsSucceeded: Schema.Number;
        readonly inputTokens: Schema.Number;
        readonly outputTokens: Schema.Number;
        readonly verdict: Schema.String;
        readonly diagnosis: Schema.String;
        readonly finalOutput: Schema.optional<Schema.String>;
        readonly failureFault: Schema.optional<Schema.Literals<readonly ["user", "wait", "infra", "dependency", "bug", "factory", "policy"]>>;
        readonly failureMessage: Schema.optional<Schema.String>;
        readonly failureTag: Schema.optional<Schema.String>;
    }>>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"run-events", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly cursor: Schema.optional<Schema.Struct<{
            readonly sequence: Schema.Int;
            readonly offset: Schema.optional<Schema.Int>;
        }>>;
        readonly sequence: Schema.Number;
        readonly kind: Schema.String;
        readonly runId: Schema.optional<Schema.String>;
        readonly occurredAt: Schema.Number;
        readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    }>>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"transcript", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly sequence: Schema.Number;
        readonly turn: Schema.Number;
        readonly at: Schema.Number;
        readonly kind: Schema.String;
        readonly callId: Schema.optional<Schema.String>;
        readonly text: Schema.String;
    }>>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"run-tree", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
        readonly label: Schema.String;
        readonly status: Schema.Literals<readonly ["running", "completed", "failed"]>;
        readonly seat: Schema.optional<Schema.String>;
        readonly startedAt: Schema.Number;
        readonly endedAt: Schema.optional<Schema.Number>;
        readonly parentRunId: Schema.optional<Schema.String>;
    }>>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"approvals", {
        readonly runId: Schema.optional<Schema.String>;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly waitRunId: Schema.optional<Schema.String>;
        readonly questionProvenance: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
        readonly requestId: Schema.String;
        readonly title: Schema.String;
        readonly request: Schema.Codec<Schema.Json, Schema.Json, never, never>;
        readonly payload: Schema.Struct<{
            readonly target: Schema.Union<readonly [Schema.TaggedStruct<"Plan", {
                readonly planId: Schema.String;
                readonly digest: Schema.String;
                readonly envelope: Schema.Struct<{
                    readonly capabilities: Schema.$Array<Schema.String>;
                    readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
                    readonly flows: Schema.$Array<Schema.String>;
                    readonly budget: Schema.Struct<{
                        readonly tokens: Schema.optional<Schema.Number>;
                        readonly milliseconds: Schema.optional<Schema.Number>;
                        readonly usd: Schema.optional<Schema.Number>;
                        readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                        readonly deadline: Schema.optional<Schema.Int>;
                    }>;
                    readonly host: Schema.optional<Schema.String>;
                }>;
            }>, Schema.TaggedStruct<"Node", {
                readonly runId: Schema.String;
                readonly requestId: Schema.String;
                readonly digest: Schema.String;
                readonly envelope: Schema.Struct<{
                    readonly capabilities: Schema.$Array<Schema.String>;
                    readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
                    readonly flows: Schema.$Array<Schema.String>;
                    readonly budget: Schema.Struct<{
                        readonly tokens: Schema.optional<Schema.Number>;
                        readonly milliseconds: Schema.optional<Schema.Number>;
                        readonly usd: Schema.optional<Schema.Number>;
                        readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                        readonly deadline: Schema.optional<Schema.Int>;
                    }>;
                    readonly host: Schema.optional<Schema.String>;
                }>;
            }>]>;
            readonly scope: Schema.Literals<readonly ["once", "run", "remembered"]>;
            readonly idempotencyKey: Schema.String;
        }>;
        readonly requestedAt: Schema.Number;
        readonly status: Schema.Literals<readonly ["pending", "approved", "denied"]>;
    }>>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"node-output", {
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
        readonly outcome: Schema.Literals<readonly ["success", "failure"]>;
        readonly output: Schema.String;
        readonly settledAt: Schema.Number;
    }>>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"flow-durations", {
        readonly flowId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly flowId: Schema.String;
        readonly actionTag: Schema.String;
        readonly samples: Schema.Number;
        readonly p50Ms: Schema.Number;
        readonly p90Ms: Schema.Number;
    }>>;
}>]>;
/**
 * A projection mutation after snapshot completion.
 *
 * @since 0.1.0
 * @category models
 */
export type DeltaFrame = typeof DeltaFrame.Type;
/**
 * A keepalive frame for an active subscription.
 *
 * @since 0.1.0
 * @category models
 */
export declare const HeartbeatFrame: Schema.TaggedStruct<"heartbeat", {
    readonly atMs: Schema.Number;
}>;
/**
 * A keepalive frame for an active subscription.
 *
 * @since 0.1.0
 * @category models
 */
export type HeartbeatFrame = typeof HeartbeatFrame.Type;
/**
 * A frame sent by the gateway subscription protocol.
 *
 * @since 0.1.0
 * @category models
 */
export declare const GatewayFrame: Schema.Union<readonly [Schema.TaggedStruct<"snapshot-start", {
    readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
        readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
    }>, Schema.TaggedStruct<"run-summary", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"run-events", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"transcript", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"run-tree", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"approvals", {
        readonly runId: Schema.optional<Schema.String>;
    }>, Schema.TaggedStruct<"node-output", {
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
    }>, Schema.TaggedStruct<"flow-durations", {
        readonly flowId: Schema.String;
    }>]>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"workspace-runs", {
        readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly runId: Schema.String;
        readonly flowId: Schema.String;
        readonly statusRollup: Schema.optional<Schema.Struct<{
            readonly subjectId: Schema.String;
            readonly state: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
            readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
            readonly health: Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
            readonly attention: Schema.Literals<readonly ["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"]>;
            readonly freshness: Schema.Literals<readonly ["fresh", "stale", "unobserved"]>;
            readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
            readonly provenance: Schema.optional<Schema.Struct<{
                readonly checkerId: Schema.String;
                readonly monitorId: Schema.String;
                readonly observedAt: Schema.Int;
                readonly expiresAt: Schema.Int;
                readonly evidenceSeq: Schema.Int;
                readonly incarnation: Schema.String;
                readonly version: Schema.Int;
            }>>;
            readonly updatedAt: Schema.Int;
        }>>;
        readonly status: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>;
        readonly lifecycleProvenance: Schema.optional<Schema.Struct<{
            readonly control: Schema.Literals<readonly ["events", "legacy-snapshot", "unverified-snapshot"]>;
            readonly execution: Schema.Literals<readonly ["control", "engine-observed", "engine-missing"]>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly executionProvenance: Schema.optional<Schema.Struct<{
            readonly source: Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>;
            readonly rootExecutionId: Schema.String;
            readonly humanWaits: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
            readonly humanWaitSources: Schema.optional<Schema.$Array<Schema.Struct<{
                readonly executionId: Schema.String;
                readonly generation: Schema.Number;
                readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
                readonly fromSequence: Schema.Number;
                readonly throughSequence: Schema.Number;
            }>>>;
            readonly currentExecutionId: Schema.optional<Schema.String>;
            readonly generation: Schema.optional<Schema.Number>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly createdAt: Schema.Number;
        readonly updatedAt: Schema.Number;
        readonly planId: Schema.optional<Schema.String>;
        readonly planDigest: Schema.optional<Schema.String>;
        readonly parentRunId: Schema.optional<Schema.String>;
        readonly lineageId: Schema.optional<Schema.String>;
        readonly roundOrdinal: Schema.optional<Schema.Number>;
        readonly waitingReason: Schema.optional<Schema.String>;
        readonly steeringPending: Schema.optional<Schema.Number>;
        readonly cancellation: Schema.optional<Schema.Struct<{
            readonly requestedAt: Schema.Number;
            readonly source: Schema.Literals<readonly ["control", "engine", "cascade"]>;
            readonly principal: Schema.optional<Schema.Struct<{
                readonly id: Schema.String;
                readonly kind: Schema.String;
                readonly stampedAt: Schema.Number;
            }>>;
            readonly reason: Schema.optional<Schema.String>;
            readonly cascadedFrom: Schema.optional<Schema.String>;
        }>>;
        readonly deadlineAt: Schema.optional<Schema.Number>;
        readonly seat: Schema.optional<Schema.String>;
        readonly turns: Schema.Number;
        readonly calls: Schema.Number;
        readonly callsFailed: Schema.Number;
        readonly editsAttempted: Schema.Number;
        readonly editsSucceeded: Schema.Number;
        readonly inputTokens: Schema.Number;
        readonly outputTokens: Schema.Number;
        readonly verdict: Schema.String;
        readonly diagnosis: Schema.String;
        readonly finalOutput: Schema.optional<Schema.String>;
        readonly failureFault: Schema.optional<Schema.Literals<readonly ["user", "wait", "infra", "dependency", "bug", "factory", "policy"]>>;
        readonly failureMessage: Schema.optional<Schema.String>;
        readonly failureTag: Schema.optional<Schema.String>;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"run-summary", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly runId: Schema.String;
        readonly flowId: Schema.String;
        readonly statusRollup: Schema.optional<Schema.Struct<{
            readonly subjectId: Schema.String;
            readonly state: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
            readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
            readonly health: Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
            readonly attention: Schema.Literals<readonly ["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"]>;
            readonly freshness: Schema.Literals<readonly ["fresh", "stale", "unobserved"]>;
            readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
            readonly provenance: Schema.optional<Schema.Struct<{
                readonly checkerId: Schema.String;
                readonly monitorId: Schema.String;
                readonly observedAt: Schema.Int;
                readonly expiresAt: Schema.Int;
                readonly evidenceSeq: Schema.Int;
                readonly incarnation: Schema.String;
                readonly version: Schema.Int;
            }>>;
            readonly updatedAt: Schema.Int;
        }>>;
        readonly status: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>;
        readonly lifecycleProvenance: Schema.optional<Schema.Struct<{
            readonly control: Schema.Literals<readonly ["events", "legacy-snapshot", "unverified-snapshot"]>;
            readonly execution: Schema.Literals<readonly ["control", "engine-observed", "engine-missing"]>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly executionProvenance: Schema.optional<Schema.Struct<{
            readonly source: Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>;
            readonly rootExecutionId: Schema.String;
            readonly humanWaits: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
            readonly humanWaitSources: Schema.optional<Schema.$Array<Schema.Struct<{
                readonly executionId: Schema.String;
                readonly generation: Schema.Number;
                readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
                readonly fromSequence: Schema.Number;
                readonly throughSequence: Schema.Number;
            }>>>;
            readonly currentExecutionId: Schema.optional<Schema.String>;
            readonly generation: Schema.optional<Schema.Number>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly createdAt: Schema.Number;
        readonly updatedAt: Schema.Number;
        readonly planId: Schema.optional<Schema.String>;
        readonly planDigest: Schema.optional<Schema.String>;
        readonly parentRunId: Schema.optional<Schema.String>;
        readonly lineageId: Schema.optional<Schema.String>;
        readonly roundOrdinal: Schema.optional<Schema.Number>;
        readonly waitingReason: Schema.optional<Schema.String>;
        readonly steeringPending: Schema.optional<Schema.Number>;
        readonly cancellation: Schema.optional<Schema.Struct<{
            readonly requestedAt: Schema.Number;
            readonly source: Schema.Literals<readonly ["control", "engine", "cascade"]>;
            readonly principal: Schema.optional<Schema.Struct<{
                readonly id: Schema.String;
                readonly kind: Schema.String;
                readonly stampedAt: Schema.Number;
            }>>;
            readonly reason: Schema.optional<Schema.String>;
            readonly cascadedFrom: Schema.optional<Schema.String>;
        }>>;
        readonly deadlineAt: Schema.optional<Schema.Number>;
        readonly seat: Schema.optional<Schema.String>;
        readonly turns: Schema.Number;
        readonly calls: Schema.Number;
        readonly callsFailed: Schema.Number;
        readonly editsAttempted: Schema.Number;
        readonly editsSucceeded: Schema.Number;
        readonly inputTokens: Schema.Number;
        readonly outputTokens: Schema.Number;
        readonly verdict: Schema.String;
        readonly diagnosis: Schema.String;
        readonly finalOutput: Schema.optional<Schema.String>;
        readonly failureFault: Schema.optional<Schema.Literals<readonly ["user", "wait", "infra", "dependency", "bug", "factory", "policy"]>>;
        readonly failureMessage: Schema.optional<Schema.String>;
        readonly failureTag: Schema.optional<Schema.String>;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"run-events", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly cursor: Schema.optional<Schema.Struct<{
            readonly sequence: Schema.Int;
            readonly offset: Schema.optional<Schema.Int>;
        }>>;
        readonly sequence: Schema.Number;
        readonly kind: Schema.String;
        readonly runId: Schema.optional<Schema.String>;
        readonly occurredAt: Schema.Number;
        readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"transcript", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly runId: Schema.String;
        readonly sequence: Schema.Number;
        readonly turn: Schema.Number;
        readonly at: Schema.Number;
        readonly kind: Schema.String;
        readonly callId: Schema.optional<Schema.String>;
        readonly text: Schema.String;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"run-tree", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
        readonly label: Schema.String;
        readonly status: Schema.Literals<readonly ["running", "completed", "failed"]>;
        readonly seat: Schema.optional<Schema.String>;
        readonly startedAt: Schema.Number;
        readonly endedAt: Schema.optional<Schema.Number>;
        readonly parentRunId: Schema.optional<Schema.String>;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"approvals", {
        readonly runId: Schema.optional<Schema.String>;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly runId: Schema.String;
        readonly waitRunId: Schema.optional<Schema.String>;
        readonly questionProvenance: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
        readonly requestId: Schema.String;
        readonly title: Schema.String;
        readonly request: Schema.Codec<Schema.Json, Schema.Json, never, never>;
        readonly payload: Schema.Struct<{
            readonly target: Schema.Union<readonly [Schema.TaggedStruct<"Plan", {
                readonly planId: Schema.String;
                readonly digest: Schema.String;
                readonly envelope: Schema.Struct<{
                    readonly capabilities: Schema.$Array<Schema.String>;
                    readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
                    readonly flows: Schema.$Array<Schema.String>;
                    readonly budget: Schema.Struct<{
                        readonly tokens: Schema.optional<Schema.Number>;
                        readonly milliseconds: Schema.optional<Schema.Number>;
                        readonly usd: Schema.optional<Schema.Number>;
                        readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                        readonly deadline: Schema.optional<Schema.Int>;
                    }>;
                    readonly host: Schema.optional<Schema.String>;
                }>;
            }>, Schema.TaggedStruct<"Node", {
                readonly runId: Schema.String;
                readonly requestId: Schema.String;
                readonly digest: Schema.String;
                readonly envelope: Schema.Struct<{
                    readonly capabilities: Schema.$Array<Schema.String>;
                    readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
                    readonly flows: Schema.$Array<Schema.String>;
                    readonly budget: Schema.Struct<{
                        readonly tokens: Schema.optional<Schema.Number>;
                        readonly milliseconds: Schema.optional<Schema.Number>;
                        readonly usd: Schema.optional<Schema.Number>;
                        readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                        readonly deadline: Schema.optional<Schema.Int>;
                    }>;
                    readonly host: Schema.optional<Schema.String>;
                }>;
            }>]>;
            readonly scope: Schema.Literals<readonly ["once", "run", "remembered"]>;
            readonly idempotencyKey: Schema.String;
        }>;
        readonly requestedAt: Schema.Number;
        readonly status: Schema.Literals<readonly ["pending", "approved", "denied"]>;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"node-output", {
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
        readonly outcome: Schema.Literals<readonly ["success", "failure"]>;
        readonly output: Schema.String;
        readonly settledAt: Schema.Number;
    }>;
}>, Schema.TaggedStruct<"row", {
    readonly selector: Schema.TaggedStruct<"flow-durations", {
        readonly flowId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly row: Schema.Struct<{
        readonly flowId: Schema.String;
        readonly actionTag: Schema.String;
        readonly samples: Schema.Number;
        readonly p50Ms: Schema.Number;
        readonly p90Ms: Schema.Number;
    }>;
}>, Schema.TaggedStruct<"snapshot-end", {
    readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
        readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
    }>, Schema.TaggedStruct<"run-summary", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"run-events", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"transcript", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"run-tree", {
        readonly runId: Schema.String;
    }>, Schema.TaggedStruct<"approvals", {
        readonly runId: Schema.optional<Schema.String>;
    }>, Schema.TaggedStruct<"node-output", {
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
    }>, Schema.TaggedStruct<"flow-durations", {
        readonly flowId: Schema.String;
    }>]>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"workspace-runs", {
        readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly flowId: Schema.String;
        readonly statusRollup: Schema.optional<Schema.Struct<{
            readonly subjectId: Schema.String;
            readonly state: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
            readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
            readonly health: Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
            readonly attention: Schema.Literals<readonly ["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"]>;
            readonly freshness: Schema.Literals<readonly ["fresh", "stale", "unobserved"]>;
            readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
            readonly provenance: Schema.optional<Schema.Struct<{
                readonly checkerId: Schema.String;
                readonly monitorId: Schema.String;
                readonly observedAt: Schema.Int;
                readonly expiresAt: Schema.Int;
                readonly evidenceSeq: Schema.Int;
                readonly incarnation: Schema.String;
                readonly version: Schema.Int;
            }>>;
            readonly updatedAt: Schema.Int;
        }>>;
        readonly status: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>;
        readonly lifecycleProvenance: Schema.optional<Schema.Struct<{
            readonly control: Schema.Literals<readonly ["events", "legacy-snapshot", "unverified-snapshot"]>;
            readonly execution: Schema.Literals<readonly ["control", "engine-observed", "engine-missing"]>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly executionProvenance: Schema.optional<Schema.Struct<{
            readonly source: Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>;
            readonly rootExecutionId: Schema.String;
            readonly humanWaits: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
            readonly humanWaitSources: Schema.optional<Schema.$Array<Schema.Struct<{
                readonly executionId: Schema.String;
                readonly generation: Schema.Number;
                readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
                readonly fromSequence: Schema.Number;
                readonly throughSequence: Schema.Number;
            }>>>;
            readonly currentExecutionId: Schema.optional<Schema.String>;
            readonly generation: Schema.optional<Schema.Number>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly createdAt: Schema.Number;
        readonly updatedAt: Schema.Number;
        readonly planId: Schema.optional<Schema.String>;
        readonly planDigest: Schema.optional<Schema.String>;
        readonly parentRunId: Schema.optional<Schema.String>;
        readonly lineageId: Schema.optional<Schema.String>;
        readonly roundOrdinal: Schema.optional<Schema.Number>;
        readonly waitingReason: Schema.optional<Schema.String>;
        readonly steeringPending: Schema.optional<Schema.Number>;
        readonly cancellation: Schema.optional<Schema.Struct<{
            readonly requestedAt: Schema.Number;
            readonly source: Schema.Literals<readonly ["control", "engine", "cascade"]>;
            readonly principal: Schema.optional<Schema.Struct<{
                readonly id: Schema.String;
                readonly kind: Schema.String;
                readonly stampedAt: Schema.Number;
            }>>;
            readonly reason: Schema.optional<Schema.String>;
            readonly cascadedFrom: Schema.optional<Schema.String>;
        }>>;
        readonly deadlineAt: Schema.optional<Schema.Number>;
        readonly seat: Schema.optional<Schema.String>;
        readonly turns: Schema.Number;
        readonly calls: Schema.Number;
        readonly callsFailed: Schema.Number;
        readonly editsAttempted: Schema.Number;
        readonly editsSucceeded: Schema.Number;
        readonly inputTokens: Schema.Number;
        readonly outputTokens: Schema.Number;
        readonly verdict: Schema.String;
        readonly diagnosis: Schema.String;
        readonly finalOutput: Schema.optional<Schema.String>;
        readonly failureFault: Schema.optional<Schema.Literals<readonly ["user", "wait", "infra", "dependency", "bug", "factory", "policy"]>>;
        readonly failureMessage: Schema.optional<Schema.String>;
        readonly failureTag: Schema.optional<Schema.String>;
    }>>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"run-summary", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly flowId: Schema.String;
        readonly statusRollup: Schema.optional<Schema.Struct<{
            readonly subjectId: Schema.String;
            readonly state: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"]>;
            readonly activity: Schema.Literals<readonly ["working", "idle", "needs-input", "unknown"]>;
            readonly health: Schema.Literals<readonly ["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]>;
            readonly attention: Schema.Literals<readonly ["none", "awaiting-approval", "needs-input", "needs-resume", "unhealthy"]>;
            readonly freshness: Schema.Literals<readonly ["fresh", "stale", "unobserved"]>;
            readonly reason: Schema.optional<Schema.Literals<readonly ["ok", "no-progress", "awaiting-reply", "prompt-detected", "quota-wait", "timer-wait", "event-wait", "released", "unreachable", "probe-timeout", "probe-error", "owner-changed"]>>;
            readonly provenance: Schema.optional<Schema.Struct<{
                readonly checkerId: Schema.String;
                readonly monitorId: Schema.String;
                readonly observedAt: Schema.Int;
                readonly expiresAt: Schema.Int;
                readonly evidenceSeq: Schema.Int;
                readonly incarnation: Schema.String;
                readonly version: Schema.Int;
            }>>;
            readonly updatedAt: Schema.Int;
        }>>;
        readonly status: Schema.Literals<readonly ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]>;
        readonly lifecycleProvenance: Schema.optional<Schema.Struct<{
            readonly control: Schema.Literals<readonly ["events", "legacy-snapshot", "unverified-snapshot"]>;
            readonly execution: Schema.Literals<readonly ["control", "engine-observed", "engine-missing"]>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly executionProvenance: Schema.optional<Schema.Struct<{
            readonly source: Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>;
            readonly rootExecutionId: Schema.String;
            readonly humanWaits: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
            readonly humanWaitSources: Schema.optional<Schema.$Array<Schema.Struct<{
                readonly executionId: Schema.String;
                readonly generation: Schema.Number;
                readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
                readonly fromSequence: Schema.Number;
                readonly throughSequence: Schema.Number;
            }>>>;
            readonly currentExecutionId: Schema.optional<Schema.String>;
            readonly generation: Schema.optional<Schema.Number>;
            readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
            readonly fromSequence: Schema.optional<Schema.Number>;
            readonly throughSequence: Schema.optional<Schema.Number>;
        }>>;
        readonly createdAt: Schema.Number;
        readonly updatedAt: Schema.Number;
        readonly planId: Schema.optional<Schema.String>;
        readonly planDigest: Schema.optional<Schema.String>;
        readonly parentRunId: Schema.optional<Schema.String>;
        readonly lineageId: Schema.optional<Schema.String>;
        readonly roundOrdinal: Schema.optional<Schema.Number>;
        readonly waitingReason: Schema.optional<Schema.String>;
        readonly steeringPending: Schema.optional<Schema.Number>;
        readonly cancellation: Schema.optional<Schema.Struct<{
            readonly requestedAt: Schema.Number;
            readonly source: Schema.Literals<readonly ["control", "engine", "cascade"]>;
            readonly principal: Schema.optional<Schema.Struct<{
                readonly id: Schema.String;
                readonly kind: Schema.String;
                readonly stampedAt: Schema.Number;
            }>>;
            readonly reason: Schema.optional<Schema.String>;
            readonly cascadedFrom: Schema.optional<Schema.String>;
        }>>;
        readonly deadlineAt: Schema.optional<Schema.Number>;
        readonly seat: Schema.optional<Schema.String>;
        readonly turns: Schema.Number;
        readonly calls: Schema.Number;
        readonly callsFailed: Schema.Number;
        readonly editsAttempted: Schema.Number;
        readonly editsSucceeded: Schema.Number;
        readonly inputTokens: Schema.Number;
        readonly outputTokens: Schema.Number;
        readonly verdict: Schema.String;
        readonly diagnosis: Schema.String;
        readonly finalOutput: Schema.optional<Schema.String>;
        readonly failureFault: Schema.optional<Schema.Literals<readonly ["user", "wait", "infra", "dependency", "bug", "factory", "policy"]>>;
        readonly failureMessage: Schema.optional<Schema.String>;
        readonly failureTag: Schema.optional<Schema.String>;
    }>>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"run-events", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly cursor: Schema.optional<Schema.Struct<{
            readonly sequence: Schema.Int;
            readonly offset: Schema.optional<Schema.Int>;
        }>>;
        readonly sequence: Schema.Number;
        readonly kind: Schema.String;
        readonly runId: Schema.optional<Schema.String>;
        readonly occurredAt: Schema.Number;
        readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    }>>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"transcript", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly sequence: Schema.Number;
        readonly turn: Schema.Number;
        readonly at: Schema.Number;
        readonly kind: Schema.String;
        readonly callId: Schema.optional<Schema.String>;
        readonly text: Schema.String;
    }>>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"run-tree", {
        readonly runId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
        readonly label: Schema.String;
        readonly status: Schema.Literals<readonly ["running", "completed", "failed"]>;
        readonly seat: Schema.optional<Schema.String>;
        readonly startedAt: Schema.Number;
        readonly endedAt: Schema.optional<Schema.Number>;
        readonly parentRunId: Schema.optional<Schema.String>;
    }>>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"approvals", {
        readonly runId: Schema.optional<Schema.String>;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly waitRunId: Schema.optional<Schema.String>;
        readonly questionProvenance: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
        readonly requestId: Schema.String;
        readonly title: Schema.String;
        readonly request: Schema.Codec<Schema.Json, Schema.Json, never, never>;
        readonly payload: Schema.Struct<{
            readonly target: Schema.Union<readonly [Schema.TaggedStruct<"Plan", {
                readonly planId: Schema.String;
                readonly digest: Schema.String;
                readonly envelope: Schema.Struct<{
                    readonly capabilities: Schema.$Array<Schema.String>;
                    readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
                    readonly flows: Schema.$Array<Schema.String>;
                    readonly budget: Schema.Struct<{
                        readonly tokens: Schema.optional<Schema.Number>;
                        readonly milliseconds: Schema.optional<Schema.Number>;
                        readonly usd: Schema.optional<Schema.Number>;
                        readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                        readonly deadline: Schema.optional<Schema.Int>;
                    }>;
                    readonly host: Schema.optional<Schema.String>;
                }>;
            }>, Schema.TaggedStruct<"Node", {
                readonly runId: Schema.String;
                readonly requestId: Schema.String;
                readonly digest: Schema.String;
                readonly envelope: Schema.Struct<{
                    readonly capabilities: Schema.$Array<Schema.String>;
                    readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
                    readonly flows: Schema.$Array<Schema.String>;
                    readonly budget: Schema.Struct<{
                        readonly tokens: Schema.optional<Schema.Number>;
                        readonly milliseconds: Schema.optional<Schema.Number>;
                        readonly usd: Schema.optional<Schema.Number>;
                        readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
                        readonly deadline: Schema.optional<Schema.Int>;
                    }>;
                    readonly host: Schema.optional<Schema.String>;
                }>;
            }>]>;
            readonly scope: Schema.Literals<readonly ["once", "run", "remembered"]>;
            readonly idempotencyKey: Schema.String;
        }>;
        readonly requestedAt: Schema.Number;
        readonly status: Schema.Literals<readonly ["pending", "approved", "denied"]>;
    }>>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"node-output", {
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly runId: Schema.String;
        readonly nodeId: Schema.String;
        readonly outcome: Schema.Literals<readonly ["success", "failure"]>;
        readonly output: Schema.String;
        readonly settledAt: Schema.Number;
    }>>;
}>, Schema.TaggedStruct<"delta", {
    readonly selector: Schema.TaggedStruct<"flow-durations", {
        readonly flowId: Schema.String;
    }>;
    readonly cursor: Schema.Struct<{
        readonly selector: Schema.Union<readonly [Schema.TaggedStruct<"workspace-runs", {
            readonly flowId: Schema.optionalKey<Schema.NonEmptyString>;
        }>, Schema.TaggedStruct<"run-summary", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-events", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"transcript", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"run-tree", {
            readonly runId: Schema.String;
        }>, Schema.TaggedStruct<"approvals", {
            readonly runId: Schema.optional<Schema.String>;
        }>, Schema.TaggedStruct<"node-output", {
            readonly runId: Schema.String;
            readonly nodeId: Schema.String;
        }>, Schema.TaggedStruct<"flow-durations", {
            readonly flowId: Schema.String;
        }>]>;
        readonly projection: Schema.Literals<readonly ["workspace-runs", "run-summary", "run-events", "transcript", "run-tree", "approvals", "node-output", "flow-durations"]>;
        readonly runId: Schema.NullOr<Schema.String>;
        readonly value: Schema.Int;
        readonly offset: Schema.Int;
    }>;
    readonly delta: Schema.$Array<Schema.Struct<{
        readonly flowId: Schema.String;
        readonly actionTag: Schema.String;
        readonly samples: Schema.Number;
        readonly p50Ms: Schema.Number;
        readonly p90Ms: Schema.Number;
    }>>;
}>, Schema.TaggedStruct<"heartbeat", {
    readonly atMs: Schema.Number;
}>]>;
/**
 * A frame sent by the gateway subscription protocol.
 *
 * @since 0.1.0
 * @category models
 */
export type GatewayFrame = typeof GatewayFrame.Type;
/**
 * The snapshot one selector answers with.
 *
 * A literal selector keeps its own rows: `SnapshotOf<ApprovalsSelector>` has
 * `ApprovalRow` rows, so a caller reads `requestId` without an assertion. A
 * selector union maps to the snapshot union, which is what a caller holding a
 * selector chosen at runtime still gets.
 *
 * @since 1.0.0
 * @category models
 */
export type SnapshotOf<S extends ProjectionSelector> = Extract<ProjectionSnapshot, {
    readonly selector: {
        readonly _tag: S["_tag"];
    };
}>;
/**
 * The frames one selector's subscription emits.
 *
 * Snapshot brackets and keepalives carry no rows and belong to every
 * selector; the row and delta frames are the selector's own.
 *
 * @since 1.0.0
 * @category models
 */
export type FrameOf<S extends ProjectionSelector> = SnapshotStartFrame | SnapshotEndFrame | HeartbeatFrame | Extract<RowFrame, {
    readonly selector: {
        readonly _tag: S["_tag"];
    };
}> | Extract<DeltaFrame, {
    readonly selector: {
        readonly _tag: S["_tag"];
    };
}>;
export {};
