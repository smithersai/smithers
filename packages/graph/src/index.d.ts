import { z } from 'zod';
import { AgentCapabilityRegistry } from '@smithers/agents/capability-registry';

type XmlNode$1 = XmlElement$1 | XmlText$1;
type XmlElement$1 = {
    readonly kind: "element";
    readonly tag: string;
    readonly props: Record<string, string>;
    readonly children: readonly XmlNode$1[];
};
type XmlText$1 = {
    readonly kind: "text";
    readonly text: string;
};
type HostNode$2 = HostElement$1 | HostText$1;
type HostElement$1 = {
    readonly kind: "element";
    readonly tag: string;
    readonly props: Record<string, string>;
    readonly rawProps: Record<string, unknown>;
    readonly children: readonly HostNode$2[];
};
type HostText$1 = {
    readonly kind: "text";
    readonly text: string;
};
type RetryPolicy$1 = {
    backoff?: "fixed" | "linear" | "exponential";
    initialDelayMs?: number;
    maxDelayMs?: number;
    multiplier?: number;
    jitter?: boolean;
};
type CachePolicy$1<Ctx = any> = {
    by?: (ctx: Ctx) => unknown;
    version?: string;
    key?: string;
    ttlMs?: number;
    scope?: "run" | "workflow" | "global";
    [key: string]: unknown;
};
type AgentLike$1 = {
    id?: string;
    tools?: Record<string, any>;
    capabilities?: AgentCapabilityRegistry;
    generate: (args: any) => Promise<any>;
};
type ScoreResult$1 = {
    score: number;
    reason?: string;
    meta?: Record<string, unknown>;
};
type ScorerInput$1 = {
    input: unknown;
    output: unknown;
    groundTruth?: unknown;
    context?: unknown;
    latencyMs?: number;
    outputSchema?: z.ZodObject<any>;
};
type ScorerFn$1 = (input: ScorerInput$1) => Promise<ScoreResult$1>;
type Scorer$1 = {
    id: string;
    name: string;
    description: string;
    score: ScorerFn$1;
};
type SamplingConfig$1 = {
    type: "all";
} | {
    type: "ratio";
    rate: number;
} | {
    type: "none";
};
type ScorerBinding$1 = {
    scorer: Scorer$1;
    sampling?: SamplingConfig$1;
};
type ScorersMap$1 = Record<string, unknown>;
type MemoryNamespaceKind$1 = "workflow" | "agent" | "user" | "global";
type MemoryNamespace$1 = {
    kind: MemoryNamespaceKind$1;
    id: string;
};
type TaskMemoryConfig$1 = {
    recall?: {
        namespace?: MemoryNamespace$1;
        query?: string;
        topK?: number;
    };
    remember?: {
        namespace?: MemoryNamespace$1;
        key?: string;
    };
    threadId?: string;
};
type ApprovalOption$1 = {
    key: string;
    label: string;
    summary?: string;
    metadata?: Record<string, unknown>;
};
type TaskDescriptor$1 = {
    nodeId: string;
    ordinal: number;
    iteration: number;
    ralphId?: string;
    dependsOn?: string[];
    needs?: Record<string, string>;
    worktreeId?: string;
    worktreePath?: string;
    worktreeBranch?: string;
    worktreeBaseBranch?: string;
    outputTable: unknown | null;
    outputTableName: string;
    outputRef?: z.ZodObject<any>;
    outputSchema?: z.ZodObject<any>;
    parallelGroupId?: string;
    parallelMaxConcurrency?: number;
    needsApproval: boolean;
    waitAsync?: boolean;
    approvalMode?: "gate" | "decision" | "select" | "rank";
    approvalOnDeny?: "fail" | "continue" | "skip";
    approvalOptions?: ApprovalOption$1[];
    approvalAllowedScopes?: string[];
    approvalAllowedUsers?: string[];
    approvalAutoApprove?: {
        after?: number;
        audit?: boolean;
        conditionMet?: boolean;
        revertOnMet?: boolean;
    };
    skipIf: boolean;
    retries: number;
    retryPolicy?: RetryPolicy$1;
    timeoutMs: number | null;
    heartbeatTimeoutMs: number | null;
    continueOnFail: boolean;
    cachePolicy?: CachePolicy$1;
    agent?: AgentLike$1 | AgentLike$1[];
    prompt?: string;
    staticPayload?: unknown;
    computeFn?: () => unknown | Promise<unknown>;
    label?: string;
    meta?: Record<string, unknown>;
    scorers?: ScorersMap$1;
    memoryConfig?: TaskMemoryConfig$1;
};
type WorkflowGraph$2 = {
    readonly xml: XmlNode$1 | null;
    readonly tasks: readonly TaskDescriptor$1[];
    readonly mountedTaskIds: readonly string[];
};
type ExtractOptions$2 = {
    readonly ralphIterations?: ReadonlyMap<string, number> | Record<string, number>;
    readonly defaultIteration?: number;
    readonly baseRootDir?: string;
    readonly workflowPath?: string | null;
};
type ExtractGraph$1 = (root: HostNode$2 | null, opts?: ExtractOptions$2) => WorkflowGraph$2 | Promise<WorkflowGraph$2>;

