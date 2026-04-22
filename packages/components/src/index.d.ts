import * as _smithers_driver_workflow_types from '@smithers-orchestrator/driver/workflow-types';
import * as _smithers_driver_WorkflowDriverOptions from '@smithers-orchestrator/driver/WorkflowDriverOptions';
import * as _smithers_driver_WorkflowDefinition from '@smithers-orchestrator/driver/WorkflowDefinition';
import { WorkflowDefinition } from '@smithers-orchestrator/driver/WorkflowDefinition';
import * as _smithers_errors_SmithersErrorCode from '@smithers-orchestrator/errors/SmithersErrorCode';
import { SmithersErrorCode as SmithersErrorCode$1 } from '@smithers-orchestrator/errors/SmithersErrorCode';
import * as _smithers_scheduler_SmithersWorkflowOptions from '@smithers-orchestrator/scheduler/SmithersWorkflowOptions';
import * as _smithers_db_SchemaRegistryEntry from '@smithers-orchestrator/db/SchemaRegistryEntry';
import * as _smithers_driver from '@smithers-orchestrator/driver';
import { SmithersCtx as SmithersCtx$1 } from '@smithers-orchestrator/driver';
import * as _smithers_driver_RunAuthContext from '@smithers-orchestrator/driver/RunAuthContext';
import * as _smithers_scheduler_RetryPolicy from '@smithers-orchestrator/scheduler/RetryPolicy';
import { RetryPolicy as RetryPolicy$1 } from '@smithers-orchestrator/scheduler/RetryPolicy';
import * as _smithers_driver_OutputKey from '@smithers-orchestrator/driver/OutputKey';
import * as _smithers_driver_OutputAccessor from '@smithers-orchestrator/driver/OutputAccessor';
import { InferOutputEntry as InferOutputEntry$1 } from '@smithers-orchestrator/driver/OutputAccessor';
import * as _smithers_graph from '@smithers-orchestrator/graph';
import * as _smithers_scheduler from '@smithers-orchestrator/scheduler';
import * as _smithers_scheduler_CachePolicy from '@smithers-orchestrator/scheduler/CachePolicy';
import { CachePolicy as CachePolicy$1 } from '@smithers-orchestrator/scheduler/CachePolicy';
import React from 'react';
import * as zod from 'zod';
import { z } from 'zod';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';
import { AgentLike } from '@smithers-orchestrator/agents/AgentLike';
import * as _smithers_scorers_types from '@smithers-orchestrator/scorers/types';
import { ScorersMap as ScorersMap$1 } from '@smithers-orchestrator/scorers/types';
import { TaskMemoryConfig } from '@smithers-orchestrator/memory/types';
import * as _smithers_errors from '@smithers-orchestrator/errors';
import * as zod_v4_core from 'zod/v4/core';

type WorktreeProps$2 = {
    id?: string;
    path: string;
    branch?: string;
    /** Base branch for syncing worktrees (default: "main"). */
    baseBranch?: string;
    skipIf?: boolean;
    children?: React.ReactNode;
};

type WorkflowProps$2 = {
    name: string;
    cache?: boolean;
    children?: React.ReactNode;
};

/** Valid output targets: a Zod schema (recommended), a Drizzle table object, or a string key (escape hatch). */
type OutputTarget$1 = z.ZodObject<z.ZodRawShape> | {
    $inferSelect: Record<string, unknown>;
} | string;

type WaitForEventProps$2 = {
    id: string;
    /** Event name/type to wait for. */
    event: string;
    /** Correlation key to match the right event instance. */
    correlationId?: string;
    /** Where to store the event payload. */
    output: OutputTarget$1;
    /** Zod schema for the event payload. */
    outputSchema?: z.ZodObject<z.ZodRawShape>;
    /** Max wait time in ms before timing out. */
    timeoutMs?: number;
    /** Behavior on timeout: fail (default), skip the node, or continue with null. */
    onTimeout?: "fail" | "skip" | "continue";
    /** Do not block unrelated downstream flow while waiting for the event. */
    async?: boolean;
    skipIf?: boolean;
    /** Explicit dependency on other task node IDs. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
};

type TryCatchFinallyProps$2 = {
    id?: string;
    try: React.ReactElement;
    catch?: React.ReactElement | ((error: SmithersError) => React.ReactElement);
    catchErrors?: SmithersErrorCode$1[];
    finally?: React.ReactElement;
    skipIf?: boolean;
};

type TimerProps$2 = {
    id: string;
    /**
     * Relative duration (examples: "500ms", "1s", "30m", "1h", "7d").
     */
    duration?: string;
    /**
     * Absolute fire time (ISO timestamp or Date).
     */
    until?: string | Date;
    /**
     * Recurring timer syntax is reserved for phase 2 and is not supported yet.
     */
    every?: string;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
};

type DepsSpec$1 = Record<string, OutputTarget$1>;

type InferDepValue<T> = T extends string ? unknown : InferOutputEntry$1<T>;
type InferDeps$1<D extends DepsSpec$1> = {
    [K in keyof D]: InferDepValue<D[K]>;
};

type TaskProps$2<Row, Output extends OutputTarget$1 = OutputTarget$1, D extends DepsSpec$1 = {}> = {
    key?: string;
    id: string;
    /** Where to store the task's result. Pass a Zod schema from `outputs` (recommended), a Drizzle table, or a string key. */
    output: Output;
    /**
     * Optional Zod schema describing the expected agent output shape.
     * When `output` is already a ZodObject this is inferred automatically.
     * Used for validation and to inject schema examples into MDX prompts.
     */
    outputSchema?: z.ZodObject<z.ZodRawShape>;
    /** Agent or array of agents [primary, fallback1, fallback2, ...]. Tries in order on retries. */
    agent?: AgentLike | AgentLike[];
    /** Convenience alias for a single retry fallback without exposing array syntax in JSX. */
    fallbackAgent?: AgentLike;
    /** Explicit dependency on other task node IDs. The task will not run until all listed tasks complete. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    /** Render-time typed dependencies. Keys resolve from task ids of the same name, or from matching `needs` entries. */
    deps?: D;
    skipIf?: boolean;
    needsApproval?: boolean;
    /** When paired with `needsApproval`, do not block unrelated downstream flow while the approval is pending. */
    async?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    /** Disable retries entirely. Equivalent to retries={0}. */
    noRetry?: boolean;
    retries?: number;
    retryPolicy?: RetryPolicy$1;
    continueOnFail?: boolean;
    cache?: CachePolicy$1;
    /** Optional scorers to evaluate this task's output after completion. */
    scorers?: ScorersMap$1;
    /** Optional cross-run memory configuration. */
    memory?: TaskMemoryConfig;
    /** Request an immediate hijack handoff as soon as the task starts running. */
    hijack?: boolean;
    /** What Smithers should do after a hijacked session exits. */
    onHijackExit?: "complete" | "reopen";
    allowTools?: string[];
    label?: string;
    meta?: Record<string, unknown>;
    /** @internal Used by createSmithers() to bind tasks to the correct workflow context. */
    smithersContext?: React.Context<SmithersCtx$1<unknown> | null>;
    children?: string | Row | (() => Row | Promise<Row>) | React.ReactNode | ((deps: InferDeps$1<D>) => Row | React.ReactNode);
};

type SupervisorProps$2 = {
    id?: string;
    /** Agent that plans, delegates, and reviews worker results. */
    boss: AgentLike;
    /** Map of worker type names to agents (e.g., { coder, tester, docs }). */
    workers: Record<string, AgentLike>;
    /** Output schema for the boss's plan. Must include `tasks: Array<{ id, workerType, instructions }>`. */
    planOutput: OutputTarget$1;
    /** Output schema for individual worker results. */
    workerOutput: OutputTarget$1;
    /** Output schema for the boss's review. Must include `allDone: boolean` and `retriable: string[]`. */
    reviewOutput: OutputTarget$1;
    /** Output schema for the final summary. */
    finalOutput: OutputTarget$1;
    /** Max delegate-review cycles (default 3). */
    maxIterations?: number;
    /** Max parallel workers (default 5). */
    maxConcurrency?: number;
    /** Whether each worker gets its own git worktree (default false). */
    useWorktrees?: boolean;
    skipIf?: boolean;
    /** Goal/prompt for the boss agent. */
    children: string | React.ReactNode;
};

