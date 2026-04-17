import type { Effect } from "effect";
import type { AlertRow } from "../adapter/AlertRow.ts";
import type { AlertStatus } from "../adapter/AlertStatus.ts";
import type { AttemptRow } from "../adapter/AttemptRow.ts";
import type { ApprovalRow } from "../adapter/ApprovalRow.ts";
import type { CacheRow } from "../adapter/CacheRow.ts";
import type { EventHistoryQuery } from "../adapter/EventHistoryQuery.ts";
import type { HumanRequestRow } from "../adapter/HumanRequestRow.ts";
import type { NodeRow } from "../adapter/NodeRow.ts";
import type { PendingHumanRequestRow } from "../adapter/PendingHumanRequestRow.ts";
import type { RunAncestryRow } from "../adapter/RunAncestryRow.ts";
import type { SignalQuery } from "../adapter/SignalQuery.ts";
import type { SignalRow } from "../adapter/SignalRow.ts";
import type { StaleRunRecord } from "../adapter/StaleRunRecord.ts";
import type {
  Attempt,
  AttemptPatch,
  ClaimRunForResumeParams,
  CronRow,
  EventInsertRow,
  EventRow,
  FrameRow,
  JsonRecord,
  OutputKey,
  RalphRow,
  ReleaseRunResumeClaimParams,
  Run,
  RunPatch,
  SandboxRow,
  ScorerResultRow,
  SignalInsertRow,
  ToolCallRow,
  UpdateClaimedRunParams,
} from "./StorageServiceTypes.ts";