type GraphSnapshot$1 = {
    runId: string;
    frameNo: number;
    xml: XmlNode$1 | null;
    tasks: TaskDescriptor$1[];
};

/**
 * @param {HostNode | null} root
 * @param {ExtractOptions} [opts]
 * @returns {WorkflowGraph}
 */
declare function extractGraph(root: HostNode$1 | null, opts?: ExtractOptions$1): WorkflowGraph$1;
/**
 * @param {HostNode | null} root
 * @param {ExtractOptions} [opts]
 * @returns {WorkflowGraph}
 */
declare function extractFromHost(root: HostNode$1 | null, opts?: ExtractOptions$1): WorkflowGraph$1;
type ExtractOptions$1 = ExtractOptions$2;
type HostNode$1 = HostNode$2;
type WorkflowGraph$1 = WorkflowGraph$2;

type AgentLike = AgentLike$1;
type ApprovalOption = ApprovalOption$1;
type CachePolicy<Ctx = any> = CachePolicy$1<Ctx>;
type ExtractGraph = ExtractGraph$1;
type ExtractOptions = ExtractOptions$2;
type GraphSnapshot = GraphSnapshot$1;
type HostElement = HostElement$1;
type HostNode = HostNode$2;
type HostText = HostText$1;
type MemoryNamespace = MemoryNamespace$1;
type MemoryNamespaceKind = MemoryNamespaceKind$1;
type RetryPolicy = RetryPolicy$1;
type SamplingConfig = SamplingConfig$1;
type ScoreResult = ScoreResult$1;
type Scorer = Scorer$1;
type ScorerBinding = ScorerBinding$1;
type ScorerFn = ScorerFn$1;
type ScorerInput = ScorerInput$1;
type ScorersMap = ScorersMap$1;
type TaskDescriptor = TaskDescriptor$1;
type TaskMemoryConfig = TaskMemoryConfig$1;
type WorkflowGraph = WorkflowGraph$2;
type XmlElement = XmlElement$1;
type XmlNode = XmlNode$1;
type XmlText = XmlText$1;

export { type AgentLike, type ApprovalOption, type CachePolicy, type ExtractGraph, type ExtractOptions, type GraphSnapshot, type HostElement, type HostNode, type HostText, type MemoryNamespace, type MemoryNamespaceKind, type RetryPolicy, type SamplingConfig, type ScoreResult, type Scorer, type ScorerBinding, type ScorerFn, type ScorerInput, type ScorersMap, type TaskDescriptor, type TaskMemoryConfig, type WorkflowGraph, type XmlElement, type XmlNode, type XmlText, extractFromHost, extractGraph };