type SuperSmithersProps$2 = {
    /** Optional ID prefix for all generated task IDs. */
    id?: string;
    /** Markdown string or MDX component describing the intervention strategy. */
    strategy: string | React.ReactElement;
    /** Agent that reads code and decides modifications. */
    agent: AgentLike;
    /** Glob patterns of files the agent can modify. */
    targetFiles?: string[];
    /** Output schema for the intervention report (Zod object). */
    reportOutput?: OutputTarget$1;
    /** If true, reports changes without applying them. */
    dryRun?: boolean;
    /** Standard skip predicate. */
    skipIf?: boolean;
};

type SubflowProps$2 = {
    id: string;
    /** The child workflow definition. */
    workflow: WorkflowDefinition<unknown>;
    /** Input to pass to the child workflow. */
    input?: unknown;
    /** `"childRun"` gets its own DB row/run; `"inline"` embeds in parent. */
    mode?: "childRun" | "inline";
    /** Where to store the subflow's result. */
    output: OutputTarget$1;
    skipIf?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    retries?: number;
    retryPolicy?: RetryPolicy$1;
    continueOnFail?: boolean;
    cache?: CachePolicy$1;
    /** Explicit dependency on other task node IDs. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
    children?: React.ReactNode;
};

type SourceDef$1 = {
    agent: AgentLike;
    /** Prompt for this source. A string or ReactNode. */
    prompt?: string;
    /** Output schema for this specific source. Overrides `gatherOutput`. */
    output?: OutputTarget$1;
    children?: React.ReactNode;
};

type SignalProps$2<Schema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> = {
    id: string;
    schema: Schema;
    correlationId?: string;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    /** Do not block unrelated downstream flow while waiting for the signal. */
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
    children?: (data: z.infer<Schema>) => React.ReactNode;
    smithersContext?: React.Context<SmithersCtx$1<unknown> | null>;
};

type SequenceProps$2 = {
    skipIf?: boolean;
    children?: React.ReactNode;
};

type ScanFixVerifyProps$2 = {
    /** ID prefix for generated task/component ids. */
    id?: string;
    /** Agent that scans for problems. */
    scanner: AgentLike;
    /** Agent (or agents) that fixes problems. When an array is provided, agents are cycled across issues. */
    fixer: AgentLike | AgentLike[];
    /** Agent that verifies the fixes were applied correctly. */
    verifier: AgentLike;
    /** Output schema for scan results. Should include `issues: Array`. */
    scanOutput: OutputTarget$1;
    /** Output schema for each individual fix. */
    fixOutput: OutputTarget$1;
    /** Output schema for verification results. */
    verifyOutput: OutputTarget$1;
    /** Output schema for the final summary report. */
    reportOutput: OutputTarget$1;
    /** Maximum number of parallel fix tasks. */
    maxConcurrency?: number;
    /** Maximum scan-fix-verify cycles before stopping. Default 3. */
    maxRetries?: number;
    /** Skip the entire component. */
    skipIf?: boolean;
    /** Prompt/context describing what to scan for. */
    children?: React.ReactNode;
};

type SandboxWorkspaceSpec$1 = {
    name: string;
    snapshotId?: string;
    idleTimeoutSecs?: number;
    persistence?: "ephemeral" | "sticky";
};

type SandboxVolumeMount$1 = {
    host: string;
    container: string;
    readonly?: boolean;
};

type SandboxRuntime$1 = "bubblewrap" | "docker" | "codeplane";

type SandboxProps$2 = {
    id: string;
    /** Child workflow definition. If omitted, createSmithers-bound Sandbox wrappers may provide one. */
    workflow?: WorkflowDefinition<unknown>;
    /** Input passed to the child workflow. */
    input?: unknown;
    output: OutputTarget$1;
    runtime?: SandboxRuntime$1;
    allowNetwork?: boolean;
    reviewDiffs?: boolean;
    autoAcceptDiffs?: boolean;
    image?: string;
    env?: Record<string, string>;
    ports?: Array<{
        host: number;
        container: number;
    }>;
    volumes?: SandboxVolumeMount$1[];
    memoryLimit?: string;
    cpuLimit?: string;
    command?: string;
    workspace?: SandboxWorkspaceSpec$1;
    skipIf?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    retries?: number;
    retryPolicy?: RetryPolicy$1;
    continueOnFail?: boolean;
    cache?: CachePolicy$1;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
    children?: React.ReactNode;
};

type SagaStepProps$2 = {
    id: string;
    compensation: React.ReactElement;
    children: React.ReactElement;
};

type SagaStepDef$1 = {
    id: string;
    action: React.ReactElement;
    compensation: React.ReactElement;
    label?: string;
};

type SagaProps$2 = {
    id?: string;
    steps?: SagaStepDef$1[];
    onFailure?: "compensate" | "compensate-and-fail" | "fail";
    skipIf?: boolean;
    children?: React.ReactNode;
};

type RunbookStep$1 = {
    /** Unique step identifier. */
    id: string;
    /** Agent for this step (falls back to `defaultAgent`). */
    agent?: AgentLike;
    /** Shell command or instruction for the step. */
    command?: string;
    /** Risk classification: safe auto-executes, risky/critical require approval. */
    risk: "safe" | "risky" | "critical";
    /** Human-readable label for the step. */
    label?: string;
    /** Per-step output schema override. */
    output?: OutputTarget$1;
};

type ApprovalRequest$1 = {
    title: string;
    summary?: string;
    metadata?: Record<string, unknown>;
};

type RunbookProps$2 = {
    id?: string;
    /** Ordered steps to execute. */
    steps: RunbookStep$1[];
    /** Default agent for steps that don't specify one. */
    defaultAgent?: AgentLike;
    /** Default output schema for step results. */
    stepOutput: OutputTarget$1;
    /** Template for approval requests on risky/critical steps. */
    approvalRequest?: Partial<ApprovalRequest$1>;
    /** Behavior when a risky/critical step is denied: "fail" (default) or "skip". */
    onDeny?: "fail" | "skip";
    skipIf?: boolean;
};

type ReviewLoopProps$2 = {
    id?: string;
    /** Agent that produces or fixes the work each iteration. */
    producer: AgentLike;
    /** Agent (or agents) that reviews the produced work. */
    reviewer: AgentLike | AgentLike[];
    /** Output schema for the produced work. */
    produceOutput: OutputTarget$1;
    /** Output schema for the review result. Must include an `approved: boolean` field. */
    reviewOutput: OutputTarget$1;
    /** Maximum number of review cycles before stopping. @default 5 */
    maxIterations?: number;
    /** Behavior when maxIterations is reached. @default "return-last" */
    onMaxReached?: "return-last" | "fail";
    /** Skip the entire review loop. */
    skipIf?: boolean;
    /** Initial prompt for the producer (string or ReactNode). */
    children: string | React.ReactNode;
};

type LoopProps$2 = {
    id?: string;
    until?: boolean;
    maxIterations?: number;
    onMaxReached?: "fail" | "return-last";
    continueAsNewEvery?: number;
    skipIf?: boolean;
    children?: React.ReactNode;
};

/** @deprecated Use `LoopProps` instead. */
type RalphProps$1 = LoopProps$2;

type PollerProps$2 = {
    /** ID prefix for generated task/component ids. */
    id?: string;
    /** Agent or compute function that checks the condition. */
    check: AgentLike | (() => unknown | Promise<unknown>);
    /** Output schema for the check result. Must include `satisfied: boolean`. */
    checkOutput: OutputTarget$1;
    /** Maximum poll attempts. Default 30. */
    maxAttempts?: number;
    /** Backoff strategy between polls. Default "fixed". */
    backoff?: "fixed" | "linear" | "exponential";
    /** Base interval in milliseconds between polls. Default 5000. */
    intervalMs?: number;
    /** Behavior when maxAttempts is reached. Default "fail". */
    onTimeout?: "fail" | "return-last";
    /** Skip the entire component. */
    skipIf?: boolean;
    /** Prompt/condition description for the check agent. */
    children?: React.ReactNode;
};

type ParallelProps$2 = {
    id?: string;
    maxConcurrency?: number;
    skipIf?: boolean;
    children?: React.ReactNode;
};

type PanelistConfig$1 = {
    agent: AgentLike;
    role?: string;
    label?: string;
};

type PanelProps$2 = {
    id?: string;
    panelists: PanelistConfig$1[] | AgentLike[];
    moderator: AgentLike;
    panelistOutput: OutputTarget$1;
    moderatorOutput: OutputTarget$1;
    strategy?: "synthesize" | "vote" | "consensus";
    minAgree?: number;
    maxConcurrency?: number;
    skipIf?: boolean;
    children: string | React.ReactNode;
};