export type StorageServiceShape = {
  readonly rawQuery: (queryString: string) => Effect.Effect<readonly JsonRecord[]>;
  readonly insertRun: (run: Run) => Effect.Effect<void>;
  readonly updateRun: (runId: string, patch: RunPatch) => Effect.Effect<void>;
  readonly heartbeatRun: (runId: string, runtimeOwnerId: string, heartbeatAtMs: number) => Effect.Effect<void>;
  readonly requestRunCancel: (runId: string, cancelRequestedAtMs: number) => Effect.Effect<void>;
  readonly requestRunHijack: (runId: string, hijackRequestedAtMs: number, hijackTarget?: string | null) => Effect.Effect<void>;
  readonly clearRunHijack: (runId: string) => Effect.Effect<void>;
  readonly getRun: (runId: string) => Effect.Effect<Run | null>;
  readonly listRunAncestry: (runId: string, limit?: number) => Effect.Effect<readonly RunAncestryRow[]>;
  readonly getLatestChildRun: (parentRunId: string) => Effect.Effect<Run | null>;
  readonly listRuns: (limit?: number, status?: string) => Effect.Effect<readonly Run[]>;
  readonly listStaleRunningRuns: (staleBeforeMs: number, limit?: number) => Effect.Effect<readonly StaleRunRecord[]>;
  readonly claimRunForResume: (params: ClaimRunForResumeParams) => Effect.Effect<boolean>;
  readonly releaseRunResumeClaim: (params: ReleaseRunResumeClaimParams) => Effect.Effect<void>;
  readonly updateClaimedRun: (params: UpdateClaimedRunParams) => Effect.Effect<boolean>;
  readonly insertNode: (node: NodeRow) => Effect.Effect<void>;
  readonly getNode: (runId: string, nodeId: string, iteration: number) => Effect.Effect<NodeRow | null>;
  readonly listNodeIterations: (runId: string, nodeId: string) => Effect.Effect<readonly NodeRow[]>;
  readonly listNodes: (runId: string) => Effect.Effect<readonly NodeRow[]>;
  readonly countNodesByState: (runId: string) => Effect.Effect<readonly {
    readonly state: string;
    readonly count: number;
  }[]>;
  readonly upsertOutputRow: (tableName: string, key: OutputKey, row: JsonRecord) => Effect.Effect<void>;
  readonly deleteOutputRow: (tableName: string, key: OutputKey) => Effect.Effect<void>;
  readonly getRawNodeOutput: (tableName: string, runId: string, nodeId: string) => Effect.Effect<JsonRecord | null>;
  readonly getRawNodeOutputForIteration: (tableName: string, runId: string, nodeId: string, iteration: number) => Effect.Effect<JsonRecord | null>;
  readonly insertAttempt: (attempt: AttemptRow) => Effect.Effect<void>;
  readonly updateAttempt: (runId: string, nodeId: string, iteration: number, attempt: number, patch: AttemptPatch) => Effect.Effect<void>;
  readonly heartbeatAttempt: (runId: string, nodeId: string, iteration: number, attempt: number, heartbeatAtMs: number, heartbeatDataJson?: string | null) => Effect.Effect<void>;
  readonly listAttempts: (runId: string, nodeId: string, iteration: number) => Effect.Effect<readonly Attempt[]>;
  readonly listAttemptsForRun: (runId: string) => Effect.Effect<readonly Attempt[]>;
  readonly getAttempt: (runId: string, nodeId: string, iteration: number, attempt: number) => Effect.Effect<Attempt | null>;
  readonly listInProgressAttempts: (runId: string) => Effect.Effect<readonly Attempt[]>;
  readonly listAllInProgressAttempts: () => Effect.Effect<readonly Attempt[]>;
  readonly insertFrame: (frame: FrameRow) => Effect.Effect<void>;
  readonly getLastFrame: (runId: string) => Effect.Effect<FrameRow | null>;
  readonly deleteFramesAfter: (runId: string, frameNo: number) => Effect.Effect<void>;
  readonly listFrames: (runId: string, limit: number, afterFrameNo?: number) => Effect.Effect<readonly FrameRow[]>;
  readonly insertOrUpdateApproval: (approval: ApprovalRow) => Effect.Effect<void>;
  readonly getApproval: (runId: string, nodeId: string, iteration: number) => Effect.Effect<ApprovalRow | null>;
  readonly listPendingApprovals: (runId: string) => Effect.Effect<readonly ApprovalRow[]>;
  readonly listAllPendingApprovals: () => Effect.Effect<readonly ApprovalRow[]>;
  readonly listApprovalHistoryForNode: (workflowName: string, nodeId: string, limit?: number) => Effect.Effect<readonly ApprovalRow[]>;
  readonly insertHumanRequest: (row: HumanRequestRow) => Effect.Effect<void>;
  readonly getHumanRequest: (requestId: string) => Effect.Effect<HumanRequestRow | null>;
  readonly reopenHumanRequest: (requestId: string) => Effect.Effect<void>;
  readonly expireStaleHumanRequests: (nowMs?: number) => Effect.Effect<readonly HumanRequestRow[]>;
  readonly listPendingHumanRequests: (nowMs?: number) => Effect.Effect<readonly PendingHumanRequestRow[]>;
  readonly answerHumanRequest: (requestId: string, responseJson: string, answeredBy?: string | null, answeredAtMs?: number) => Effect.Effect<void>;
  readonly cancelHumanRequest: (requestId: string) => Effect.Effect<void>;
  readonly insertAlert: (row: AlertRow) => Effect.Effect<void>;
  readonly getAlert: (alertId: string) => Effect.Effect<AlertRow | null>;
  readonly listAlerts: (limit?: number, statuses?: readonly AlertStatus[]) => Effect.Effect<readonly AlertRow[]>;
  readonly acknowledgeAlert: (alertId: string, acknowledgedAtMs?: number) => Effect.Effect<void>;
  readonly resolveAlert: (alertId: string, resolvedAtMs?: number) => Effect.Effect<void>;
  readonly silenceAlert: (alertId: string) => Effect.Effect<void>;
  readonly insertSignalWithNextSeq: (row: SignalInsertRow) => Effect.Effect<number>;
  readonly getLastSignalSeq: (runId: string) => Effect.Effect<number | null>;
  readonly listSignals: (runId: string, query?: SignalQuery) => Effect.Effect<readonly SignalRow[]>;
  readonly insertToolCall: (row: ToolCallRow) => Effect.Effect<void>;
  readonly listToolCalls: (runId: string, nodeId: string, iteration: number) => Effect.Effect<readonly ToolCallRow[]>;
  readonly upsertSandbox: (row: SandboxRow) => Effect.Effect<void>;
  readonly getSandbox: (runId: string, sandboxId: string) => Effect.Effect<SandboxRow | null>;
  readonly listSandboxes: (runId: string) => Effect.Effect<readonly SandboxRow[]>;
  readonly insertEvent: (row: EventRow) => Effect.Effect<void>;
  readonly insertEventWithNextSeq: (row: EventInsertRow) => Effect.Effect<number>;
  readonly getLastEventSeq: (runId: string) => Effect.Effect<number | null>;
  readonly listEventHistory: (runId: string, query?: EventHistoryQuery) => Effect.Effect<readonly EventRow[]>;
  readonly countEventHistory: (runId: string, query?: EventHistoryQuery) => Effect.Effect<number>;
  readonly listEvents: (runId: string, afterSeq: number, limit?: number) => Effect.Effect<readonly EventRow[]>;
  readonly listEventsByType: (runId: string, type: string) => Effect.Effect<readonly EventRow[]>;
  readonly insertOrUpdateRalph: (row: RalphRow) => Effect.Effect<void>;
  readonly listRalph: (runId: string) => Effect.Effect<readonly RalphRow[]>;
  readonly getRalph: (runId: string, ralphId: string) => Effect.Effect<RalphRow | null>;
  readonly insertCache: (row: CacheRow) => Effect.Effect<void>;
  readonly getCache: (cacheKey: string) => Effect.Effect<CacheRow | null>;
  readonly listCacheByNode: (nodeId: string, outputTable?: string, limit?: number) => Effect.Effect<readonly CacheRow[]>;
  readonly upsertCron: (row: CronRow) => Effect.Effect<void>;
  readonly listCrons: (enabledOnly?: boolean) => Effect.Effect<readonly CronRow[]>;
  readonly updateCronRunTime: (cronId: string, lastRunAtMs: number, nextRunAtMs: number, errorJson?: string | null) => Effect.Effect<void>;
  readonly deleteCron: (cronId: string) => Effect.Effect<void>;
  readonly insertScorerResult: (row: ScorerResultRow) => Effect.Effect<void>;
  readonly listScorerResults: (runId: string, nodeId?: string) => Effect.Effect<readonly ScorerResultRow[]>;
  readonly withTransaction: <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};