type OptimizerProps$2 = {
    id?: string;
    /** Agent that generates or improves candidates each iteration. */
    generator: AgentLike;
    /** Agent (or compute function) that scores candidates. */
    evaluator: AgentLike | ((candidate: unknown) => unknown | Promise<unknown>);
    /** Output schema for generated candidates. */
    generateOutput: OutputTarget$1;
    /** Output schema for evaluation results. Must include a `score: number` field. */
    evaluateOutput: OutputTarget$1;
    /** Score threshold to stop early. When omitted, runs all iterations. */
    targetScore?: number;
    /** Maximum optimization rounds. @default 10 */
    maxIterations?: number;
    /** Behavior when maxIterations is reached. @default "return-last" */
    onMaxReached?: "return-last" | "fail";
    /** Skip the entire optimization loop. */
    skipIf?: boolean;
    /** Initial generation prompt (string or ReactNode). */
    children: string | React.ReactNode;
};

/**
 * Queue tasks so that at most `maxConcurrency` run concurrently across the group.
 * Defaults to 1, providing an easy merge queue primitive.
 */
type MergeQueueProps$2 = {
    id?: string;
    maxConcurrency?: number;
    skipIf?: boolean;
    children?: React.ReactNode;
};

type ColumnTaskProps = Omit<Partial<TaskProps$2<unknown>>, "agent" | "children" | "id" | "key" | "output" | "smithersContext">;
type ColumnDef$1 = {
    name: string;
    agent: AgentLike;
    /** Output schema for tasks in this column. */
    output: OutputTarget$1;
    /** Prompt template. Receives `{ item, column }` and returns a string. */
    prompt?: (ctx: {
        item: unknown;
        column: string;
    }) => string;
    /** Optional Task props applied to each generated item task in this column. */
    task?: ColumnTaskProps;
};

type KanbanProps$2 = {
    id?: string;
    /** Column definitions in order. Items flow left to right. */
    columns: ColumnDef$1[];
    /** Function that returns ticket items to process. Each item must have an `id` field. */
    useTickets: () => Array<{
        id: string;
        [key: string]: unknown;
    }>;
    /** Record mapping column names to agents. Overrides column-level agents. */
    agents?: Record<string, AgentLike>;
    /** Max items processed in parallel per column. */
    maxConcurrency?: number;
    /** Callback output schema when an item reaches the final column. */
    onComplete?: OutputTarget$1;
    /** Whether the board loop is done. When true, the loop exits. */
    until?: boolean;
    /** Max iterations through the column pipeline. */
    maxIterations?: number;
    skipIf?: boolean;
    children?: React.ReactNode | Record<string, unknown>;
};

type HumanTaskProps$2 = {
    id: string;
    /** Where to store the human's response. */
    output: OutputTarget$1;
    /** Zod schema the human must conform to. Used for validation. */
    outputSchema?: z.ZodObject<z.ZodRawShape>;
    /** Instructions for the human (string or ReactNode). */
    prompt: string | React.ReactNode;
    /** Max validation retries before failure. */
    maxAttempts?: number;
    /** Do not block unrelated downstream flow while waiting for human input. */
    async?: boolean;
    skipIf?: boolean;
    timeoutMs?: number;
    continueOnFail?: boolean;
    /** Explicit dependency on other task node IDs. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
};

type GatherAndSynthesizeProps$2 = {
    id?: string;
    /** Record mapping source names to source definitions. */
    sources: Record<string, SourceDef$1>;
    /** Agent that synthesizes gathered data. */
    synthesizer: AgentLike;
    /** Default output schema for each source gather task. */
    gatherOutput: OutputTarget$1;
    /** Output schema for the synthesis task. */
    synthesisOutput: OutputTarget$1;
    /** Gathered results keyed by source name. Typically from ctx.outputMaybe(). */
    gatheredResults?: Record<string, unknown> | null;
    /** Max parallel gatherers. */
    maxConcurrency?: number;
    /** Prompt for the synthesis task. If omitted, a default prompt is generated. */
    synthesisPrompt?: string;
    skipIf?: boolean;
    children?: React.ReactNode;
};

type EscalationLevel$1 = {
    /** Agent to handle this escalation level. */
    agent: AgentLike;
    /** Output target for this level's result. */
    output: OutputTarget$1;
    /** Display label for this level. */
    label?: string;
    /** Predicate evaluated on the level's result. Return `true` to escalate. */
    escalateIf?: (result: unknown) => boolean;
};

type EscalationChainProps$2 = {
    /** ID prefix for generated nodes. */
    id?: string;
    /** Ordered escalation levels. Each level runs only if the previous escalated. */
    levels: EscalationLevel$1[];
    /** If `true`, the final escalation produces a human approval node. */
    humanFallback?: boolean;
    /** Approval request config used when `humanFallback` is `true`. */
    humanRequest?: ApprovalRequest$1;
    /** Output target for escalation tracking at each level. */
    escalationOutput: OutputTarget$1;
    skipIf?: boolean;
    /** Prompt / input passed to each agent level. */
    children?: React.ReactNode;
};

type DriftDetectorProps$2 = {
    /** ID prefix for generated task/component ids. */
    id?: string;
    /** Agent that captures the current state snapshot. */
    captureAgent: AgentLike;
    /** Agent that compares current state against the baseline. */
    compareAgent: AgentLike;
    /** Output schema for the captured state. */
    captureOutput: OutputTarget$1;
    /** Output schema for the comparison result. Should include `drifted: boolean` and `significance: string`. */
    compareOutput: OutputTarget$1;
    /** Static baseline data, or a function/agent that fetches it. */
    baseline: unknown;
    /** Condition function that determines whether to fire the alert. If omitted, uses the `drifted` field from comparison output. */
    alertIf?: (comparison: unknown) => boolean;
    /** Element to render when drift is detected (e.g. a Task that sends a notification). */
    alert?: React.ReactElement;
    /** If set, wraps the detector in a Loop for periodic polling. */
    poll?: {
        intervalMs: number;
        maxPolls?: number;
    };
    /** Skip the entire component. */
    skipIf?: boolean;
};

type DecisionRule$1 = {
    /** Condition evaluated at render time. */
    when: boolean;
    /** Element to render when this rule matches. */
    then: React.ReactElement;
    /** Optional display label for the rule. */
    label?: string;
};

type DecisionTableProps$2 = {
    /** ID prefix for generated wrapper nodes. */
    id?: string;
    /** Ordered list of rules. Each rule has a `when` condition and a `then` element. */
    rules: DecisionRule$1[];
    /** Fallback element rendered when no rules match. */
    default?: React.ReactElement;
    /** `"first-match"` (default): first matching rule wins. `"all-match"`: all matching rules run in parallel. */
    strategy?: "first-match" | "all-match";
    skipIf?: boolean;
};

type DebateProps$2 = {
    id?: string;
    proposer: AgentLike;
    opponent: AgentLike;
    judge: AgentLike;
    rounds?: number;
    argumentOutput: OutputTarget$1;
    verdictOutput: OutputTarget$1;
    topic: string | React.ReactNode;
    skipIf?: boolean;
};

type ContinueAsNewProps$2 = {
    /**
     * Optional JSON-serializable state carried into the new run.
     */
    state?: unknown;
};

type ContentPipelineStage$1 = {
    /** Unique identifier for this stage. */
    id: string;
    /** Agent that performs this stage's work. */
    agent: AgentLike;
    /** Output schema for this stage. */
    output: OutputTarget$1;
    /** Human-readable label for the stage (used as task label). */
    label?: string;
};

type ContentPipelineProps$2 = {
    id?: string;
    /** Pipeline stages executed in order. Each stage receives the previous stage's output. */
    stages: ContentPipelineStage$1[];
    /** Skip the entire pipeline. */
    skipIf?: boolean;
    /** Initial prompt/content for the first stage (string or ReactNode). */
    children: string | React.ReactNode;
};

type CategoryConfig$1 = {
    agent: AgentLike;
    /** Output schema for this category's route handler. Overrides `routeOutput`. */
    output?: OutputTarget$1;
    /** Optional prompt for the route handler. Receives the classified item. */
    prompt?: (item: unknown) => string;
};

type ClassifyAndRouteProps$2 = {
    id?: string;
    /** Items to classify. A single item or an array of items. */
    items: unknown | unknown[];
    /** Record mapping category names to agents or config objects. */
    categories: Record<string, AgentLike | CategoryConfig$1>;
    /** Agent that classifies items into categories. */
    classifierAgent: AgentLike;
    /** Output schema for the classification task. */
    classifierOutput: OutputTarget$1;
    /** Default output schema for routed work. Can be overridden per-category. */
    routeOutput: OutputTarget$1;
    /** Classification result used to drive routing. Typically from ctx.outputMaybe(). */
    classificationResult?: {
        classifications: Array<{
            itemId?: string;
            category: string;
            [key: string]: unknown;
        }>;
    } | null;
    /** Max parallel routes. */
    maxConcurrency?: number;
    skipIf?: boolean;
    children?: React.ReactNode;
};

type CheckConfig$1 = {
    id: string;
    agent?: AgentLike;
    command?: string;
    label?: string;
};

type CheckSuiteProps$2 = {
    id?: string;
    checks: CheckConfig$1[] | Record<string, Omit<CheckConfig$1, "id">>;
    verdictOutput: OutputTarget$1;
    strategy?: "all-pass" | "majority" | "any-pass";
    maxConcurrency?: number;
    continueOnFail?: boolean;
    skipIf?: boolean;
};

type BranchProps$2 = {
    if: boolean;
    then: React.ReactElement;
    else?: React.ReactElement | null;
    skipIf?: boolean;
};

/**
 * Token budget configuration for Aspects.
 */
type TokenBudgetConfig = {
    /** Maximum total tokens across all tasks within the Aspects scope. */
    max: number;
    /** Optional per-task token limit. */
    perTask?: number;
    /** Behavior when the budget is exceeded. Default: "fail". */
    onExceeded?: "fail" | "warn" | "skip-remaining";
};

/**
 * Latency SLO configuration for Aspects.
 */
type LatencySloConfig = {
    /** Maximum total latency in milliseconds across all tasks. */
    maxMs: number;
    /** Optional per-task latency limit in milliseconds. */
    perTask?: number;
    /** Behavior when the SLO is exceeded. Default: "fail". */
    onExceeded?: "fail" | "warn";
};

/**
 * Cost budget configuration for Aspects.
 */
type CostBudgetConfig = {
    /** Maximum total cost in USD across all tasks within the Aspects scope. */
    maxUsd: number;
    /** Behavior when the budget is exceeded. Default: "fail". */
    onExceeded?: "fail" | "warn" | "skip-remaining";
};

/**
 * Tracking configuration — which metrics to track.
 */
type TrackingConfig = {
    /** Track token usage. Default: true. */
    tokens?: boolean;
    /** Track latency. Default: true. */
    latency?: boolean;
    /** Track cost. Default: true. */
    cost?: boolean;
};

type AspectsProps$2 = {
    /** Token budget — max total tokens, optional per-task limit, and exceeded behavior. */
    tokenBudget?: TokenBudgetConfig;
    /** Latency SLO — max total latency, optional per-task limit, and exceeded behavior. */
    latencySlo?: LatencySloConfig;
    /** Cost budget — max total USD, and exceeded behavior. */
    costBudget?: CostBudgetConfig;
    /** Which metrics to track. Defaults to all enabled. */
    tracking?: TrackingConfig;
    /** Workflow content these aspects apply to. */
    children?: React.ReactNode;
};

type ApprovalMode$1 = "approve" | "select" | "rank";

type ApprovalOption$1 = {
    key: string;
    label: string;
    summary?: string;
    metadata?: Record<string, unknown>;
};

type ApprovalAutoApprove$1 = {
    after?: number;
    condition?: ((ctx: SmithersCtx$1<unknown> | null) => boolean) | (() => boolean);
    audit?: boolean;
    revertOn?: ((ctx: SmithersCtx$1<unknown> | null) => boolean) | (() => boolean);
};

type ApprovalDecision$1 = z.infer<typeof approvalDecisionSchema>;

type ApprovalProps$2<Row = ApprovalDecision$1, Output extends OutputTarget$1 = OutputTarget$1> = {
    id: string;
    mode?: ApprovalMode$1;
    options?: ApprovalOption$1[];
    /** Where to persist the approval decision. Pass a Zod schema from `outputs` (recommended), a Drizzle table, or a string key. */
    output: Output;
    outputSchema?: z.ZodObject<z.ZodRawShape>;
    request: ApprovalRequest$1;
    onDeny?: "fail" | "continue" | "skip";
    allowedScopes?: string[];
    allowedUsers?: string[];
    autoApprove?: ApprovalAutoApprove$1;
    /** Do not block unrelated downstream flow while this approval is pending. */
    async?: boolean;
    /** Explicit dependency on other task node IDs. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    skipIf?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    retries?: number;
    retryPolicy?: _smithers_scheduler_RetryPolicy.RetryPolicy;
    continueOnFail?: boolean;
    cache?: _smithers_scheduler_CachePolicy.CachePolicy;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
    children?: React.ReactNode;
    smithersContext?: React.Context<SmithersCtx$1<unknown> | null>;
};

type ApprovalRanking$1 = z.infer<typeof approvalRankingSchema>;

/**
 * @template Row
 * @param {ApprovalProps<Row>} props
 * @returns {React.ReactElement | null}
 */
declare function Approval<Row>(props: ApprovalProps$1<Row>): React.ReactElement | null;
/** @typedef {import("./ApprovalAutoApprove.ts").ApprovalAutoApprove} ApprovalAutoApprove */
/** @typedef {import("./ApprovalMode.ts").ApprovalMode} ApprovalMode */
/** @typedef {import("./ApprovalOption.ts").ApprovalOption} ApprovalOption */
/**
 * @template Row, Output
 * @typedef {import("./ApprovalProps.ts").ApprovalProps<Row, Output>} ApprovalProps
 */
declare const approvalDecisionSchema: z.ZodObject<{
    approved: z.ZodBoolean;
    note: z.ZodNullable<z.ZodString>;
    decidedBy: z.ZodNullable<z.ZodString>;
    decidedAt: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
declare const approvalSelectionSchema: z.ZodObject<{
    selected: z.ZodString;
    notes: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
declare const approvalRankingSchema: z.ZodObject<{
    ranked: z.ZodArray<z.ZodString>;
    notes: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
type ApprovalProps$1<Row, Output> = ApprovalProps$2<Row, Output>;

type ApprovalSelection$1 = z.infer<typeof approvalSelectionSchema>;

type ApprovalGateProps$2 = {
    id: string;
    /** Where to persist the approval decision. */
    output: OutputTarget$1;
    /** Human-facing approval request. */
    request: ApprovalRequest$1;
    /** When `true`, approval is required. When `false`, auto-approves. */
    when: boolean;
    /** Behavior after denial. */
    onDeny?: "fail" | "continue" | "skip";
    skipIf?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    retries?: number;
    retryPolicy?: RetryPolicy$1;
    continueOnFail?: boolean;
};

/** @typedef {import("./WorkflowProps.ts").WorkflowProps} WorkflowProps */
/**
 * @param {WorkflowProps} props
 * @returns {React.DOMElement<WorkflowProps, Element>}
 */
declare function Workflow(props: WorkflowProps$1): React.DOMElement<WorkflowProps$1, Element>;
type WorkflowProps$1 = WorkflowProps$2;

/**
 * @template Row, Output, D
 * @param {TaskProps<Row, Output, D>} props
 * @returns {React.ReactElement | null}
 */
declare function Task<Row, Output, D>(props: TaskProps$1<Row, Output, D>): React.ReactElement | null;
type TaskProps$1<Row, Output, D> = TaskProps$2<Row, Output, D>;

/** @typedef {import("./SequenceProps.ts").SequenceProps} SequenceProps */
/**
 * @param {SequenceProps} props
 */
declare function Sequence(props: SequenceProps$1): React.DOMElement<SequenceProps$2, Element> | null;
type SequenceProps$1 = SequenceProps$2;

/** @typedef {import("./ParallelProps.ts").ParallelProps} ParallelProps */
/**
 * @param {ParallelProps} props
 */
declare function Parallel(props: ParallelProps$1): React.ReactElement<{
    maxConcurrency: number | undefined;
    id: string | undefined;
}, string | React.JSXElementConstructor<any>> | null;
type ParallelProps$1 = ParallelProps$2;

/** @typedef {import("./MergeQueueProps.ts").MergeQueueProps} MergeQueueProps */
/**
 * @param {MergeQueueProps} props
 */
declare function MergeQueue(props: MergeQueueProps$1): React.ReactElement<{
    maxConcurrency: any;
    id: string | undefined;
}, string | React.JSXElementConstructor<any>> | null;
type MergeQueueProps$1 = MergeQueueProps$2;

/** @typedef {import("./BranchProps.ts").BranchProps} BranchProps */
/**
 * @param {BranchProps} props
 */
declare function Branch(props: BranchProps$1): React.ReactElement<BranchProps$2, string | React.JSXElementConstructor<any>> | null;
type BranchProps$1 = BranchProps$2;

/** @typedef {import("./WorktreeProps.ts").WorktreeProps} WorktreeProps */
/**
 * @param {WorktreeProps} props
 */
declare function Worktree(props: WorktreeProps$1): React.ReactElement<{
    id: string | undefined;
    path: string;
    branch: string | undefined;
    baseBranch: string | undefined;
}, string | React.JSXElementConstructor<any>> | null;
type WorktreeProps$1 = WorktreeProps$2;

/**
 * <Kanban> — Process items through columns with pluggable ticket source.
 *
 * Composes Loop, Sequence, Parallel, and Task to create a board where items
 * flow through columns. Each column processes items via its assigned agent.
 * Items in the same column can be processed in parallel.
 * @param {KanbanProps} props
 */
declare function Kanban(props: KanbanProps$1): React.FunctionComponentElement<SequenceProps$2> | React.FunctionComponentElement<LoopProps$2> | null;
type KanbanProps$1 = KanbanProps$2;

/**
 * <ClassifyAndRoute> — Classify items then route to category-specific agents.
 *
 * Composes Sequence, Task, and Parallel. First a classifier Task assigns items
 * to categories, then a Parallel block routes each classified item to the
 * appropriate category agent.
 * @param {ClassifyAndRouteProps} props
 */
declare function ClassifyAndRoute(props: ClassifyAndRouteProps$1): React.FunctionComponentElement<SequenceProps$2> | null;
type ClassifyAndRouteProps$1 = ClassifyAndRouteProps$2;

/**
 * <GatherAndSynthesize> — Parallel data collection from different sources,
 * then synthesis into a unified result.
 *
 * Composes Sequence, Parallel, and Task. First a Parallel block gathers data
 * from each source agent, then a synthesis Task receives all gathered data
 * and produces a combined output.
 * @param {GatherAndSynthesizeProps} props
 */
declare function GatherAndSynthesize(props: GatherAndSynthesizeProps$1): React.FunctionComponentElement<SequenceProps$2> | null;
type GatherAndSynthesizeProps$1 = GatherAndSynthesizeProps$2;

/**
 * <Panel> — Parallel specialists review the same input, then a moderator synthesizes.
 *
 * Composes: Sequence > Parallel[Task per panelist] > Task(moderator)
 * @param {PanelProps} props
 */
declare function Panel(props: PanelProps$1): React.FunctionComponentElement<SequenceProps$2> | null;
type PanelProps$1 = PanelProps$2;

/**
 * <CheckSuite> — Parallel checks with auto-aggregated pass/fail verdict.
 *
 * Composes: Sequence > Parallel[Task per check] > Task(verdict aggregator)
 * @param {CheckSuiteProps} props
 */
declare function CheckSuite(props: CheckSuiteProps$1): React.FunctionComponentElement<SequenceProps$2> | null;
type CheckSuiteProps$1 = CheckSuiteProps$2;

/**
 * <Debate> — Adversarial rounds with rebuttals, followed by a judge verdict.
 *
 * Composes: Sequence > Loop[Parallel(proposer, opponent)] > Task(judge)
 * @param {DebateProps} props
 */
declare function Debate(props: DebateProps$1): React.FunctionComponentElement<SequenceProps$2> | null;
type DebateProps$1 = DebateProps$2;

/**
 * Produce -> review -> fix -> repeat until approved.
 *
 * Composes Loop, Sequence, and Task to create a standard
 * review-loop pattern. The producer receives the reviewer's
 * feedback on subsequent iterations.
 * @param {ReviewLoopProps} props
 */
declare function ReviewLoop(props: ReviewLoopProps$1): React.FunctionComponentElement<LoopProps$2> | null;
type ReviewLoopProps$1 = ReviewLoopProps$2;

/**
 * Generate -> evaluate -> improve loop with score convergence.
 *
 * Composes Loop, Sequence, and Task to create an iterative
 * optimization pattern. Each iteration receives the previous
 * score and feedback to guide improvement.
 * @param {OptimizerProps} props
 */
declare function Optimizer(props: OptimizerProps$1): React.FunctionComponentElement<LoopProps$2> | null;
type OptimizerProps$1 = OptimizerProps$2;

/**
 * Progressive content refinement: outline -> draft -> edit -> publish.
 *
 * Composes Sequence and Task to create a typed waterfall where each
 * stage is explicitly defined. Each Task uses `needs` to depend on
 * the previous stage, passing output forward through the pipeline.
 * @param {ContentPipelineProps} props
 */
declare function ContentPipeline(props: ContentPipelineProps$1): React.FunctionComponentElement<SequenceProps$2> | null;
type ContentPipelineProps$1 = ContentPipelineProps$2;

/**
 * Conditional approval gate. Requires human approval only when `when` is true;
 * otherwise auto-approves with a static `{ approved: true }` decision.
 *
 * Composes Branch + Approval + Task internally.
 * @param {ApprovalGateProps} props
 */
declare function ApprovalGate(props: ApprovalGateProps$1): React.FunctionComponentElement<BranchProps$2> | null;
type ApprovalGateProps$1 = ApprovalGateProps$2;

/**
 * Escalation chain: tries agents in order, escalating on failure or when
 * `escalateIf` returns `true`. Optionally ends with a human approval fallback.
 *
 * Composes Sequence + Task (with `continueOnFail`) + Branch + Approval.
 * @param {EscalationChainProps} props
 */
declare function EscalationChain(props: EscalationChainProps$1): React.FunctionComponentElement<SequenceProps$2> | null;
type EscalationChainProps$1 = EscalationChainProps$2;

/**
 * Structured deterministic routing. Replaces deeply nested Branches with a
 * flat, declarative rule table.
 *
 * - `"first-match"` builds nested Branch elements so the first matching rule wins.
 * - `"all-match"` gathers all matching rules' `then` elements into a Parallel.
 *
 * Composes Branch and Parallel internally.
 * @param {DecisionTableProps} props
 */
declare function DecisionTable(props: DecisionTableProps$1): React.ReactElement<unknown, string | React.JSXElementConstructor<any>> | React.FunctionComponentElement<ParallelProps$2> | null;
type DecisionTableProps$1 = DecisionTableProps$2;

/** @typedef {import("./DriftDetectorProps.ts").DriftDetectorProps} DriftDetectorProps */
/**
 * @param {DriftDetectorProps} props
 */
declare function DriftDetector(props: DriftDetectorProps$1): React.FunctionComponentElement<SequenceProps$2> | React.FunctionComponentElement<LoopProps$2> | null;
type DriftDetectorProps$1 = DriftDetectorProps$2;

/** @typedef {import("./ScanFixVerifyProps.ts").ScanFixVerifyProps} ScanFixVerifyProps */
/**
 * @param {ScanFixVerifyProps} props
 */
declare function ScanFixVerify(props: ScanFixVerifyProps$1): React.FunctionComponentElement<SequenceProps$2> | null;
type ScanFixVerifyProps$1 = ScanFixVerifyProps$2;

/**
 * @param {PollerProps} props
 */
declare function Poller(props: PollerProps$1): React.FunctionComponentElement<LoopProps$2> | null;
type PollerProps$1 = PollerProps$2;

/**
 * <Supervisor> — Boss plans, delegates to parallel workers, reviews, re-delegates failures.
 *
 * Composes: Sequence → [plan Task, Loop(until allDone) [Parallel worker Tasks, review Task], final Task]
 * @param {SupervisorProps} props
 */
declare function Supervisor(props: SupervisorProps$1): React.FunctionComponentElement<SequenceProps$2> | null;
type SupervisorProps$1 = SupervisorProps$2;

/**
 * <Runbook> — Sequential steps with risk classification.
 *
 * Safe steps auto-execute. Risky and critical steps require human approval first.
 * Composes: Sequence of [Approval? → Task] per step, chained via `needs`.
 * @param {RunbookProps} props
 */
declare function Runbook(props: RunbookProps$1): React.FunctionComponentElement<SequenceProps$2> | null;
type RunbookProps$1 = RunbookProps$2;

/** @typedef {import("./SubflowProps.ts").SubflowProps} SubflowProps */
/**
 * @param {SubflowProps} props
 */
declare function Subflow(props: SubflowProps$1): React.ReactElement<{
    id: string;
    key: string | undefined;
    workflow: _smithers_driver.WorkflowDefinition<unknown>;
    input: unknown;
    mode: "childRun" | "inline";
    output: OutputTarget$1;
    timeoutMs: number | undefined;
    heartbeatTimeoutMs: number | undefined;
    heartbeatTimeout: number | undefined;
    retries: number | undefined;
    retryPolicy: {
        backoff?: "fixed" | "linear" | "exponential";
        initialDelayMs?: number;
    } | undefined;
    continueOnFail: boolean | undefined;
    cache: _smithers_scheduler.CachePolicy | undefined;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    label: string;
    meta: Record<string, unknown> | undefined;
    __smithersSubflowWorkflow: _smithers_driver.WorkflowDefinition<unknown>;
    __smithersSubflowInput: unknown;
    __smithersSubflowMode: "childRun" | "inline";
}, string | React.JSXElementConstructor<any>> | null;
type SubflowProps$1 = SubflowProps$2;

/** @typedef {import("./SandboxProps.ts").SandboxProps} SandboxProps */
/**
 * @param {SandboxProps} props
 */
declare function Sandbox(props: SandboxProps$1): React.ReactElement<{
    id: string;
    key: string | undefined;
    output: OutputTarget$1;
    runtime: SandboxRuntime$1;
    allowNetwork: boolean | undefined;
    reviewDiffs: boolean | undefined;
    autoAcceptDiffs: boolean | undefined;
    image: string | undefined;
    env: Record<string, string> | undefined;
    ports: {
        host: number;
        container: number;
    }[] | undefined;
    volumes: SandboxVolumeMount$1[] | undefined;
    memoryLimit: string | undefined;
    cpuLimit: string | undefined;
    command: string | undefined;
    workspace: SandboxWorkspaceSpec$1 | undefined;
    timeoutMs: number | undefined;
    heartbeatTimeoutMs: number | undefined;
    heartbeatTimeout: number | undefined;
    retries: number | undefined;
    retryPolicy: {
        backoff?: "fixed" | "linear" | "exponential";
        initialDelayMs?: number;
    } | undefined;
    continueOnFail: boolean | undefined;
    cache: _smithers_scheduler.CachePolicy | undefined;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    label: string;
    meta: Record<string, unknown> | undefined;
    __smithersSandboxWorkflow: _smithers_driver.WorkflowDefinition<unknown> | undefined;
    __smithersSandboxInput: unknown;
    __smithersSandboxRuntime: SandboxRuntime$1;
    __smithersSandboxChildren: React.ReactNode;
}, string | React.JSXElementConstructor<any>> | null;
type SandboxProps$1 = SandboxProps$2;

/** @typedef {import("./WaitForEventProps.ts").WaitForEventProps} WaitForEventProps */
/**
 * @param {WaitForEventProps} props
 */
declare function WaitForEvent(props: WaitForEventProps$1): React.ReactElement<{
    id: string;
    key: string | undefined;
    event: string;
    correlationId: string | undefined;
    output: OutputTarget$1;
    outputSchema: zod.ZodObject<Readonly<{
        [k: string]: zod_v4_core.$ZodType<unknown, unknown, zod_v4_core.$ZodTypeInternals<unknown, unknown>>;
    }>, zod_v4_core.$strip> | undefined;
    timeoutMs: number | undefined;
    onTimeout: "fail" | "continue" | "skip";
    waitAsync: boolean;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    label: string;
    meta: {
        onTimeout?: "fail" | "continue" | "skip" | undefined;
        correlationId?: string | undefined;
        event: string;
    } | undefined;
    __smithersEventName: string;
    __smithersCorrelationId: string | undefined;
    __smithersOnTimeout: "fail" | "continue" | "skip";
}, string | React.JSXElementConstructor<any>> | null;
type WaitForEventProps$1 = WaitForEventProps$2;

/**
 * @template Schema
 * @typedef {import("./SignalProps.ts").SignalProps<Schema>} SignalProps
 */
/**
 * @template Schema
 * @param {SignalProps<Schema>} props
 */
declare function Signal<Schema>(props: SignalProps$1<Schema>): React.DetailedReactHTMLElement<React.InputHTMLAttributes<HTMLInputElement>, HTMLInputElement> | React.FunctionComponentElement<React.FragmentProps> | null;
type SignalProps$1<Schema> = SignalProps$2<Schema>;

/** @typedef {import("./TimerProps.ts").TimerProps} TimerProps */
/**
 * @param {TimerProps} props
 */
declare function Timer(props: TimerProps$1): React.ReactElement<{
    id: string;
    key: string | undefined;
    duration: string | undefined;
    until: string | undefined;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    label: string;
    meta: {
        until?: string | undefined;
        duration?: string | undefined;
        timer: boolean;
    } | undefined;
    __smithersTimerDuration: string | undefined;
    __smithersTimerUntil: string | undefined;
}, string | React.JSXElementConstructor<any>> | null;
type TimerProps$1 = TimerProps$2;

/**
 * @param {HumanTaskProps} props
 * @returns {React.ReactElement | null}
 */
declare function HumanTask(props: HumanTaskProps$1): React.ReactElement | null;
type HumanTaskProps$1 = HumanTaskProps$2;

/**
 * Forward steps with registered compensations executed in reverse on failure/cancel.
 *
 * Use the `steps` prop for an array-driven API, or nest `<Saga.Step>` children
 * for a declarative JSX style.
 *
 * Renders to `<smithers:saga>`.
 * @param {SagaProps} props
 */
declare function Saga(props: SagaProps$1): React.ReactElement<{
    id: string | undefined;
    onFailure: "fail" | "compensate" | "compensate-and-fail";
    __sagaSteps: {
        id: any;
        label: any;
    }[];
    skipIf?: boolean;
}, string | React.JSXElementConstructor<any>> | null;
declare namespace Saga {
    export { SagaStep as Step };
}
type SagaStepProps$1 = SagaStepProps$2;
type SagaProps$1 = SagaProps$2;
/** @typedef {import("./SagaStepProps.ts").SagaStepProps} SagaStepProps */
/**
 * @param {SagaStepProps} _props
 * @returns {React.ReactElement | null}
 */
declare function SagaStep(_props: SagaStepProps$1): React.ReactElement | null;
declare namespace SagaStep {
    let __isSagaStep: boolean;
}

/**
 * Workflow-scoped error boundary. Catch specific error types, run recovery
 * handlers, and ensure cleanup always runs.
 *
 * - The `try` block is the main workflow content.
 * - If any task in `try` fails with a matching error, the `catch` block mounts.
 * - The `finally` block always runs after try (success) or catch (failure).
 *
 * Renders to `<smithers:try-catch-finally>`.
 * @param {TryCatchFinallyProps} props
 */
declare function TryCatchFinally(props: TryCatchFinallyProps$1): React.ReactElement<{
    id: string | undefined;
    __tcfCatchErrors: ("INVALID_INPUT" | "MISSING_INPUT" | "MISSING_INPUT_TABLE" | "RESUME_METADATA_MISMATCH" | "UNKNOWN_OUTPUT_SCHEMA" | "INVALID_OUTPUT" | "WORKTREE_CREATE_FAILED" | "VCS_NOT_FOUND" | "SNAPSHOT_NOT_FOUND" | "VCS_WORKSPACE_CREATE_FAILED" | "TASK_TIMEOUT" | "RUN_NOT_FOUND" | "NODE_NOT_FOUND" | "INVALID_EVENTS_OPTIONS" | "SANDBOX_BUNDLE_INVALID" | "SANDBOX_BUNDLE_TOO_LARGE" | "WORKFLOW_EXECUTION_FAILED" | "SANDBOX_EXECUTION_FAILED" | "TASK_HEARTBEAT_TIMEOUT" | "HEARTBEAT_PAYLOAD_TOO_LARGE" | "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE" | "TASK_ABORTED" | "RUN_CANCELLED" | "RUN_NOT_RESUMABLE" | "RUN_OWNER_ALIVE" | "RUN_STILL_RUNNING" | "RUN_RESUME_CLAIM_LOST" | "RUN_RESUME_CLAIM_FAILED" | "RUN_RESUME_ACTIVATION_FAILED" | "RUN_HIJACKED" | "CONTINUATION_STATE_TOO_LARGE" | "INVALID_CONTINUATION_STATE" | "RALPH_MAX_REACHED" | "SCHEDULER_ERROR" | "SESSION_ERROR" | "TASK_ID_REQUIRED" | "TASK_MISSING_OUTPUT" | "DUPLICATE_ID" | "NESTED_LOOP" | "WORKTREE_EMPTY_PATH" | "MDX_PRELOAD_INACTIVE" | "CONTEXT_OUTSIDE_WORKFLOW" | "MISSING_OUTPUT" | "DEP_NOT_SATISFIED" | "ASPECT_BUDGET_EXCEEDED" | "APPROVAL_OUTSIDE_TASK" | "APPROVAL_OPTIONS_REQUIRED" | "WORKFLOW_MISSING_DEFAULT" | "TOOL_PATH_INVALID" | "TOOL_PATH_ESCAPE" | "TOOL_FILE_TOO_LARGE" | "TOOL_CONTENT_TOO_LARGE" | "TOOL_PATCH_TOO_LARGE" | "TOOL_PATCH_FAILED" | "TOOL_NETWORK_DISABLED" | "TOOL_GIT_REMOTE_DISABLED" | "TOOL_COMMAND_FAILED" | "TOOL_GREP_FAILED" | "AGENT_CLI_ERROR" | "AGENT_RPC_FILE_ARGS" | "AGENT_BUILD_COMMAND" | "AGENT_DIAGNOSTIC_TIMEOUT" | "DB_MISSING_COLUMNS" | "DB_REQUIRES_BUN_SQLITE" | "DB_QUERY_FAILED" | "DB_WRITE_FAILED" | "STORAGE_ERROR" | "INTERNAL_ERROR" | "PROCESS_ABORTED" | "PROCESS_TIMEOUT" | "PROCESS_IDLE_TIMEOUT" | "PROCESS_SPAWN_FAILED" | "TASK_RUNTIME_UNAVAILABLE" | "SCHEMA_CHANGE_HOT" | "HOT_OVERLAY_FAILED" | "HOT_RELOAD_INVALID_MODULE" | "SCORER_FAILED" | "WORKFLOW_EXISTS" | "CLI_DB_NOT_FOUND" | "CLI_AGENT_UNSUPPORTED" | "PI_HTTP_ERROR" | "EXTERNAL_BUILD_FAILED" | "SCHEMA_DISCOVERY_FAILED" | "OPENAPI_SPEC_LOAD_FAILED" | "OPENAPI_OPERATION_NOT_FOUND" | "OPENAPI_TOOL_EXECUTION_FAILED" | (string & {}))[] | undefined;
    __tcfCatchHandler: React.ReactElement<unknown, string | React.JSXElementConstructor<any>> | ((error: _smithers_errors.SmithersError) => React.ReactElement) | undefined;
    __tcfFinallyHandler: React.ReactElement<unknown, string | React.JSXElementConstructor<any>> | undefined;
}, string | React.JSXElementConstructor<any>> | null;
type TryCatchFinallyProps$1 = TryCatchFinallyProps$2;

/**
 * Runtime accumulator for tracked metrics within an Aspects scope.
 */
type AspectAccumulator = {
    totalTokens: number;
    totalLatencyMs: number;
    totalCostUsd: number;
    taskCount: number;
};

/**
 * The value provided by AspectContext to descendant components.
 */
type AspectContextValue = {
    tokenBudget?: TokenBudgetConfig;
    latencySlo?: LatencySloConfig;
    costBudget?: CostBudgetConfig;
    tracking: TrackingConfig;
    accumulator: AspectAccumulator;
};

/**
 * Aspects — declarative cross-cutting concerns for workflow scopes.
 *
 * Wraps a section of the workflow tree and propagates token budgets,
 * latency SLOs, and cost budgets to all descendant Task components
 * without modifying individual tasks.
 *
 * ```tsx
 * <Aspects tokenBudget={{ max: 100_000, perTask: 20_000, onExceeded: "warn" }}>
 *   <Task id="step1" ...>...</Task>
 *   <Task id="step2" ...>...</Task>
 * </Aspects>
 * ```
 * @param {AspectsProps} props
 */
declare function Aspects(props: AspectsProps$1): React.FunctionComponentElement<React.ProviderProps<AspectContextValue | null>>;
type AspectsProps$1 = AspectsProps$2;

/**
 * SuperSmithers — a workflow wrapper that reads and modifies source code
 * to intervene via hot reload. Takes a markdown strategy doc and an agent
 * that decides what to change.
 *
 * Only meaningful in hot-reload mode: the agent reads source files, proposes
 * modifications, and (unless `dryRun` is set) writes them to disk, triggering
 * the hot reload system to pick up the changes.
 *
 * Internally expands to a sequence of tasks:
 * 1. Agent reads the strategy doc and target files
 * 2. Agent proposes modifications
 * 3. (If not dryRun) Compute task writes modifications to disk
 * 4. Agent generates a report of what changed
 *
 * ```tsx
 * <SuperSmithers
 *   id="refactor"
 *   strategy={strategyMd}
 *   agent={codeAgent}
 *   targetFiles={["src/**\/*.ts"]}
 *   reportOutput={outputs.report}
 * />
 * ```
 * @param {SuperSmithersProps} props
 */
declare function SuperSmithers(props: SuperSmithersProps$1): React.ReactElement<{
    id: string;
}, string | React.JSXElementConstructor<any>> | null;
type SuperSmithersProps$1 = SuperSmithersProps$2;

/** @typedef {import("./LoopProps.ts").LoopProps} LoopProps */
/**
 * @param {LoopProps} props
 */
declare function Loop(props: LoopProps$1): React.DOMElement<LoopProps$2, Element> | null;
/** @typedef {import("./LoopProps.ts").LoopProps} LoopProps */
/**
 * @param {LoopProps} props
 */
declare function Ralph(props: LoopProps$1): React.DOMElement<LoopProps$2, Element> | null;
type LoopProps$1 = LoopProps$2;

/**
 * @param {ContinueAsNewProps} props
 */
declare function ContinueAsNew(props: ContinueAsNewProps$1): React.ReactElement<{
    stateJson: string | undefined;
}, string | React.JSXElementConstructor<any>>;
/**
 * Convenience helper for conditional continuation inside workflow JSX:
 * `{shouldContinue ? continueAsNew({ cursor }) : null}`
 */
declare function continueAsNew(state: any): React.FunctionComponentElement<ContinueAsNewProps$2>;
type ContinueAsNewProps$1 = ContinueAsNewProps$2;

type ApprovalAutoApprove = ApprovalAutoApprove$1;
type ApprovalDecision = ApprovalDecision$1;
type ApprovalGateProps = ApprovalGateProps$2;
type ApprovalMode = ApprovalMode$1;
type ApprovalOption = ApprovalOption$1;
type ApprovalProps<Row, Output> = ApprovalProps$2<Row, Output>;
type ApprovalRanking = ApprovalRanking$1;
type ApprovalRequest = ApprovalRequest$1;
type ApprovalSelection = ApprovalSelection$1;
type AspectsProps = AspectsProps$2;
type BranchProps = BranchProps$2;
type CategoryConfig = CategoryConfig$1;
type CheckConfig = CheckConfig$1;
type CheckSuiteProps = CheckSuiteProps$2;
type ClassifyAndRouteProps = ClassifyAndRouteProps$2;
type ColumnDef = ColumnDef$1;
type ContentPipelineProps = ContentPipelineProps$2;
type ContentPipelineStage = ContentPipelineStage$1;
type ContinueAsNewProps = ContinueAsNewProps$2;
type DebateProps = DebateProps$2;
type DecisionRule = DecisionRule$1;
type DecisionTableProps = DecisionTableProps$2;
type DepsSpec = DepsSpec$1;
type DriftDetectorProps = DriftDetectorProps$2;
type EscalationChainProps = EscalationChainProps$2;
type EscalationLevel = EscalationLevel$1;
type GatherAndSynthesizeProps = GatherAndSynthesizeProps$2;
type HumanTaskProps = HumanTaskProps$2;
type InferDeps<D> = InferDeps$1<D>;
type KanbanProps = KanbanProps$2;
type LoopProps = LoopProps$2;
type MergeQueueProps = MergeQueueProps$2;
type OptimizerProps = OptimizerProps$2;
type OutputTarget = OutputTarget$1;
type PanelistConfig = PanelistConfig$1;
type PanelProps = PanelProps$2;
type ParallelProps = ParallelProps$2;
type PollerProps = PollerProps$2;
type RalphProps = RalphProps$1;
type ReviewLoopProps = ReviewLoopProps$2;
type RunbookProps = RunbookProps$2;
type RunbookStep = RunbookStep$1;
type SagaProps = SagaProps$2;
type SagaStepDef = SagaStepDef$1;
type SagaStepProps = SagaStepProps$2;
type SandboxProps = SandboxProps$2;
type SandboxRuntime = SandboxRuntime$1;
type SandboxVolumeMount = SandboxVolumeMount$1;
type SandboxWorkspaceSpec = SandboxWorkspaceSpec$1;
type ScanFixVerifyProps = ScanFixVerifyProps$2;
type ScorersMap = _smithers_scorers_types.ScorersMap;
type SequenceProps = SequenceProps$2;
type SignalProps<Schema> = SignalProps$2<Schema>;
type SourceDef = SourceDef$1;
type SubflowProps = SubflowProps$2;
type SuperSmithersProps = SuperSmithersProps$2;
type SupervisorProps = SupervisorProps$2;
type TaskProps<Row, Output, D> = TaskProps$2<Row, Output, D>;
type TimerProps = TimerProps$2;
type TryCatchFinallyProps = TryCatchFinallyProps$2;
type WaitForEventProps = WaitForEventProps$2;
type WorkflowProps = WorkflowProps$2;
type WorktreeProps = WorktreeProps$2;

/** @type {Record<string, React.FC<any>>} */
declare const markdownComponents: Record<string, React.FC<any>>;

/** @typedef {import("mdx/types").MDXContent} MDXContent */
/**
 * Render an MDX component to plain markdown text.
 *
 * Injects `markdownComponents` so headings, paragraphs, code blocks, etc.
 * render as markdown-formatted text instead of HTML tags.
 *
 * @param {MDXContent} Component
 * @param {Record<string, any>} [props]
 * @returns {string}
 */
declare function renderMdx(Component: MDXContent, props?: Record<string, any>): string;
type MDXContent = any;

/** @typedef {import("zod").ZodObject<import("zod").ZodRawShape>} ZodObject */
/** @typedef {import("zod").ZodTypeAny} ZodTypeAny */
/**
 * @param {ZodObject} schema
 * @returns {string}
 */
declare function zodSchemaToJsonExample(schema: ZodObject): string;
type ZodObject = zod.ZodObject<zod.ZodRawShape>;

type CachePolicy<Ctx> = _smithers_scheduler_CachePolicy.CachePolicy<Ctx>;
type EngineDecision = _smithers_scheduler.EngineDecision;
type ExtractOptions = _smithers_graph.ExtractOptions;
type HostElement = _smithers_graph.HostElement;
type HostNode = _smithers_graph.HostNode;
type HostText = _smithers_graph.HostText;
type InferOutputEntry<T> = _smithers_driver_OutputAccessor.InferOutputEntry<T>;
type InferRow<TTable> = _smithers_driver_OutputAccessor.InferRow<TTable>;
type OutputAccessor<Schema> = _smithers_driver_OutputAccessor.OutputAccessor<Schema>;
type OutputKey = _smithers_driver_OutputKey.OutputKey;
type RenderContext = _smithers_scheduler.RenderContext;
type RetryPolicy = _smithers_scheduler_RetryPolicy.RetryPolicy;
type RunAuthContext = _smithers_driver_RunAuthContext.RunAuthContext;
type RunOptions = _smithers_driver.RunOptions;
type RunResult = _smithers_driver.RunResult;
type SchemaRegistryEntry = _smithers_db_SchemaRegistryEntry.SchemaRegistryEntry;
type SmithersAlertLabels = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertLabels;
type SmithersAlertPolicy = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertPolicy;
type SmithersAlertPolicyDefaults = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertPolicyDefaults;
type SmithersAlertPolicyRule = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertPolicyRule;
type SmithersAlertReaction = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertReaction;
type SmithersAlertReactionKind = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertReactionKind;
type SmithersAlertReactionRef = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertReactionRef;
type SmithersAlertSeverity = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertSeverity;
type SmithersCtx = _smithers_driver.SmithersCtx;
type SmithersErrorCode = _smithers_errors_SmithersErrorCode.SmithersErrorCode;
type SmithersWorkflow<Schema> = _smithers_driver_WorkflowDefinition.WorkflowDefinition<Schema>;
type SmithersWorkflowDriverOptions<Schema> = _smithers_driver_WorkflowDriverOptions.WorkflowDriverOptions<Schema>;
type SmithersWorkflowOptions = _smithers_scheduler.SmithersWorkflowOptions;
type TaskDescriptor = _smithers_graph.TaskDescriptor;
type WaitReason = _smithers_scheduler.WaitReason;
type WorkflowGraph = _smithers_graph.WorkflowGraph;
type WorkflowRuntime = _smithers_driver_workflow_types.WorkflowRuntime;
type WorkflowSession = _smithers_driver_workflow_types.WorkflowSession;
type XmlElement = _smithers_graph.XmlElement;
type XmlNode = _smithers_graph.XmlNode;
type XmlText = _smithers_graph.XmlText;

export { Approval, type ApprovalAutoApprove, type ApprovalDecision, ApprovalGate, type ApprovalGateProps, type ApprovalMode, type ApprovalOption, type ApprovalProps, type ApprovalRanking, type ApprovalRequest, type ApprovalSelection, Aspects, type AspectsProps, Branch, type BranchProps, type CachePolicy, type CategoryConfig, type CheckConfig, CheckSuite, type CheckSuiteProps, ClassifyAndRoute, type ClassifyAndRouteProps, type ColumnDef, ContentPipeline, type ContentPipelineProps, type ContentPipelineStage, ContinueAsNew, type ContinueAsNewProps, Debate, type DebateProps, type DecisionRule, DecisionTable, type DecisionTableProps, type DepsSpec, DriftDetector, type DriftDetectorProps, type EngineDecision, EscalationChain, type EscalationChainProps, type EscalationLevel, type ExtractOptions, GatherAndSynthesize, type GatherAndSynthesizeProps, type HostElement, type HostNode, type HostText, HumanTask, type HumanTaskProps, type InferDeps, type InferOutputEntry, type InferRow, Kanban, type KanbanProps, Loop, type LoopProps, MergeQueue, type MergeQueueProps, Optimizer, type OptimizerProps, type OutputAccessor, type OutputKey, type OutputTarget, Panel, type PanelProps, type PanelistConfig, Parallel, type ParallelProps, Poller, type PollerProps, Ralph, type RalphProps, type RenderContext, type RetryPolicy, ReviewLoop, type ReviewLoopProps, type RunAuthContext, type RunOptions, type RunResult, Runbook, type RunbookProps, type RunbookStep, Saga, type SagaProps, type SagaStepDef, type SagaStepProps, Sandbox, type SandboxProps, type SandboxRuntime, type SandboxVolumeMount, type SandboxWorkspaceSpec, ScanFixVerify, type ScanFixVerifyProps, type SchemaRegistryEntry, type ScorersMap, Sequence, type SequenceProps, Signal, type SignalProps, type SmithersAlertLabels, type SmithersAlertPolicy, type SmithersAlertPolicyDefaults, type SmithersAlertPolicyRule, type SmithersAlertReaction, type SmithersAlertReactionKind, type SmithersAlertReactionRef, type SmithersAlertSeverity, type SmithersCtx, type SmithersErrorCode, type SmithersWorkflow, type SmithersWorkflowDriverOptions, type SmithersWorkflowOptions, type SourceDef, Subflow, type SubflowProps, SuperSmithers, type SuperSmithersProps, Supervisor, type SupervisorProps, Task, type TaskDescriptor, type TaskProps, Timer, type TimerProps, TryCatchFinally, type TryCatchFinallyProps, WaitForEvent, type WaitForEventProps, type WaitReason, Workflow, type WorkflowGraph, type WorkflowProps, type WorkflowRuntime, type WorkflowSession, Worktree, type WorktreeProps, type XmlElement, type XmlNode, type XmlText, approvalDecisionSchema, approvalRankingSchema, approvalSelectionSchema, continueAsNew, markdownComponents, renderMdx, zodSchemaToJsonExample };
